import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import type { User } from "@lambdata/shared";
import { audit, isColorTheme, users } from "../db/queries";
import { hashPassword, verifyPassword } from "../auth/password";
import { issueSessionCookie } from "../auth/jwt";
import { requireAuth, requireRole, toPublicUser, type AuthVariables } from "../auth/middleware";
import { revokeConsoleSessions } from "../auth/tokenVersions";
import { newId } from "../util/id";
import { rateLimit } from "../util/rateLimit";
import { parseJson } from "../util/validate";

const PASSWORD_MESSAGE = "password must be at least 8 characters";

const roleSchema = z.enum(["admin", "db_owner", "viewer"], { error: "invalid role" });
const experienceSchema = z.enum(["novice", "advanced"], { error: "invalid experience level" });
const displayNameSchema = z.string().trim().max(200, "display name is too long").nullable();

const createSchema = z.object({
  email: z.string({ error: "email, password, and role required" }).trim().min(1, "email, password, and role required"),
  password: z.string({ error: "email, password, and role required" }).min(8, PASSWORD_MESSAGE),
  displayName: displayNameSchema.optional(),
  role: roleSchema,
  experienceLevel: experienceSchema.optional(),
});

const patchSchema = z.object({
  role: roleSchema.optional(),
  password: z.string().min(8, PASSWORD_MESSAGE).optional(),
  currentPassword: z.string().optional(),
  displayName: displayNameSchema.optional(),
  experienceLevel: experienceSchema.optional(),
  dataViewEnabled: z.boolean().optional(),
  colorTheme: z.string().optional(),
  vitalsChartStyle: z.enum(["area", "capsules"], { error: "invalid chart style" }).optional(),
});

const passwordChangeLimit = rateLimit({
  windowMs: 60_000,
  max: 10,
  key: async (c) => {
    const user = c.get("user") as User | undefined;
    if (!user) return null;
    try {
      const body = JSON.parse(await c.req.text()) as { password?: unknown } | null;
      return body && body.password !== undefined ? `password:${user.id}` : null;
    } catch {
      return null;
    }
  },
});

function publicUser(u: (User & { passwordHash?: string }) | null): User | null {
  return u ? toPublicUser(u) : null;
}

export const usersRoute = new Hono<{ Variables: AuthVariables }>();

usersRoute.use("*", requireAuth);

usersRoute.get("/", requireRole("admin"), (c) => c.json({ users: users.list() }));

usersRoute.post("/", requireRole("admin"), async (c) => {
  const body = await parseJson(c, createSchema);
  const email = body.email.toLowerCase();
  if (users.byEmail(email)) {
    throw new HTTPException(409, { message: "email already exists" });
  }
  const id = newId("u");
  users.insert({
    id,
    email,
    passwordHash: await hashPassword(body.password),
    displayName: body.displayName || null,
    role: body.role,
    experienceLevel: body.experienceLevel ?? "advanced",
  });
  audit.log(c.get("user").id, "user.create", id, { email, role: body.role });
  return c.json({ user: publicUser(users.byId(id)) });
});

usersRoute.patch("/:id", passwordChangeLimit, async (c) => {
  const me = c.get("user");
  const id = c.req.param("id");
  const body = await parseJson(c, patchSchema);
  const target = users.byId(id);
  if (!target) throw new HTTPException(404, { message: "not found" });

  const self = me.id === id;
  if (!self && me.role !== "admin") {
    throw new HTTPException(403, { message: "forbidden" });
  }
  if (body.role !== undefined && me.role !== "admin") {
    throw new HTTPException(403, { message: "only admin can change role" });
  }
  if (body.colorTheme !== undefined && !isColorTheme(body.colorTheme)) {
    throw new HTTPException(400, { message: "invalid color theme" });
  }
  if (body.password !== undefined && self) {
    if (!body.currentPassword) {
      throw new HTTPException(400, { message: "current password required to change your password" });
    }
    if (!(await verifyPassword(body.currentPassword, target.passwordHash))) {
      throw new HTTPException(403, { message: "current password is incorrect" });
    }
  }

  if (body.role !== undefined) users.updateRole(id, body.role);
  if (body.displayName !== undefined) users.updateDisplayName(id, body.displayName || null);
  if (body.experienceLevel !== undefined) users.updateExperience(id, body.experienceLevel);
  if (body.dataViewEnabled !== undefined) users.updateDataView(id, body.dataViewEnabled);
  if (body.colorTheme !== undefined && isColorTheme(body.colorTheme)) users.updateColorTheme(id, body.colorTheme);
  if (body.vitalsChartStyle !== undefined) users.updateVitalsChartStyle(id, body.vitalsChartStyle);
  if (body.password !== undefined) {
    users.updatePassword(id, await hashPassword(body.password));
    revokeConsoleSessions(id);
    if (self) await issueSessionCookie(c, id, users.byId(id)?.role ?? me.role);
  }

  const { password: _password, currentPassword: _current, ...logged } = body;
  void _password;
  void _current;
  audit.log(me.id, "user.update", id, {
    ...logged,
    ...(body.password !== undefined ? { passwordChanged: true, sessionsRevoked: true } : {}),
  });
  return c.json({ user: publicUser(users.byId(id)) });
});

usersRoute.delete("/:id", requireRole("admin"), (c) => {
  const me = c.get("user");
  const id = c.req.param("id");
  if (id === me.id) {
    throw new HTTPException(400, { message: "cannot delete yourself" });
  }
  users.delete(id);
  audit.log(me.id, "user.delete", id, null);
  return c.json({ ok: true });
});
