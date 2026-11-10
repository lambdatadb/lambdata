import type { QueryResult } from "@lambdata/shared";
import mysql from "mysql2/promise";
import { env } from "../env";
import { databases } from "../db/queries";
import { escapeHostPattern, isSafeIdent, quoteIdent } from "../util/ident";
import { runExclusive } from "../jobs";
import { applyCodeRecords, captureCodeRecords, objectsDefinedBy, type CodeRecord } from "./codeObjects";
import { localConnectHost, openAdminConnection, withRootConnection } from "./controller";
import { escapeGrantPattern, grantTarget } from "./grantPattern";
import { sanitizeMariaDbMessage } from "./messages";

export { escapeGrantPattern };

export const USER_QUERY_TIMEOUT_MS = 30_000;
const CLIENT_TIMEOUT_GRACE_MS = 2_000;
const ER_STATEMENT_TIMEOUT = 1969;

export class QueryTimeoutError extends Error {
  readonly timeoutMs: number;

  constructor(timeoutMs: number) {
    super(`Query cancelled: it ran longer than the ${formatSeconds(timeoutMs)} limit`);
    this.name = "QueryTimeoutError";
    this.timeoutMs = timeoutMs;
  }
}

function formatSeconds(ms: number): string {
  const s = ms / 1000;
  return `${Number.isInteger(s) ? s : s.toFixed(1)}s`;
}

function errorMessage(err: unknown): string {
  return sanitizeMariaDbMessage(err instanceof Error ? err.message : String(err));
}


async function accountExists(c: mysql.PoolConnection, user: string, host: string): Promise<boolean> {
  const [rows] = await c.query<mysql.RowDataPacket[]>(
    `SELECT COUNT(*) AS n FROM mysql.user WHERE User = ? AND Host = ?`,
    [user, host],
  );
  return Number(rows[0]?.n ?? 0) > 0;
}

async function hasDbGrant(c: mysql.PoolConnection, user: string, host: string, pattern: string): Promise<boolean> {
  const [rows] = await c.query<mysql.RowDataPacket[]>(
    `SELECT COUNT(*) AS n FROM mysql.db WHERE User = ? AND Host = ? AND Db = ?`,
    [user, host, pattern],
  );
  return Number(rows[0]?.n ?? 0) > 0;
}

async function grantEscaped(
  c: mysql.PoolConnection,
  user: string,
  host: string,
  schema: string,
  afterGrant?: () => Promise<void> | void,
): Promise<boolean> {
  const escaped = escapeGrantPattern(schema);
  let changed = false;
  if (!(await hasDbGrant(c, user, host, escaped))) {
    await c.query(`GRANT ALL PRIVILEGES ON ${grantTarget(schema)} TO ?@?`, [user, host]);
    changed = true;
  }
  if (escaped !== schema && (await hasDbGrant(c, user, host, schema))) {
    await afterGrant?.();
    await c.query(`REVOKE ALL PRIVILEGES ON ${quoteIdent(schema)}.* FROM ?@?`, [user, host]);
    changed = true;
  }
  return changed;
}

export async function grantSchemaAccess(user: string, host: string, schema: string): Promise<void> {
  const h = escapeHostPattern(host);
  await withRootConnection(async (c) => {
    await grantEscaped(c, user, h, schema);
  });
}

export async function revokeSchemaAccess(user: string, host: string, schema: string): Promise<void> {
  const h = escapeHostPattern(host);
  const escaped = escapeGrantPattern(schema);
  await withRootConnection(async (c) => {
    if (await hasDbGrant(c, user, h, escaped)) {
      await c.query(`REVOKE ALL PRIVILEGES ON ${grantTarget(schema)} FROM ?@?`, [user, h]);
    }
    if (escaped !== schema && (await hasDbGrant(c, user, h, schema))) {
      await c.query(`REVOKE ALL PRIVILEGES ON ${quoteIdent(schema)}.* FROM ?@?`, [user, h]);
    }
  });
}

export async function reconcileDatabaseGrants(
  hooks: { afterGrant?: (schema: string) => Promise<void> | void } = {},
): Promise<{ fixed: number; warnings: string[] }> {
  let fixed = 0;
  const warnings: string[] = [];
  for (const row of databases.list()) {
    try {
      if (!isSafeIdent(row.name)) throw new Error("schema name is not a safe identifier");
      const escaped = escapeGrantPattern(row.name);
      if (escaped === row.name) continue;
      const changed = await withRootConnection(async (c) => {
        const [grants] = await c.query<mysql.RowDataPacket[]>(
          `SELECT Host AS host FROM mysql.db WHERE User = ? AND Db = ? ORDER BY Host`,
          [row.mysqlUser, row.name],
        );
        let any = false;
        for (const g of grants) {
          const host = String(g.host);
          if (await grantEscaped(c, row.mysqlUser, host, row.name, () => hooks.afterGrant?.(row.name))) any = true;
        }
        return any;
      });
      if (changed) fixed++;
    } catch (err) {
      warnings.push(`${row.name}: ${errorMessage(err)}`);
    }
  }
  return { fixed, warnings };
}

export async function createDatabaseAndUser(p: {
  schema: string;
  user: string;
  password: string;
  connectionsFrom: string;
}): Promise<void> {
  const host = escapeHostPattern(p.connectionsFrom);
  const dbIdent = quoteIdent(p.schema);
  await withRootConnection(async (c) => {
    await c.query(`CREATE DATABASE IF NOT EXISTS ${dbIdent} CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
    await c.query(`CREATE USER IF NOT EXISTS ?@? IDENTIFIED BY ?`, [p.user, host, p.password]);
    await c.query(`ALTER USER ?@? IDENTIFIED BY ?`, [p.user, host, p.password]);
    await grantEscaped(c, p.user, host, p.schema);
    await c.query("FLUSH PRIVILEGES");
  });
}

export async function rotatePassword(p: { user: string; connectionsFrom: string; newPassword: string }): Promise<void> {
  const host = escapeHostPattern(p.connectionsFrom);
  await withRootConnection(async (c) => {
    await c.query(`ALTER USER ?@? IDENTIFIED BY ?`, [p.user, host, p.newPassword]);
    await c.query("FLUSH PRIVILEGES");
  });
}

async function recordsToMove(schema: string, user: string, newHost: string): Promise<CodeRecord[]> {
  if ((await objectsDefinedBy(schema, user, newHost)) === 0) return [];
  const conn = await openAdminConnection();
  try {
    const all = await captureCodeRecords(conn, schema);
    return all.filter((r) => r.definer?.user === user && r.definer.host.toLowerCase() !== newHost.toLowerCase());
  } finally {
    await conn.end().catch(() => conn.destroy());
  }
}

export async function updateAllowedHost(p: {
  user: string;
  oldHost: string;
  newHost: string;
  password: string;
  schema: string;
  databaseId?: string;
}): Promise<{ warnings: string[] }> {
  const oldH = escapeHostPattern(p.oldHost);
  const newH = escapeHostPattern(p.newHost);
  quoteIdent(p.schema);
  const databaseId = p.databaseId ?? databases.byName(p.schema)?.id ?? null;
  const work = async (): Promise<{ warnings: string[] }> => {
    const warnings: string[] = [];
    let moving: CodeRecord[] = [];
    try {
      moving = await recordsToMove(p.schema, p.user, newH);
    } catch (err) {
      warnings.push(`could not read the code objects defined by ${p.user}: ${errorMessage(err)}`);
    }

    await withRootConnection(async (c) => {
      const oldExists = oldH !== newH && (await accountExists(c, p.user, oldH));
      const newExists = await accountExists(c, p.user, newH);
      if (oldExists && !newExists) {
        await c.query(`RENAME USER ?@? TO ?@?`, [p.user, oldH, p.user, newH]);
      } else if (!newExists) {
        await c.query(`CREATE USER ?@? IDENTIFIED BY ?`, [p.user, newH, p.password]);
      }
      await c.query(`ALTER USER ?@? IDENTIFIED BY ?`, [p.user, newH, p.password]);
      await grantEscaped(c, p.user, newH, p.schema);
      if (oldExists && newExists) {
        await c.query(`DROP USER IF EXISTS ?@?`, [p.user, oldH]);
      }
      await c.query("FLUSH PRIVILEGES");
    });

    if (moving.length > 0) {
      try {
        const result = await applyCodeRecords(p.schema, moving, { definers: { account: { user: p.user, host: newH }, keep: "account" } });
        const generic = new Set(result.failures.map((f) => `could not re-create ${f.kind.toLowerCase()} ${f.name}: ${f.explanation ?? f.error}`));
        warnings.push(...result.warnings.filter((w) => !generic.has(w)));
        for (const f of result.failures) {
          warnings.push(
            `${f.kind.toLowerCase()} ${f.name} could not be re-created for ${p.user}@${newH} and still names the old host ${p.user}@${oldH}, so it will not work until it is re-created: ${f.error.replace(/ (?:to|for) user '[^']*'@'[^']*'/g, "")}`,
          );
        }
      } catch (err) {
        warnings.push(`views, routines, triggers or events defined by ${p.user} still name the old host: ${errorMessage(err)}`);
      }
    }
    return { warnings };
  };
  return databaseId ? runExclusive(databaseId, work) : work();
}

export async function dropDatabaseAndUser(p: { schema: string; user: string; connectionsFrom: string }): Promise<void> {
  const dbIdent = quoteIdent(p.schema);
  const host = escapeHostPattern(p.connectionsFrom);
  await withRootConnection(async (c) => {
    await c.query(`DROP DATABASE IF EXISTS ${dbIdent}`);
    await c.query(`DROP USER IF EXISTS ?@?`, [p.user, host]);
    await c.query("FLUSH PRIVILEGES");
  });
}

function errno(err: unknown): number | undefined {
  return (err as { errno?: number } | null)?.errno;
}

function errCode(err: unknown): string | undefined {
  return (err as { code?: string } | null)?.code;
}

async function killQuery(threadId: number | null | undefined): Promise<void> {
  if (!threadId) return;
  await withRootConnection(async (c) => {
    await c.query(`KILL QUERY ?`, [threadId]);
  }).catch(() => {});
}

export interface SessionQuery {
  host: string;
  user: string;
  password: string;
  schema: string;
  sql: string;
  readOnly?: boolean;
  timeoutMs?: number;
}

export async function runSessionQuery(p: SessionQuery): Promise<QueryResult> {
  const timeoutMs = p.timeoutMs ?? USER_QUERY_TIMEOUT_MS;
  const start = performance.now();
  let conn: mysql.Connection;
  try {
    conn = await mysql.createConnection({
      host: p.host,
      port: env.mariadbPort,
      user: p.user,
      password: p.password,
      database: p.schema,
      rowsAsArray: true,
      multipleStatements: false,
      dateStrings: true,
      supportBigNumbers: true,
      connectTimeout: 5000,
    });
  } catch (err) {
    if (err && typeof err === "object") Object.assign(err, { phase: "connect" });
    throw err;
  }
  let healthy = true;
  try {
    await conn.query(`SET SESSION max_statement_time = ?`, [timeoutMs / 1000]);
    if (p.readOnly) await conn.query("SET SESSION TRANSACTION READ ONLY");
    let rows: unknown;
    let fields: unknown;
    try {
      [rows, fields] = await conn.query({ sql: p.sql, timeout: timeoutMs + CLIENT_TIMEOUT_GRACE_MS });
    } catch (err) {
      if (errno(err) === ER_STATEMENT_TIMEOUT) throw new QueryTimeoutError(timeoutMs);
      if (errCode(err) === "PROTOCOL_SEQUENCE_TIMEOUT") {
        healthy = false;
        await killQuery(conn.threadId);
        throw new QueryTimeoutError(timeoutMs);
      }
      throw err;
    }
    const durationMs = performance.now() - start;
    if (Array.isArray(rows) && Array.isArray(fields)) {
      return {
        columns: (fields as { name: string }[]).map((f) => f.name),
        rows: rows as unknown[][],
        rowCount: rows.length,
        durationMs,
      };
    }
    const ok = rows as { affectedRows?: number };
    return {
      columns: ["affectedRows"],
      rows: [[ok.affectedRows ?? 0]],
      rowCount: 1,
      durationMs,
    };
  } finally {
    if (healthy) await conn.end().catch(() => conn.destroy());
    else conn.destroy();
  }
}

export async function executeUserQuery(p: {
  schema: string;
  user: string;
  password: string;
  sql: string;
  readOnly?: boolean;
  timeoutMs?: number;
}): Promise<QueryResult> {
  return runSessionQuery({ ...p, host: localConnectHost() });
}

export async function getDatabaseMetrics(schema: string): Promise<{
  sizeBytes: number | null;
  tableCount: number | null;
  connectionCount: number | null;
  rowCount: number | null;
}> {
  return withRootConnection(async (c) => {
    const [sizeRows] = await c.query<mysql.RowDataPacket[]>(
      `SELECT COALESCE(SUM(data_length + index_length), 0) AS size_bytes,
              COUNT(*) AS table_count,
              COALESCE(SUM(table_rows), 0) AS row_count
       FROM information_schema.tables WHERE table_schema = ?`,
      [schema],
    );
    const [connRows] = await c.query<mysql.RowDataPacket[]>(
      `SELECT COUNT(*) AS n FROM information_schema.processlist WHERE db = ?`,
      [schema],
    );
    return {
      sizeBytes: Number(sizeRows[0]?.size_bytes ?? 0),
      tableCount: Number(sizeRows[0]?.table_count ?? 0),
      connectionCount: Number(connRows[0]?.n ?? 0),
      rowCount: Number(sizeRows[0]?.row_count ?? 0),
    };
  });
}

export async function getTableBreakdown(
  schema: string,
): Promise<Array<{ name: string; rowCount: number; sizeBytes: number; avgRowBytes: number }>> {
  return withRootConnection(async (c) => {
    const [rows] = await c.query<mysql.RowDataPacket[]>(
      `SELECT table_name              AS name,
              COALESCE(table_rows, 0) AS row_count,
              COALESCE(data_length + index_length, 0) AS size_bytes,
              COALESCE(avg_row_length, 0) AS avg_row_bytes
         FROM information_schema.tables
        WHERE table_schema = ?
          AND table_type = 'BASE TABLE'
        ORDER BY size_bytes DESC`,
      [schema],
    );
    return rows.map((r) => ({
      name: String(r.name),
      rowCount: Number(r.row_count ?? 0),
      sizeBytes: Number(r.size_bytes ?? 0),
      avgRowBytes: Number(r.avg_row_bytes ?? 0),
    }));
  });
}
