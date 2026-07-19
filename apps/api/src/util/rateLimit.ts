import type { Context, MiddlewareHandler } from "hono";
import { getConnInfo } from "hono/bun";

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

export function clientIp(c: Context): string {
  try {
    return getConnInfo(c).remote.address ?? "local";
  } catch {
    return "local";
  }
}

export async function bodyEmail(c: Context): Promise<string | null> {
  try {
    const body = (await c.req.json()) as { email?: string };
    if (typeof body.email !== "string") return null;
    const email = body.email.toLowerCase().trim();
    return email || null;
  } catch {
    return null;
  }
}
