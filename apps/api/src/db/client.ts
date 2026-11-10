import { Database } from "bun:sqlite";
import { env, ensureDataDirs } from "../env";

let current: Database | null = null;
let closed = false;

function open(): Database {
  ensureDataDirs();
  const d = new Database(env.sqlitePath, { create: true });
  d.exec("PRAGMA journal_mode = WAL;");
  d.exec("PRAGMA foreign_keys = ON;");
  d.exec("PRAGMA busy_timeout = 5000;");
  return d;
}

function active(): Database {
  if (closed) throw new Error("metadata store is closed");
  if (!current) current = open();
  return current;
}

export const db = new Proxy({} as Database, {
  get(_target, prop) {
    const target = active();
    const value = (target as unknown as Record<string | symbol, unknown>)[prop as string];
    return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
  },
});

export function closeDb(): void {
  if (current) {
    try {
      current.close();
    } catch {}
  }
  current = null;
  closed = true;
}

export function reopenDb(): void {
  if (current) {
    try {
      current.close();
    } catch {}
  }
  closed = false;
  current = open();
}
