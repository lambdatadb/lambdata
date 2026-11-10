import type { QueryResult } from "@lambdata/shared";
import { HTTPException } from "hono/http-exception";
import mysql, { type PoolConnection, type RowDataPacket } from "mysql2/promise";
import { env } from "../env";
import { databases } from "../db/queries";
import { readonlyAccounts, type ReadonlyAccount } from "../db/queries/readonlyAccounts";
import { decryptSecret, encryptSecret } from "../util/crypto";
import { generatePassword } from "../util/credentials";
import { randAlphaNum } from "../util/id";
import { escapeHostPattern, isSafeIdent } from "../util/ident";
import { localConnectHost, withRootConnection } from "./controller";
import { QueryTimeoutError, escapeGrantPattern, runSessionQuery } from "./manager";

export const READONLY_USER_PREFIX = "ldr_";
const READONLY_USER_PATTERN = /^ldr_[a-z0-9_]+_[a-z0-9]{8}$/;
const MAX_USER_LENGTH = 32;
const TAIL_LENGTH = 8;
const GRANTED_DB_PRIVILEGES = new Set(["Select_priv", "Show_view_priv"]);
const PRIVILEGE_ERRNOS = new Set([1044, 1045, 1142, 1143, 1227, 1792]);
const ER_PROCACCESS_DENIED = 1370;
const LOGIN_ERRNOS = new Set([1044, 1045, 1698]);

export type ReadonlyAccountOutcome = "created" | "repaired" | "unchanged";

export class ViewerAccessUnavailableError extends HTTPException {
  constructor(message = "read-only access for this database is not available yet; restart LambData to retry setting it up") {
    super(503, { message });
    this.name = "ViewerAccessUnavailableError";
  }
}

export class ViewerQueryDeniedError extends HTTPException {
  readonly errno: number;

  constructor(message: string, errno: number) {
    super(403, { message });
    this.name = "ViewerQueryDeniedError";
    this.errno = errno;
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function readonlyAccountHost(): string {
  const host = localConnectHost();
  return escapeHostPattern(host === "localhost" ? "127.0.0.1" : host);
}

function readonlyUserName(schema: string, isTaken: (user: string) => boolean): string {
  const room = MAX_USER_LENGTH - READONLY_USER_PREFIX.length - 1 - TAIL_LENGTH;
  const middle =
    schema
      .toLowerCase()
      .replace(/[^a-z0-9_]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, room)
      .replace(/_+$/, "") || "db";
  for (let attempt = 0; attempt < 20; attempt++) {
    const candidate = `${READONLY_USER_PREFIX}${middle}_${randAlphaNum(TAIL_LENGTH)}`;
    if (!isTaken(candidate)) return candidate;
  }
  throw new Error("could not allocate a unique read-only account name");
}

async function mariadbUsers(): Promise<Set<string>> {
  return withRootConnection(async (c) => {
    const [rows] = await c.query<RowDataPacket[]>("SELECT DISTINCT User AS name FROM mysql.user");
    return new Set(rows.map((r) => String(r.name)));
  });
}

async function privilegesAreExact(c: PoolConnection, user: string, host: string, schema: string): Promise<boolean> {
  const [accounts] = await c.query<RowDataPacket[]>("SELECT * FROM mysql.user WHERE User = ? AND Host = ?", [user, host]);
  if (accounts.length !== 1) return false;
  if (Object.entries(accounts[0]!).some(([k, v]) => k.endsWith("_priv") && v !== "N")) return false;
  const [dbRows] = await c.query<RowDataPacket[]>("SELECT * FROM mysql.db WHERE User = ? AND Host = ?", [user, host]);
  if (dbRows.length !== 1 || dbRows[0]!.Db !== escapeGrantPattern(schema)) return false;
  for (const [k, v] of Object.entries(dbRows[0]!)) {
    if (k.endsWith("_priv") && v !== (GRANTED_DB_PRIVILEGES.has(k) ? "Y" : "N")) return false;
  }
  for (const table of ["tables_priv", "columns_priv", "procs_priv", "roles_mapping"]) {
    const [rows] = await c.query<RowDataPacket[]>(
      `SELECT COUNT(*) AS n FROM mysql.${table} WHERE User = ? AND Host = ?`,
      [user, host],
    );
    if (Number(rows[0]?.n ?? 0) > 0) return false;
  }
  return true;
}

async function canLogin(host: string, user: string, password: string, schema: string): Promise<boolean> {
  try {
    const conn = await mysql.createConnection({
      host,
      port: env.mariadbPort,
      user,
      password,
      database: schema,
      connectTimeout: 3000,
    });
    await conn.end().catch(() => conn.destroy());
    return true;
  } catch {
    return false;
  }
}

async function recreateAccount(account: ReadonlyAccount, host: string, password: string, schema: string): Promise<void> {
  await withRootConnection(async (c) => {
    await c.query("DROP USER IF EXISTS ?@?", [account.mysqlUser, escapeHostPattern(account.mysqlHost)]);
    await c.query("DROP USER IF EXISTS ?@?", [account.mysqlUser, host]);
    await c.query("CREATE USER ?@? IDENTIFIED BY ?", [account.mysqlUser, host, password]);
    await c.query(`GRANT SELECT, SHOW VIEW ON \`${escapeGrantPattern(schema)}\`.* TO ?@?`, [account.mysqlUser, host]);
  });
}

export async function ensureReadonlyAccount(databaseId: string): Promise<ReadonlyAccountOutcome> {
  const database = databases.byId(databaseId);
  if (!database) throw new Error(`database ${databaseId} not found`);
  if (!isSafeIdent(database.name)) throw new Error("schema name is not a safe identifier");
  const host = readonlyAccountHost();
  let account = readonlyAccounts.byDatabaseId(databaseId);
  let created = false;
  if (!account) {
    const existing = await mariadbUsers();
    const user = readonlyUserName(database.name, (u) => existing.has(u) || readonlyAccounts.userExists(u));
    readonlyAccounts.insert({
      databaseId,
      mysqlUser: user,
      mysqlHost: host,
      passwordEnc: await encryptSecret(generatePassword()),
    });
    account = readonlyAccounts.byDatabaseId(databaseId)!;
    created = true;
  }
  const password = await decryptSecret(account.passwordEnc);
  const healthy =
    !created &&
    account.mysqlHost === host &&
    (await withRootConnection((c) => privilegesAreExact(c, account.mysqlUser, host, database.name))) &&
    (await canLogin(host, account.mysqlUser, password, database.name));
  if (healthy) {
    if (account.ready) return "unchanged";
    readonlyAccounts.setReady(databaseId, true);
    return "repaired";
  }
  readonlyAccounts.setReady(databaseId, false);
  await recreateAccount(account, host, password, database.name);
  readonlyAccounts.setHost(databaseId, host);
  if (!(await canLogin(host, account.mysqlUser, password, database.name))) {
    throw new Error("the read-only account was created but cannot log in");
  }
  readonlyAccounts.setReady(databaseId, true);
  return created ? "created" : "repaired";
}

export async function dropReadonlyAccount(databaseId: string): Promise<void> {
  const account = readonlyAccounts.byDatabaseId(databaseId);
  if (!account) return;
  await withRootConnection(async (c) => {
    for (const host of new Set([account.mysqlHost, readonlyAccountHost()])) {
      await c.query("DROP USER IF EXISTS ?@?", [account.mysqlUser, escapeHostPattern(host)]);
    }
  });
  readonlyAccounts.delete(databaseId);
}

export async function reconcileReadonlyAccounts(): Promise<{
  created: number;
  repaired: number;
  dropped: number;
  warnings: string[];
}> {
  const result = { created: 0, repaired: 0, dropped: 0, warnings: [] as string[] };
  for (const database of databases.list()) {
    if (databases.provisionStateOf(database.id) === "deleting") continue;
    try {
      const outcome = await ensureReadonlyAccount(database.id);
      if (outcome === "created") result.created++;
      if (outcome === "repaired") result.repaired++;
    } catch (err) {
      if (readonlyAccounts.byDatabaseId(database.id)) readonlyAccounts.setReady(database.id, false);
      result.warnings.push(`${database.name}: ${errorMessage(err)}`);
    }
  }
  try {
    const known = new Set(readonlyAccounts.list().map((a) => a.mysqlUser));
    await withRootConnection(async (c) => {
      const [rows] = await c.query<RowDataPacket[]>("SELECT User AS user, Host AS host FROM mysql.user WHERE User LIKE 'ldr\\_%'");
      for (const r of rows) {
        const user = String(r.user);
        if (!READONLY_USER_PATTERN.test(user) || known.has(user)) continue;
        await c.query("DROP USER IF EXISTS ?@?", [user, String(r.host)]);
        result.dropped++;
      }
    });
  } catch (err) {
    result.warnings.push(`could not remove leftover read-only accounts: ${errorMessage(err)}`);
  }
  return result;
}

function hideAccount(message: string, user: string): string {
  return message.replace(new RegExp(`'${user}'@'[^']*'`, "g"), "the viewer account").replaceAll(user, "the viewer account");
}

function translateViewerError(err: unknown, user: string): unknown {
  if (err instanceof QueryTimeoutError) return err;
  const e = err as { errno?: number; sqlMessage?: string; message?: string; phase?: string } | null;
  const errno = e?.errno;
  const raw = hideAccount(e?.sqlMessage ?? e?.message ?? String(err), user);
  if (e?.phase === "connect") {
    if (errno !== undefined && LOGIN_ERRNOS.has(errno)) {
      return new ViewerAccessUnavailableError(
        "read-only access for this database could not log in; restart LambData to repair it",
      );
    }
    return err;
  }
  if (errno === ER_PROCACCESS_DENIED) {
    return new ViewerQueryDeniedError(
      "viewers cannot call stored functions or procedures: read-only access has no EXECUTE right on this database",
      errno,
    );
  }
  if (errno !== undefined && PRIVILEGE_ERRNOS.has(errno)) {
    return new ViewerQueryDeniedError(`viewers have read-only access: ${raw}`, errno);
  }
  if (e && typeof e === "object" && typeof e.message === "string") {
    try {
      Object.assign(e, { message: hideAccount(e.message, user), sqlMessage: e.sqlMessage && hideAccount(e.sqlMessage, user) });
    } catch {
      return err;
    }
  }
  return err;
}

export async function executeViewerQuery(p: { databaseId: string; sql: string; timeoutMs?: number }): Promise<QueryResult> {
  const database = databases.byId(p.databaseId);
  if (!database) throw new HTTPException(404, { message: "database not found" });
  const account = readonlyAccounts.byDatabaseId(p.databaseId);
  if (!account || !account.ready) throw new ViewerAccessUnavailableError();
  const password = await decryptSecret(account.passwordEnc);
  try {
    return await runSessionQuery({
      host: account.mysqlHost,
      user: account.mysqlUser,
      password,
      schema: database.name,
      sql: p.sql,
      readOnly: true,
      timeoutMs: p.timeoutMs,
    });
  } catch (err) {
    throw translateViewerError(err, account.mysqlUser);
  }
}
