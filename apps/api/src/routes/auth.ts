import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import type { AuthResponse } from "@lambdata/shared";
import { audit, users } from "../db/queries";
import { checkPassword } from "../auth/password";
import { clearSessionCookies, issueSessionCookie } from "../auth/jwt";
import { requireAuth, toPublicUser, type AuthVariables } from "../auth/middleware";
import { revokeConsoleSessions } from "../auth/tokenVersions";
import { bodyEmail, clientIp, rateLimit } from "../util/rateLimit";
import { parseJson } from "../util/validate";

export const authRoute = new Hono<{ Variables: AuthVariables }>();

const loginSchema = z.object({
  email: z.string({ error: "email and password required" }).trim().min(1, "email and password required"),
  password: z.string({ error: "email and password required" }).min(1, "email and password required"),
});

const loginIpLimit = rateLimit({ windowMs: 60_000, max: 10, key: (c) => `ip:${clientIp(c)}` });
const loginEmailLimit = rateLimit({
  windowMs: 60_000,
  max: 5,
  key: async (c) => {
    const email = await bodyEmail(c);
    return email ? `email:${email}` : null;
  },
});

authRoute.post("/login", loginIpLimit, loginEmailLimit, async (c) => {
  const body = await parseJson(c, loginSchema);
  const u = users.byEmail(body.email.toLowerCase());
  const ok = await checkPassword(body.password, u?.passwordHash);
  if (!u || !ok) {
    throw new HTTPException(401, { message: "invalid credentials" });
  }
  users.updateLastLogin(u.id);
  audit.log(u.id, "auth.login", null, null);
  await issueSessionCookie(c, u.id, u.role);
  const res: AuthResponse = { user: { ...toPublicUser(u), lastLoginAt: Date.now() } };
  return c.json(res);
});

authRoute.post("/logout", (c) => {
  clearSessionCookies(c);
  return c.json({ ok: true });
});

authRoute.post("/logout-all", requireAuth, (c) => {
  const user = c.get("user");
  revokeConsoleSessions(user.id);
  audit.log(user.id, "auth.logout_all", user.id, null);
  clearSessionCookies(c);
  return c.json({ ok: true });
});

authRoute.get("/me", requireAuth, (c) => {
  const res: AuthResponse = { user: c.get("user") };
  return c.json(res);
});
