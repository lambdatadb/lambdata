import type { AccessConfig } from "./config";

export type AccessVerification =
  | { ok: true; email: string | null; subject: string | null; expiresAt: number }
  | { ok: false; error: string };

export interface VerifierOptions {
  certsUrl?: (teamDomain: string) => string;
  fetch?: typeof fetch;
  minRefetchMs?: number;
  maxKeyAgeMs?: number;
  fetchTimeoutMs?: number;
  clockSkewSec?: number;
  now?: () => number;
}

interface Jwk {
  kid?: unknown;
  kty?: unknown;
  n?: unknown;
  e?: unknown;
  alg?: unknown;
  use?: unknown;
}

const MAX_TOKEN_LENGTH = 16 * 1024;
const RESULT_CACHE_LIMIT = 512;
const RESULT_CACHE_MS = 60_000;

export const TEAM_DOMAIN_SUFFIX = ".cloudflareaccess.com";

export function defaultCertsUrl(teamDomain: string): string {
  return `https://${teamDomain}/cdn-cgi/access/certs`;
}

function b64urlBytes(s: string): Uint8Array<ArrayBuffer> | null {
  if (!/^[A-Za-z0-9_-]*$/.test(s)) return null;
  try {
    const padded = s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4);
    const bin = atob(padded);
    const out = new Uint8Array(new ArrayBuffer(bin.length));
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

function b64urlJson(s: string): Record<string, unknown> | null {
  const bytes = b64urlBytes(s);
  if (!bytes) return null;
  try {
    const value = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export class AccessVerifier {
  readonly teamDomain: string;
  readonly audience: string;
  readonly issuer: string;
  private readonly certsUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly minRefetchMs: number;
  private readonly maxKeyAgeMs: number;
  private readonly fetchTimeoutMs: number;
  private readonly skewSec: number;
  private readonly now: () => number;
  private keys = new Map<string, CryptoKey>();
  private fetchedAt = 0;
  private lastAttemptAt = 0;
  private inflight: Promise<void> | null = null;
  private results = new Map<string, { value: AccessVerification & { ok: true }; until: number }>();
  fetchCount = 0;

  constructor(config: AccessConfig, opts: VerifierOptions = {}) {
    this.teamDomain = config.teamDomain;
    this.audience = config.audience;
    this.issuer = `https://${config.teamDomain}`;
    this.certsUrl = (opts.certsUrl ?? defaultCertsUrl)(config.teamDomain);
    this.fetchImpl = opts.fetch ?? fetch;
    this.minRefetchMs = opts.minRefetchMs ?? 30_000;
    this.maxKeyAgeMs = opts.maxKeyAgeMs ?? 60 * 60_000;
    this.fetchTimeoutMs = opts.fetchTimeoutMs ?? 5_000;
    this.skewSec = opts.clockSkewSec ?? 30;
    this.now = opts.now ?? Date.now;
  }

  private async refresh(): Promise<void> {
    if (this.inflight) return this.inflight;
    this.lastAttemptAt = this.now();
    this.fetchCount += 1;
    this.inflight = (async () => {
      const res = await this.fetchImpl(this.certsUrl, {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(this.fetchTimeoutMs),
        redirect: "error",
      });
      if (!res.ok) throw new Error(`Cloudflare Access keys request returned HTTP ${res.status}`);
      const body = (await res.json()) as { keys?: unknown };
      if (!Array.isArray(body.keys)) throw new Error("Cloudflare Access keys response has no keys");
      const next = new Map<string, CryptoKey>();
      for (const raw of body.keys as Jwk[]) {
        if (typeof raw.kid !== "string" || raw.kty !== "RSA") continue;
        if (typeof raw.n !== "string" || typeof raw.e !== "string") continue;
        if (raw.alg !== undefined && raw.alg !== "RS256") continue;
        if (raw.use !== undefined && raw.use !== "sig") continue;
        try {
          const key = await crypto.subtle.importKey(
            "jwk",
            { kty: "RSA", n: raw.n, e: raw.e, alg: "RS256", ext: true },
            { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
            false,
            ["verify"],
          );
          next.set(raw.kid, key);
        } catch {
          continue;
        }
      }
      if (next.size === 0) throw new Error("Cloudflare Access keys response has no usable RS256 keys");
      this.keys = next;
      this.fetchedAt = this.now();
    })().finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  private async keyFor(kid: string): Promise<CryptoKey | null> {
    const stale = this.now() - this.fetchedAt > this.maxKeyAgeMs;
    if (this.keys.size === 0 || stale) {
      try {
        await this.refresh();
      } catch (err) {
        if (this.keys.size === 0) throw err;
      }
    }
    const known = this.keys.get(kid);
    if (known) return known;
    if (this.now() - this.lastAttemptAt < this.minRefetchMs) return null;
    await this.refresh();
    return this.keys.get(kid) ?? null;
  }

  private remember(token: string, value: AccessVerification & { ok: true }): void {
    if (this.results.size >= RESULT_CACHE_LIMIT) {
      const oldest = this.results.keys().next().value;
      if (oldest !== undefined) this.results.delete(oldest);
    }
    this.results.set(token, { value, until: Math.min(value.expiresAt, this.now() + RESULT_CACHE_MS) });
  }

  async verify(token: string | null | undefined): Promise<AccessVerification> {
    if (!token) return { ok: false, error: "no Cf-Access-Jwt-Assertion header on this request" };
    const cached = this.results.get(token);
    if (cached && cached.until > this.now()) return cached.value;
    if (cached) this.results.delete(token);
    if (token.length > MAX_TOKEN_LENGTH) return { ok: false, error: "token is too large" };
    const parts = token.split(".");
    if (parts.length !== 3) return { ok: false, error: "token is not a JWT" };
    const [h, p, s] = parts as [string, string, string];
    const header = b64urlJson(h);
    const payload = b64urlJson(p);
    const signature = b64urlBytes(s);
    if (!header || !payload || !signature) return { ok: false, error: "token is malformed" };
    if (header.alg !== "RS256") return { ok: false, error: `unsupported token algorithm ${String(header.alg)}` };
    if (typeof header.kid !== "string" || !header.kid) return { ok: false, error: "token has no key id" };
    if (signature.byteLength === 0) return { ok: false, error: "token has no signature" };

    let key: CryptoKey | null;
    try {
      key = await this.keyFor(header.kid);
    } catch (err) {
      return { ok: false, error: `could not fetch Cloudflare Access signing keys: ${describe(err)}` };
    }
    if (!key) return { ok: false, error: "token is signed with an unknown key" };

    const signed = new TextEncoder().encode(`${h}.${p}`);
    let valid = false;
    try {
      valid = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, signature, signed);
    } catch {
      valid = false;
    }
    if (!valid) return { ok: false, error: "token signature is invalid" };

    const nowSec = Math.floor(this.now() / 1000);
    if (payload.iss !== this.issuer) return { ok: false, error: "token issuer does not match the team domain" };
    const aud = payload.aud;
    const audiences = Array.isArray(aud) ? aud : [aud];
    if (!audiences.includes(this.audience)) return { ok: false, error: "token audience does not match" };
    if (typeof payload.exp !== "number") return { ok: false, error: "token has no expiry" };
    if (payload.exp + this.skewSec <= nowSec) return { ok: false, error: "token has expired" };
    if (typeof payload.nbf === "number" && payload.nbf - this.skewSec > nowSec) {
      return { ok: false, error: "token is not valid yet" };
    }
    const value = {
      ok: true as const,
      email: typeof payload.email === "string" ? payload.email : null,
      subject: typeof payload.sub === "string" ? payload.sub : null,
      expiresAt: payload.exp * 1000,
    };
    this.remember(token, value);
    return value;
  }
}

let defaults: VerifierOptions = {};
let current: AccessVerifier | null = null;

export function setAccessVerifierDefaults(opts: VerifierOptions): void {
  defaults = opts;
  current = null;
}

export function resetAccessVerifier(): void {
  current = null;
}

export function accessVerifierFor(config: AccessConfig, fresh = false): AccessVerifier {
  if (fresh) return new AccessVerifier(config, defaults);
  if (!current || current.teamDomain !== config.teamDomain || current.audience !== config.audience) {
    current = new AccessVerifier(config, defaults);
  }
  return current;
}

export function verifyAccessToken(config: AccessConfig, token: string | null | undefined): Promise<AccessVerification> {
  return accessVerifierFor(config).verify(token);
}
