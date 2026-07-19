import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type {
  AppAuthSession,
  AppAuthSettings,
  AppAuthUser,
  AppAuthUserStatus,
} from "@kilndb/shared";
import { audit, appAuthUsers } from "../db/queries";
import { hashPassword, verifyPassword } from "../auth/password";
import {
  appAuthSettings,
  signAppAuthJwt,
  updateAppAuthSettings,
  verifyAppAuthJwt,
} from "../auth/appJwt";
import { requireAuth, requireRole, type AuthVariables } from "../auth/middleware";
import { bodyEmail, clientIp, rateLimit } from "../util/rateLimit";
import { newId } from "../util/id";

export const appAuthRoute = new Hono<{ Variables: AuthVariables }>();

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
  const cfg = appAuthSettings();
  if (!cfg.allowSignup) {
    throw new HTTPException(403, { message: "signup is disabled" });
  }

  const body = (await c.req.json()) as {
    email?: string;
    password?: string;
    displayName?: string | null;
  };
  const email = normalizeEmail(body.email);
  validatePassword(body.password);
  if (appAuthUsers.byEmail(email)) {
    throw new HTTPException(409, { message: "email already exists" });
  }

  const id = newId("app_user");
  appAuthUsers.insert({
    id,
    email,
    passwordHash: await hashPassword(body.password!),
    displayName: body.displayName?.trim() || null,
    emailConfirmed: true,
    status: "active",
  });
  appAuthUsers.updateLastSignIn(id);
  audit.log(null, "app_auth.signup", id, { email });
  return c.json({ session: await sessionFor(appAuthUsers.byId(id)!) });
});

appAuthRoute.post("/token", tokenIpLimit, tokenEmailLimit, async (c) => {
  const body = (await c.req.json()) as { email?: string; password?: string };
  const email = normalizeEmail(body.email);
  if (!body.password) throw new HTTPException(400, { message: "password required" });

  const user = appAuthUsers.byEmail(email);
  if (!user || !(await verifyPassword(body.password, user.passwordHash))) {
    throw new HTTPException(401, { message: "invalid credentials" });
  }
  if (user.status !== "active") {
    throw new HTTPException(403, { message: "user disabled" });
  }
  appAuthUsers.updateLastSignIn(user.id);
  audit.log(null, "app_auth.token", user.id, { email });
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
  const body = (await c.req.json()) as Partial<AppAuthSettings>;
  const settings = updateAppAuthSettings({
    allowSignup: body.allowSignup,
    tokenTtlSeconds: body.tokenTtlSeconds,
  });
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
  const body = (await c.req.json()) as {
    email?: string;
    password?: string;
    displayName?: string | null;
    emailConfirmed?: boolean;
    status?: AppAuthUserStatus;
  };
  const email = normalizeEmail(body.email);
  validatePassword(body.password);
  if (appAuthUsers.byEmail(email)) {
    throw new HTTPException(409, { message: "email already exists" });
  }

  const id = newId("app_user");
  appAuthUsers.insert({
    id,
    email,
    passwordHash: await hashPassword(body.password!),
    displayName: body.displayName?.trim() || null,
    emailConfirmed: body.emailConfirmed !== false,
    status: body.status === "disabled" ? "disabled" : "active",
  });
  audit.log(c.get("user").id, "app_auth.user.create", id, { email });
  return c.json({ user: publicAppUser(appAuthUsers.byId(id)!) });
});

appAuthRoute.patch("/users/:id", requireAuth, requireRole("admin"), async (c) => {
  const id = c.req.param("id");
  const existing = appAuthUsers.byId(id);
  if (!existing) throw new HTTPException(404, { message: "app user not found" });

  const body = (await c.req.json()) as {
    displayName?: string | null;
    password?: string;
    emailConfirmed?: boolean;
    status?: AppAuthUserStatus;
  };
  const patch: Parameters<typeof appAuthUsers.update>[1] = {};
  if (body.displayName !== undefined) {
    patch.displayName = body.displayName?.trim() || null;
  }
  if (body.emailConfirmed !== undefined) {
    patch.emailConfirmed = !!body.emailConfirmed;
  }
  if (body.status !== undefined) {
    if (!["active", "disabled"].includes(body.status)) {
      throw new HTTPException(400, { message: "invalid status" });
    }
    patch.status = body.status;
  }
  if (body.password !== undefined) {
    validatePassword(body.password);
    patch.passwordHash = await hashPassword(body.password);
  }
  appAuthUsers.update(id, patch);
  audit.log(c.get("user").id, "app_auth.user.update", id, {
    status: body.status,
    emailConfirmed: body.emailConfirmed,
  });
  return c.json({ user: publicAppUser(appAuthUsers.byId(id)!) });
});

appAuthRoute.delete("/users/:id", requireAuth, requireRole("admin"), (c) => {
  const id = c.req.param("id");
  const existing = appAuthUsers.byId(id);
  if (!existing) throw new HTTPException(404, { message: "app user not found" });
  appAuthUsers.delete(id);
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

function publicAppUser(user: AppAuthUser & { passwordHash?: string }): AppAuthUser {
  const { passwordHash: _strip, ...rest } = user;
  void _strip;
  return rest;
}

async function appUserFromBearer(header: string | undefined): Promise<AppAuthUser> {
  const match = header?.match(/^Bearer\s+(.+)$/i);
  if (!match) throw new HTTPException(401, { message: "bearer token required" });
  const claims = await verifyAppAuthJwt(match[1]!);
  if (!claims) throw new HTTPException(401, { message: "invalid token" });
  const user = appAuthUsers.byId(claims.sub);
  if (!user || user.status !== "active") {
    throw new HTTPException(401, { message: "user not active" });
  }
  return publicAppUser(user);
}

function normalizeEmail(input: string | undefined): string {
  const email = input?.trim().toLowerCase() ?? "";
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new HTTPException(400, { message: "valid email required" });
  }
  return email;
}

function validatePassword(password: string | undefined): void {
  if (!password) throw new HTTPException(400, { message: "password required" });
  if (password.length < 8) {
    throw new HTTPException(400, { message: "password must be at least 8 characters" });
  }
}
