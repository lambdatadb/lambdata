import { settings } from "../db/queries";
import { generatePassword } from "../util/credentials";
import { base64UrlDecode, base64UrlEncode, copyToFresh, decryptSecret, encryptSecret } from "../util/crypto";

export const ENCRYPTED_SECRET_PREFIX = "enc:v1:";

export type JwtClaims = Record<string, unknown> & { exp: number };

interface CachedKey {
  stored: string;
  key: CryptoKey;
}

const cache = new Map<string, CachedKey>();
const loading = new Map<string, Promise<CryptoKey>>();

function newSecret(): string {
  return generatePassword() + generatePassword();
}

async function importHmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    copyToFresh(new TextEncoder().encode(secret)),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

async function storedSecret(settingKey: string, stored: string | null): Promise<{ secret: string; fresh: boolean }> {
  if (stored?.startsWith(ENCRYPTED_SECRET_PREFIX)) {
    try {
      return { secret: await decryptSecret(stored.slice(ENCRYPTED_SECRET_PREFIX.length)), fresh: false };
    } catch {
      console.warn(`[auth] ${settingKey} cannot be decrypted with the master key; issuing a new signing secret`);
      return { secret: newSecret(), fresh: true };
    }
  }
  if (stored) return { secret: stored, fresh: false };
  return { secret: newSecret(), fresh: true };
}

async function sealed(secret: string): Promise<string | null> {
  try {
    return ENCRYPTED_SECRET_PREFIX + (await encryptSecret(secret));
  } catch (err) {
    console.warn("[auth] could not encrypt a signing secret with the master key:", err instanceof Error ? err.message : err);
    return null;
  }
}

async function loadSigningKey(settingKey: string): Promise<CryptoKey> {
  const stored = settings.get(settingKey);
  const { secret, fresh } = await storedSecret(settingKey, stored);
  let persisted = stored;
  if (fresh || !stored?.startsWith(ENCRYPTED_SECRET_PREFIX)) {
    const encrypted = await sealed(secret);
    persisted = encrypted ?? (fresh ? secret : stored);
    if (persisted !== stored && persisted !== null) settings.set(settingKey, persisted);
  }
  const key = await importHmacKey(secret);
  if (persisted !== null) cache.set(settingKey, { stored: persisted, key });
  return key;
}

export function signingKey(settingKey: string): Promise<CryptoKey> {
  const stored = settings.get(settingKey);
  const hit = cache.get(settingKey);
  if (hit && stored !== null && hit.stored === stored) return Promise.resolve(hit.key);
  let pending = loading.get(settingKey);
  if (!pending) {
    pending = loadSigningKey(settingKey).finally(() => loading.delete(settingKey));
    loading.set(settingKey, pending);
  }
  return pending;
}

function encodeJson(value: unknown): string {
  return base64UrlEncode(new TextEncoder().encode(JSON.stringify(value)));
}

function decodeJson(segment: string): unknown {
  return JSON.parse(new TextDecoder().decode(base64UrlDecode(segment)));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export async function signHs256(settingKey: string, claims: JwtClaims): Promise<string> {
  const signingInput = `${encodeJson({ alg: "HS256", typ: "JWT" })}.${encodeJson(claims)}`;
  const key = await signingKey(settingKey);
  const sig = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, copyToFresh(new TextEncoder().encode(signingInput))),
  );
  return `${signingInput}.${base64UrlEncode(sig)}`;
}

export async function verifyHs256(settingKey: string, token: string): Promise<JwtClaims | null> {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [headerB, claimsB, sigB] = parts as [string, string, string];
  const key = await signingKey(settingKey);
  try {
    const header = decodeJson(headerB);
    if (!isRecord(header) || header.alg !== "HS256") return null;
    const ok = await crypto.subtle.verify(
      "HMAC",
      key,
      base64UrlDecode(sigB),
      copyToFresh(new TextEncoder().encode(`${headerB}.${claimsB}`)),
    );
    if (!ok) return null;
    const claims = decodeJson(claimsB);
    if (!isRecord(claims) || typeof claims.exp !== "number") return null;
    if (claims.exp * 1000 < Date.now()) return null;
    return claims as JwtClaims;
  } catch {
    return null;
  }
}
