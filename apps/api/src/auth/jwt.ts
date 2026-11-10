import type { Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { isSecureRequest } from "../network/request";
import { LEGACY } from "../util/legacy";
import { signHs256, verifyHs256 } from "./hs256";
import { consoleTokenVersion, tokenVersionMatches } from "./tokenVersions";

const TOKEN_TTL_SECONDS = 60 * 60 * 24 * 7;
const SECRET_SETTING = "jwt_secret";

export interface SessionClaims {
  sub: string;
  role: string;
  ver: number;
  iat: number;
  exp: number;
}

export async function signJwt(userId: string, role: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const claims: SessionClaims = {
    sub: userId,
    role,
    ver: consoleTokenVersion(userId) ?? 0,
    iat: now,
    exp: now + TOKEN_TTL_SECONDS,
  };
  return signHs256(SECRET_SETTING, { ...claims });
}

export async function verifyJwt(token: string): Promise<SessionClaims | null> {
  const claims = await verifyHs256(SECRET_SETTING, token);
  if (!claims || typeof claims.sub !== "string") return null;
  if (!tokenVersionMatches(claims.ver, consoleTokenVersion(claims.sub))) return null;
  return {
    sub: claims.sub,
    role: typeof claims.role === "string" ? claims.role : "",
    ver: typeof claims.ver === "number" ? claims.ver : 0,
    iat: typeof claims.iat === "number" ? claims.iat : 0,
    exp: claims.exp,
  };
}

export const COOKIE_NAME = "lambdata_session";
export const COOKIE_MAX_AGE = TOKEN_TTL_SECONDS;
export const SESSION_COOKIE_NAMES = [COOKIE_NAME, LEGACY.sessionCookie] as const;

export function readSessionCookie(c: Context): string | undefined {
  for (const name of SESSION_COOKIE_NAMES) {
    const value = getCookie(c, name);
    if (value) return value;
  }
  return undefined;
}

function browserOnHttps(c: Context): boolean {
  const origin = c.req.header("origin");
  if (!origin) return false;
  try {
    return new URL(origin).protocol === "https:";
  } catch {
    return false;
  }
}

export function sessionCookieSecure(c: Context): boolean {
  return isSecureRequest(c) || browserOnHttps(c);
}

export async function issueSessionCookie(c: Context, userId: string, role: string): Promise<void> {
  const token = await signJwt(userId, role);
  setCookie(c, COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: "Strict",
    path: "/",
    maxAge: COOKIE_MAX_AGE,
    secure: sessionCookieSecure(c),
  });
}

export function clearSessionCookies(c: Context): void {
  for (const name of SESSION_COOKIE_NAMES) {
    deleteCookie(c, name, { path: "/" });
  }
}
