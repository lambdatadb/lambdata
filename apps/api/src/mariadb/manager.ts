import type { QueryResult } from "@kilndb/shared";
import mysql from "mysql2/promise";
import { env } from "../env";
import { withRootConnection } from "./controller";

function quoteIdent(s: string): string {
  if (!/^[a-z0-9_]+$/i.test(s)) {
    throw new Error(`unsafe identifier: ${s}`);
  }
  return "`" + s + "`";
}

function escapeHostPattern(host: string): string {
  if (!/^[a-z0-9%._:/-]+$/i.test(host)) {
    throw new Error(`unsafe host pattern: ${host}`);
  }
  return host;
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
    await c.query(
      `CREATE DATABASE IF NOT EXISTS ${dbIdent} CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
    );
    await c.query(`CREATE USER IF NOT EXISTS ?@? IDENTIFIED BY ?`, [p.user, host, p.password]);
    await c.query(`ALTER USER ?@? IDENTIFIED BY ?`, [p.user, host, p.password]);
    await c.query(`GRANT ALL PRIVILEGES ON ${dbIdent}.* TO ?@?`, [p.user, host]);
    await c.query("FLUSH PRIVILEGES");
  });
}

export async function rotatePassword(p: {
  user: string;
  connectionsFrom: string;
  newPassword: string;
}): Promise<void> {
  const host = escapeHostPattern(p.connectionsFrom);
  await withRootConnection(async (c) => {
    await c.query(`ALTER USER ?@? IDENTIFIED BY ?`, [p.user, host, p.newPassword]);
    await c.query("FLUSH PRIVILEGES");
  });
}

export async function updateAllowedHost(p: {
  user: string;
  oldHost: string;
  newHost: string;
  password: string;
  schema: string;
}): Promise<void> {
  const oldH = escapeHostPattern(p.oldHost);
  const newH = escapeHostPattern(p.newHost);
  const dbIdent = quoteIdent(p.schema);
  await withRootConnection(async (c) => {
    await c.query(`DROP USER IF EXISTS ?@?`, [p.user, oldH]);
    await c.query(`CREATE USER ?@? IDENTIFIED BY ?`, [p.user, newH, p.password]);
    await c.query(`GRANT ALL PRIVILEGES ON ${dbIdent}.* TO ?@?`, [p.user, newH]);
    await c.query("FLUSH PRIVILEGES");
  });
}

export async function dropDatabaseAndUser(p: {
  schema: string;
  user: string;
  connectionsFrom: string;
}): Promise<void> {
  const dbIdent = quoteIdent(p.schema);
  const host = escapeHostPattern(p.connectionsFrom);
  await withRootConnection(async (c) => {
    await c.query(`DROP DATABASE IF EXISTS ${dbIdent}`);
    await c.query(`DROP USER IF EXISTS ?@?`, [p.user, host]);
    await c.query("FLUSH PRIVILEGES");
  });
}

export async function executeUserQuery(p: {
  schema: string;
  user: string;
  password: string;
  sql: string;
  readOnly?: boolean;
}): Promise<QueryResult> {
  const start = performance.now();
  const conn = await mysql.createConnection({
    host: env.mariadbBind,
    port: env.mariadbPort,
    user: p.user,
    password: p.password,
    database: p.schema,
    rowsAsArray: true,
    multipleStatements: false,
    dateStrings: true,
    connectTimeout: 5000,
  });
  try {
    if (p.readOnly) await conn.query("SET SESSION TRANSACTION READ ONLY");
    const [rows, fields] = await conn.query(p.sql);
    const durationMs = performance.now() - start;
    if (Array.isArray(rows) && Array.isArray(fields)) {
      return {
        columns: fields.map((f) => f.name),
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
    await conn.end();
  }
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

export async function getTableBreakdown(schema: string): Promise<
  Array<{ name: string; rowCount: number; sizeBytes: number; avgRowBytes: number }>
> {
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
