import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, writeSync } from "node:fs";
import { join } from "node:path";
import { env } from "../env";

export type JournalKind = "swap" | "fence";

const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;

export function journalDir(): string {
  return join(env.dataDir, "journal");
}

function pathFor(kind: JournalKind, id: string): string {
  if (!SAFE_ID.test(id)) throw new Error(`invalid journal id: ${id}`);
  return join(journalDir(), `${kind}-${id}.json`);
}

function fsyncDir(dir: string): void {
  let fd: number | null = null;
  try {
    fd = openSync(dir, "r");
    fsyncSync(fd);
  } catch {
    return;
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

export function writeJournal(kind: JournalKind, id: string, data: unknown): void {
  const dir = journalDir();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const target = pathFor(kind, id);
  const tmp = `${target}.tmp`;
  const fd = openSync(tmp, "w", 0o600);
  try {
    const bytes = Buffer.from(JSON.stringify(data));
    let written = 0;
    while (written < bytes.length) written += writeSync(fd, bytes, written, bytes.length - written);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, target);
  fsyncDir(dir);
}

export function removeJournal(kind: JournalKind, id: string): void {
  const target = pathFor(kind, id);
  if (!existsSync(target)) return;
  rmSync(target, { force: true });
  fsyncDir(journalDir());
}

export function readJournals<T>(kind: JournalKind): { id: string; data: T | null; error?: string }[] {
  const dir = journalDir();
  if (!existsSync(dir)) return [];
  const out: { id: string; data: T | null; error?: string }[] = [];
  for (const name of readdirSync(dir).sort()) {
    if (!name.startsWith(`${kind}-`) || !name.endsWith(".json")) continue;
    const id = name.slice(kind.length + 1, -".json".length);
    if (!SAFE_ID.test(id)) continue;
    try {
      out.push({ id, data: JSON.parse(readFileSync(join(dir, name), "utf8")) as T });
    } catch (err) {
      out.push({ id, data: null, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return out;
}
