import { Database, constants } from "bun:sqlite";
import { resolve as resolvePath } from "node:path";

export const SQLITE_READ_ONLY_URI_FLAGS = constants.SQLITE_OPEN_READONLY | constants.SQLITE_OPEN_URI;

export function sqliteReadOnlyUri(path: string): string {
  const encoded = resolvePath(path).replace(/[%?#]/g, (ch) => `%${ch.charCodeAt(0).toString(16).padStart(2, "0")}`);
  return `file://${encoded}?mode=ro&immutable=1`;
}

type SafeIntegerToggle = { safeIntegers?: (enabled: boolean) => unknown };

function statementsToggleSafeIntegers(db: Database): boolean {
  return typeof (db.query("SELECT 1") as unknown as SafeIntegerToggle).safeIntegers === "function";
}

function withSafeIntegers(db: Database): void {
  const query = db.query.bind(db);
  const prepare = db.prepare.bind(db);
  const safe = <T>(stmt: T): T => {
    (stmt as SafeIntegerToggle).safeIntegers!(true);
    return stmt;
  };
  db.query = ((sql: string) => safe(query(sql))) as Database["query"];
  db.prepare = ((sql: string, params?: never) => safe(prepare(sql, params))) as Database["prepare"];
}

function openWithOptions(uri: string): Database {
  try {
    return new Database(uri, { readonly: true, safeIntegers: true });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`${reason}; this Bun runtime (${Bun.version}) cannot open SQLite files read-only on this system, upgrade Bun to 1.4 or later`);
  }
}

export function openSqliteReadOnly(path: string): Database {
  const uri = sqliteReadOnlyUri(path);
  let db = new Database(uri, SQLITE_READ_ONLY_URI_FLAGS);
  try {
    if (statementsToggleSafeIntegers(db)) {
      withSafeIntegers(db);
    } else {
      db.close();
      db = openWithOptions(uri);
    }
    db.exec("PRAGMA trusted_schema = OFF");
    db.exec("PRAGMA cell_size_check = ON");
    db.exec("PRAGMA mmap_size = 0");
    db.exec("PRAGMA query_only = ON");
  } catch (err) {
    db.close();
    throw err;
  }
  return db;
}

export function quoteSqliteIdent(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

export function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}
