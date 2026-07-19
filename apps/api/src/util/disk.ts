import { statfs } from "node:fs/promises";
import { env } from "../env";

let cache: { dir: string; at: number; value: number | null } | null = null;

export async function dataDirFreeBytes(ttlMs = 10_000): Promise<number | null> {
  const dir = env.dataDir;
  const now = Date.now();
  if (cache && cache.dir === dir && now - cache.at < ttlMs) return cache.value;
  let value: number | null = null;
  try {
    const s = await statfs(dir);
    value = Number(s.bavail) * Number(s.bsize);
  } catch {
    value = null;
  }
  cache = { dir, at: now, value };
  return value;
}
