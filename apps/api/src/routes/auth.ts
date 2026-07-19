import { Hono } from "hono";
import { setCookie, deleteCookie } from "hono/cookie";
import { HTTPException } from "hono/http-exception";
import type { AuthResponse } from "@kilndb/shared";
import { audit, users } from "../db/queries";
import { verifyPassword } from "../auth/password";
import { COOKIE_MAX_AGE, COOKIE_NAME, signJwt } from "../auth/jwt";
import { requireAuth, type AuthVariables } from "../auth/middleware";
import { bodyEmail, clientIp, rateLimit } from "../util/rateLimit";
import { env } from "../env";

export const authRoute = new Hono<{ Variables: AuthVariables }>();

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
  const body = (await c.req.json()) as { email?: string; password?: string };
  if (!body.email || !body.password) {
    throw new HTTPException(400, { message: "email and password required" });
  }
  const u = users.byEmail(body.email.toLowerCase().trim());
  if (!u || !(await verifyPassword(body.password, u.passwordHash))) {
    throw new HTTPException(401, { message: "invalid credentials" });
  }
  users.updateLastLogin(u.id);
  audit.log(u.id, "auth.login", null, null);
  const token = await signJwt(u.id, u.role);
  setCookie(c, COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: "Lax",
    path: "/",
    maxAge: COOKIE_MAX_AGE,
    secure: env.cookieSecure,
  });
  const res: AuthResponse = {
    user: {
      id: u.id,
      email: u.email,
      displayName: u.displayName,
      role: u.role,
      experienceLevel: u.experienceLevel,
      dataViewEnabled: u.dataViewEnabled,
      createdAt: u.createdAt,
      lastLoginAt: Date.now(),
    },
  };
  return c.json(res);
});

authRoute.post("/logout", (c) => {
  deleteCookie(c, COOKIE_NAME, { path: "/" });
  return c.json({ ok: true });
});

authRoute.get("/me", requireAuth, (c) => {
  const res: AuthResponse = { user: c.get("user") };
  return c.json(res);
});
