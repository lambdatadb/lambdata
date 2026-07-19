import { Database } from "bun:sqlite";
import { env, ensureDataDirs } from "../env";

let current: Database;

function open(): Database {
  ensureDataDirs();
  const d = new Database(env.sqlitePath, { create: true });
  d.exec("PRAGMA journal_mode = WAL;");
  d.exec("PRAGMA foreign_keys = ON;");
  d.exec("PRAGMA busy_timeout = 5000;");
  return d;
}

current = open();

// Proxy so all imports of `db` route to the currently-open Database, even
// after it's swapped during a data-dir migration.
export const db = new Proxy({} as Database, {
  get(_target, prop) {
    const value = (current as unknown as Record<string | symbol, unknown>)[prop as string];
    return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(current) : value;
  },
});

export function closeDb(): void {
  try {
    current.close();
  } catch {
    // Already closed.
  }
}

export function reopenDb(): void {
  current = open();
}
