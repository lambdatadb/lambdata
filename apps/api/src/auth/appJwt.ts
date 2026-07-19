import type { AppAuthSettings, AppAuthUser } from "@kilndb/shared";
import { settings } from "../db/queries";
import { generatePassword } from "../util/credentials";

const ISSUER = "kilndb-app-auth";
const DEFAULT_TOKEN_TTL_SECONDS = 60 * 60;

interface Header {
  alg: "HS256";
  typ: "JWT";
}

interface Claims {
  sub: string;
  email: string;
  role: "authenticated";
  aud: "authenticated";
  iss: typeof ISSUER;
  iat: number;
  exp: number;
}

let secretKey: CryptoKey | null = null;

export function appAuthSettings(): AppAuthSettings {
  const allowSignup = settings.get("app_auth_allow_signup") !== "0";
  const ttlRaw = Number(settings.get("app_auth_token_ttl_seconds") ?? DEFAULT_TOKEN_TTL_SECONDS);
  const tokenTtlSeconds = Number.isFinite(ttlRaw)
    ? Math.max(300, Math.min(60 * 60 * 24 * 30, Math.floor(ttlRaw)))
    : DEFAULT_TOKEN_TTL_SECONDS;
  return {
    allowSignup,
    tokenTtlSeconds,
    issuer: ISSUER,
  };
}

export function updateAppAuthSettings(patch: Partial<AppAuthSettings>): AppAuthSettings {
  if (patch.allowSignup !== undefined) {
    settings.set("app_auth_allow_signup", patch.allowSignup ? "1" : "0");
  }
  if (patch.tokenTtlSeconds !== undefined) {
    const ttl = Math.max(300, Math.min(60 * 60 * 24 * 30, Math.floor(patch.tokenTtlSeconds)));
    settings.set("app_auth_token_ttl_seconds", String(ttl));
  }
  return appAuthSettings();
}

async function getSecretKey(): Promise<CryptoKey> {
  if (secretKey) return secretKey;
  let secret = settings.get("app_auth_jwt_secret");
  if (!secret) {
    secret = generatePassword() + generatePassword();
    settings.set("app_auth_jwt_secret", secret);
  }
  secretKey = await crypto.subtle.importKey(
    "raw",
    copyToFresh(new TextEncoder().encode(secret)),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
  return secretKey;
}

function freshBytes(n: number): Uint8Array<ArrayBuffer> {
  return new Uint8Array(new ArrayBuffer(n));
}

function copyToFresh(src: Uint8Array): Uint8Array<ArrayBuffer> {
  const out = freshBytes(src.byteLength);
  out.set(src);
  return out;
}

function base64UrlEncode(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function base64UrlDecode(s: string): Uint8Array<ArrayBuffer> {
  const pad = (4 - (s.length % 4)) % 4;
  const b64 = (s + "=".repeat(pad)).replaceAll("-", "+").replaceAll("_", "/");
  const bin = atob(b64);
  const out = freshBytes(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export async function signAppAuthJwt(user: AppAuthUser): Promise<{
  accessToken: string;
  expiresIn: number;
}> {
  const cfg = appAuthSettings();
  const header: Header = { alg: "HS256", typ: "JWT" };
  const now = Math.floor(Date.now() / 1000);
  const claims: Claims = {
    sub: user.id,
    email: user.email,
    role: "authenticated",
    aud: "authenticated",
    iss: ISSUER,
    iat: now,
    exp: now + cfg.tokenTtlSeconds,
  };
  const enc = new TextEncoder();
  const headerB = base64UrlEncode(enc.encode(JSON.stringify(header)));
  const claimsB = base64UrlEncode(enc.encode(JSON.stringify(claims)));
  const signingInput = `${headerB}.${claimsB}`;
  const key = await getSecretKey();
  const sig = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, copyToFresh(enc.encode(signingInput))),
  );
  return {
    accessToken: `${signingInput}.${base64UrlEncode(sig)}`,
    expiresIn: cfg.tokenTtlSeconds,
  };
}

export async function verifyAppAuthJwt(token: string): Promise<Claims | null> {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [headerB, claimsB, sigB] = parts as [string, string, string];
  const key = await getSecretKey();
  const enc = new TextEncoder();
  const ok = await crypto.subtle.verify(
    "HMAC",
    key,
    base64UrlDecode(sigB),
    copyToFresh(enc.encode(`${headerB}.${claimsB}`)),
  );
  if (!ok) return null;
  try {
    const claims = JSON.parse(new TextDecoder().decode(base64UrlDecode(claimsB))) as Claims;
    if (claims.exp * 1000 < Date.now()) return null;
    if (claims.iss !== ISSUER || claims.aud !== "authenticated") return null;
    return claims;
  } catch {
    return null;
  }
}
