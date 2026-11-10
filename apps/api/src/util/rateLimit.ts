import type { Context, MiddlewareHandler } from "hono";

type Bucket = { count: number; resetAt: number };

export function rateLimit(opts: {
  windowMs: number;
  max: number;
  key: (c: Context) => Promise<string | null> | string | null;
}): MiddlewareHandler {
  const buckets = new Map<string, Bucket>();
  return async (c, next) => {
    const key = await opts.key(c);
    if (key === null) return next();
    const now = Date.now();
    if (buckets.size > 10_000) {
      for (const [k, b] of buckets) {
        if (now >= b.resetAt) buckets.delete(k);
      }
    }
    let bucket = buckets.get(key);
    if (!bucket || now >= bucket.resetAt) {
      bucket = { count: 0, resetAt: now + opts.windowMs };
      buckets.set(key, bucket);
    }
    bucket.count += 1;
    if (bucket.count > opts.max) {
      const retryAfter = Math.max(1, Math.ceil((bucket.resetAt - now) / 1000));
      return c.json(
        { error: "too many attempts, try again later" },
        429,
        { "Retry-After": String(retryAfter) },
      );
    }
    return next();
  };
}

export interface FailureLimiter {
  blockedFor(key: string): number;
  fail(key: string): void;
  clear(key: string): void;
  reset(): void;
}

export function failureLimiter(opts: { windowMs: number; max: number }): FailureLimiter {
  const buckets = new Map<string, Bucket>();
  const current = (key: string, now: number): Bucket | null => {
    const bucket = buckets.get(key);
    if (!bucket) return null;
    if (now >= bucket.resetAt) {
      buckets.delete(key);
      return null;
    }
    return bucket;
  };
  return {
    blockedFor(key) {
      const now = Date.now();
      const bucket = current(key, now);
      if (!bucket || bucket.count < opts.max) return 0;
      return Math.max(1, Math.ceil((bucket.resetAt - now) / 1000));
    },
    fail(key) {
      const now = Date.now();
      if (buckets.size > 10_000) {
        for (const [k, b] of buckets) {
          if (now >= b.resetAt) buckets.delete(k);
        }
      }
      const bucket = current(key, now) ?? { count: 0, resetAt: now + opts.windowMs };
      bucket.count += 1;
      buckets.set(key, bucket);
    },
    clear(key) {
      buckets.delete(key);
    },
    reset() {
      buckets.clear();
    },
  };
}

export { clientIp } from "../network/request";

export async function bodyEmail(c: Context): Promise<string | null> {
  try {
    const body = JSON.parse(await c.req.text()) as { email?: unknown } | null;
    if (!body || typeof body.email !== "string") return null;
    const email = body.email.toLowerCase().trim();
    return email || null;
  } catch {
    return null;
  }
}
