import { HTTPException } from "hono/http-exception";
import type { AppAuthUser } from "@kilndb/shared";
import { appAuthUsers } from "../db/queries";
import { verifyAppAuthJwt } from "./appJwt";

export async function appUserFromBearer(header: string | undefined): Promise<AppAuthUser> {
  const token = bearerTokenFromHeader(header);
  if (!token) throw new HTTPException(401, { message: "bearer token required" });
  const user = await appUserFromToken(token);
  if (!user) throw new HTTPException(401, { message: "invalid token" });
  return user;
}

export async function appUserFromToken(token: string): Promise<AppAuthUser | null> {
  const claims = await verifyAppAuthJwt(token);
  if (!claims) return null;
  const row = appAuthUsers.byId(claims.sub);
  if (!row || row.status !== "active") return null;
  const { passwordHash: _strip, ...publicUser } = row;
  void _strip;
  return publicUser;
}

export function bearerTokenFromHeader(header: string | undefined | null): string | null {
  const match = header?.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || null;
}
