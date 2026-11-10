import { HTTPException } from "hono/http-exception";
import type { AppAuthUser } from "@lambdata/shared";
import { appAuthUsers } from "../db/queries";
import { verifyAppAuthJwt } from "./appJwt";

export interface AppSession {
  user: AppAuthUser;
  expiresAt: number;
}

export async function appUserFromBearer(header: string | undefined): Promise<AppAuthUser> {
  const token = bearerTokenFromHeader(header);
  if (!token) throw new HTTPException(401, { message: "bearer token required" });
  const user = await appUserFromToken(token);
  if (!user) throw new HTTPException(401, { message: "invalid token" });
  return user;
}

export async function appSessionFromToken(token: string): Promise<AppSession | null> {
  const claims = await verifyAppAuthJwt(token);
  if (!claims) return null;
  const row = appAuthUsers.byId(claims.sub);
  if (!row || row.status !== "active") return null;
  return { user: publicAppUser(row), expiresAt: claims.exp * 1000 };
}

export async function appUserFromToken(token: string): Promise<AppAuthUser | null> {
  return (await appSessionFromToken(token))?.user ?? null;
}

export function publicAppUser(user: AppAuthUser & { passwordHash?: string }): AppAuthUser {
  const { passwordHash: _strip, ...rest } = user;
  void _strip;
  return rest;
}

export function bearerTokenFromHeader(header: string | undefined | null): string | null {
  const match = header?.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || null;
}
