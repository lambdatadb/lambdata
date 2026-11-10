import type { Context, MiddlewareHandler } from "hono";
import { HTTPException } from "hono/http-exception";
import type { Role, User } from "@lambdata/shared";
import { users, databases } from "../db/queries";
import { isLocalRequest } from "../network/request";
import { readSessionCookie, verifyJwt } from "./jwt";

export interface AuthVariables {
  user: User;
}

export function toPublicUser(user: User & { passwordHash?: string }): User {
  return {
    id: user.id,
    email: user.email,
    displayName: user.displayName,
    role: user.role,
    experienceLevel: user.experienceLevel,
    dataViewEnabled: user.dataViewEnabled,
    colorTheme: user.colorTheme,
    vitalsChartStyle: user.vitalsChartStyle,
    createdAt: user.createdAt,
    lastLoginAt: user.lastLoginAt,
  };
}

export const requireAuth: MiddlewareHandler<{ Variables: AuthVariables }> = async (c, next) => {
  if (c.get("user")) return next();
  const token = readSessionCookie(c);
  if (!token) throw new HTTPException(401, { message: "not authenticated" });
  const claims = await verifyJwt(token);
  if (!claims) throw new HTTPException(401, { message: "invalid session" });
  const user = users.byId(claims.sub);
  if (!user) throw new HTTPException(401, { message: "user not found" });
  c.set("user", toPublicUser(user));
  await next();
};

export function requireRole(...allowed: Role[]): MiddlewareHandler<{ Variables: AuthVariables }> {
  return async (c, next) => {
    const u = c.get("user");
    if (!u) throw new HTTPException(401, { message: "not authenticated" });
    if (!allowed.includes(u.role)) {
      throw new HTTPException(403, { message: "forbidden" });
    }
    await next();
  };
}

export type DbAccessLevel = "read" | "write" | "owner";

export function requireDbAccess(
  paramName: string,
  level: DbAccessLevel,
): MiddlewareHandler<{ Variables: AuthVariables }> {
  return async (c, next) => {
    const user = c.get("user");
    if (!user) throw new HTTPException(401, { message: "not authenticated" });
    const id = c.req.param(paramName);
    if (!id) throw new HTTPException(400, { message: `missing :${paramName}` });
    const dbRow = databases.byId(id);
    if (!dbRow) throw new HTTPException(404, { message: "database not found" });
    if (user.role === "admin") return next();
    if (user.role === "db_owner") {
      if (dbRow.ownerUserId !== user.id) {
        throw new HTTPException(403, { message: "not owner" });
      }
      return next();
    }
    if (level !== "read") {
      throw new HTTPException(403, { message: "read-only role" });
    }
    return next();
  };
}

export function isLoopbackRequest(c: Context): boolean {
  return isLocalRequest(c);
}

export const BEFORE_SETUP_LOOPBACK_MESSAGE =
  "until first-run setup is complete this endpoint only answers requests made on the server itself (localhost)";
