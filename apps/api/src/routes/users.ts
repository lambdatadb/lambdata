import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { ExperienceLevel, Role, User } from "@kilndb/shared";
import { audit, users } from "../db/queries";
import { hashPassword } from "../auth/password";
import { requireAuth, requireRole, type AuthVariables } from "../auth/middleware";
import { newId } from "../util/id";

function publicUser(u: (User & { passwordHash?: string }) | null): User | null {
  if (!u) return null;
  const { passwordHash: _strip, ...rest } = u;
  void _strip;
  return rest;
}

export const usersRoute = new Hono<{ Variables: AuthVariables }>();

usersRoute.use("*", requireAuth);

usersRoute.get("/", requireRole("admin"), (c) => c.json({ users: users.list() }));

usersRoute.post("/", requireRole("admin"), async (c) => {
  const body = (await c.req.json()) as {
    email?: string;
    password?: string;
    displayName?: string;
    role?: Role;
    experienceLevel?: ExperienceLevel;
  };
  if (!body.email || !body.password || !body.role) {
    throw new HTTPException(400, { message: "email, password, and role required" });
  }
  if (body.password.length < 8) {
    throw new HTTPException(400, { message: "password must be at least 8 characters" });
  }
  if (!["admin", "db_owner", "viewer"].includes(body.role)) {
    throw new HTTPException(400, { message: "invalid role" });
  }
  const email = body.email.toLowerCase().trim();
  if (users.byEmail(email)) {
    throw new HTTPException(409, { message: "email already exists" });
  }
  const id = newId("u");
  users.insert({
    id,
    email,
    passwordHash: await hashPassword(body.password),
    displayName: body.displayName ?? null,
    role: body.role,
    experienceLevel: body.experienceLevel === "novice" ? "novice" : "advanced",
  });
  audit.log(c.get("user").id, "user.create", id, { email, role: body.role });
  return c.json({ user: publicUser(users.byId(id)) });
});

usersRoute.patch("/:id", async (c) => {
  const me = c.get("user");
  const id = c.req.param("id");
  const body = (await c.req.json()) as {
    role?: Role;
    password?: string;
    displayName?: string;
    experienceLevel?: ExperienceLevel;
    dataViewEnabled?: boolean;
  };
  const target = users.byId(id);
  if (!target) throw new HTTPException(404, { message: "not found" });

  const selfOnly = me.id === id;
  if (!selfOnly && me.role !== "admin") {
    throw new HTTPException(403, { message: "forbidden" });
  }

  if (body.role !== undefined) {
    if (me.role !== "admin") throw new HTTPException(403, { message: "only admin can change role" });
    if (!["admin", "db_owner", "viewer"].includes(body.role)) {
      throw new HTTPException(400, { message: "invalid role" });
    }
    users.updateRole(id, body.role);
  }
  if (body.password !== undefined) {
    if (body.password.length < 8) {
      throw new HTTPException(400, { message: "password must be at least 8 characters" });
    }
    users.updatePassword(id, await hashPassword(body.password));
  }
  if (body.experienceLevel !== undefined) {
    if (!selfOnly && me.role !== "admin") {
      throw new HTTPException(403, { message: "forbidden" });
    }
    users.updateExperience(id, body.experienceLevel === "novice" ? "novice" : "advanced");
  }
  if (body.dataViewEnabled !== undefined) {
    if (!selfOnly && me.role !== "admin") {
      throw new HTTPException(403, { message: "forbidden" });
    }
    users.updateDataView(id, !!body.dataViewEnabled);
  }
  audit.log(me.id, "user.update", id, body);
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
