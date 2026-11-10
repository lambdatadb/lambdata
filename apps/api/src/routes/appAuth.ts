import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import type { AppAuthSession, AppAuthUser } from "@lambdata/shared";
import { audit, appAuthUsers } from "../db/queries";
import { checkPassword, hashPassword } from "../auth/password";
import {
  SIGNUP_DISABLED_MESSAGE,
  appAuthSettings,
  recordRefusedSignup,
  signAppAuthJwt,
  updateAppAuthSettings,
} from "../auth/appJwt";
import { appUserFromBearer, publicAppUser } from "../auth/appBearer";
import { requireAuth, requireRole, type AuthVariables } from "../auth/middleware";
import { revokeAppSessions } from "../auth/tokenVersions";
import { disconnectAppUser } from "../realtime/hub";
import { bodyEmail, clientIp, rateLimit } from "../util/rateLimit";
import { newId } from "../util/id";
import { parseJson } from "../util/validate";

export const appAuthRoute = new Hono<{ Variables: AuthVariables }>();

const PASSWORD_MESSAGE = "password must be at least 8 characters";

const emailSchema = z
  .string({ error: "valid email required" })
  .trim()
  .toLowerCase()
  .regex(/^[^\s@]+@[^\s@]+\.[^\s@]+$/, "valid email required");
const passwordSchema = z.string({ error: "password required" }).min(8, PASSWORD_MESSAGE);
const displayNameSchema = z.string().max(200, "display name is too long").nullable().optional();
const statusSchema = z.enum(["active", "disabled"], { error: "invalid status" });

const signupSchema = z.object({
  email: emailSchema,
  password: passwordSchema,
  displayName: displayNameSchema,
});

const tokenSchema = z.object({
  email: emailSchema,
  password: z.string({ error: "password required" }).min(1, "password required"),
});

const settingsSchema = z.object({
  allowSignup: z.boolean().optional(),
  tokenTtlSeconds: z.number().finite().optional(),
});

const createUserSchema = z.object({
  email: emailSchema,
  password: passwordSchema,
  displayName: displayNameSchema,
  emailConfirmed: z.boolean().optional(),
  status: statusSchema.optional(),
});

const updateUserSchema = z.object({
  displayName: displayNameSchema,
  password: passwordSchema.optional(),
  emailConfirmed: z.boolean().optional(),
  status: statusSchema.optional(),
});

const tokenIpLimit = rateLimit({ windowMs: 60_000, max: 10, key: (c) => `ip:${clientIp(c)}` });
const tokenEmailLimit = rateLimit({
  windowMs: 60_000,
  max: 5,
  key: async (c) => {
    const email = await bodyEmail(c);
    return email ? `email:${email}` : null;
  },
});
const signupIpLimit = rateLimit({ windowMs: 600_000, max: 5, key: (c) => `ip:${clientIp(c)}` });

appAuthRoute.post("/signup", signupIpLimit, async (c) => {
  if (!appAuthSettings().allowSignup) {
    recordRefusedSignup();
    throw new HTTPException(403, { message: SIGNUP_DISABLED_MESSAGE });
  }
  const body = await parseJson(c, signupSchema);
  if (appAuthUsers.byEmail(body.email)) {
    throw new HTTPException(409, { message: "email already exists" });
  }

  const id = newId("app_user");
  appAuthUsers.insert({
    id,
    email: body.email,
    passwordHash: await hashPassword(body.password),
    displayName: body.displayName?.trim() || null,
    emailConfirmed: true,
    status: "active",
  });
  appAuthUsers.updateLastSignIn(id);
  audit.log(null, "app_auth.signup", id, { email: body.email });
  return c.json({ session: await sessionFor(appAuthUsers.byId(id)!) });
});

appAuthRoute.post("/token", tokenIpLimit, tokenEmailLimit, async (c) => {
  const body = await parseJson(c, tokenSchema);
  const user = appAuthUsers.byEmail(body.email);
  const ok = await checkPassword(body.password, user?.passwordHash);
  if (!user || !ok) {
    throw new HTTPException(401, { message: "invalid credentials" });
  }
  if (user.status !== "active") {
    throw new HTTPException(403, { message: "user disabled" });
  }
  appAuthUsers.updateLastSignIn(user.id);
  audit.log(null, "app_auth.token", user.id, { email: body.email });
  return c.json({ session: await sessionFor(appAuthUsers.byId(user.id)!) });
});

appAuthRoute.get("/user", async (c) => {
  const user = await appUserFromBearer(c.req.header("Authorization"));
  return c.json({ user });
});

appAuthRoute.get("/settings", requireAuth, requireRole("admin"), (c) => {
  return c.json({ settings: appAuthSettings() });
});

appAuthRoute.patch("/settings", requireAuth, requireRole("admin"), async (c) => {
  const body = await parseJson(c, settingsSchema);
  const settings = updateAppAuthSettings(body);
  audit.log(c.get("user").id, "app_auth.settings.update", null, {
    allowSignup: settings.allowSignup,
    tokenTtlSeconds: settings.tokenTtlSeconds,
  });
  return c.json({ settings });
});

appAuthRoute.get("/users", requireAuth, requireRole("admin"), (c) => {
  return c.json({ users: appAuthUsers.list() });
});

appAuthRoute.post("/users", requireAuth, requireRole("admin"), async (c) => {
  const body = await parseJson(c, createUserSchema);
  if (appAuthUsers.byEmail(body.email)) {
    throw new HTTPException(409, { message: "email already exists" });
  }

  const id = newId("app_user");
  appAuthUsers.insert({
    id,
    email: body.email,
    passwordHash: await hashPassword(body.password),
    displayName: body.displayName?.trim() || null,
    emailConfirmed: body.emailConfirmed !== false,
    status: body.status ?? "active",
  });
  audit.log(c.get("user").id, "app_auth.user.create", id, { email: body.email });
  return c.json({ user: publicAppUser(appAuthUsers.byId(id)!) });
});

appAuthRoute.patch("/users/:id", requireAuth, requireRole("admin"), async (c) => {
  const id = c.req.param("id");
  const body = await parseJson(c, updateUserSchema);
  const existing = appAuthUsers.byId(id);
  if (!existing) throw new HTTPException(404, { message: "app user not found" });

  const patch: Parameters<typeof appAuthUsers.update>[1] = {};
  if (body.displayName !== undefined) patch.displayName = body.displayName?.trim() || null;
  if (body.emailConfirmed !== undefined) patch.emailConfirmed = body.emailConfirmed;
  if (body.status !== undefined) patch.status = body.status;
  if (body.password !== undefined) patch.passwordHash = await hashPassword(body.password);
  appAuthUsers.update(id, patch);
  if (body.password !== undefined) revokeAppSessions(id);
  if (body.password !== undefined || body.status === "disabled") disconnectAppUser(id);
  audit.log(c.get("user").id, "app_auth.user.update", id, {
    status: body.status,
    emailConfirmed: body.emailConfirmed,
    ...(body.password !== undefined ? { passwordChanged: true, sessionsRevoked: true } : {}),
  });
  return c.json({ user: publicAppUser(appAuthUsers.byId(id)!) });
});

appAuthRoute.delete("/users/:id", requireAuth, requireRole("admin"), (c) => {
  const id = c.req.param("id");
  const existing = appAuthUsers.byId(id);
  if (!existing) throw new HTTPException(404, { message: "app user not found" });
  appAuthUsers.delete(id);
  disconnectAppUser(id);
  audit.log(c.get("user").id, "app_auth.user.delete", id, { email: existing.email });
  return c.json({ ok: true });
});

async function sessionFor(user: AppAuthUser): Promise<AppAuthSession> {
  const token = await signAppAuthJwt(user);
  return {
    accessToken: token.accessToken,
    tokenType: "bearer",
    expiresIn: token.expiresIn,
    user: publicAppUser(user),
  };
}
