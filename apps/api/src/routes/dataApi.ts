import mysql from "mysql2/promise";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import type { AppAuthUser, DataApiOperation, Database } from "@lambdata/shared";
import { appUserFromBearer } from "../auth/appBearer";
import { decideDataAccess, recordMissingPolicyDenial } from "../auth/dataAccess";
import { audit, databases } from "../db/queries";
import { withRootConnection } from "../mariadb/controller";
import { beginWrite, isWriteFenced } from "../mariadb/writeFence";
import { publishDatabaseChange } from "../realtime/hub";
import { assertDiskRoom, DISK_CACHE_MS } from "../util/disk";
import { isSafeIdent, quoteIdent as quoteSafeIdent } from "../util/ident";
import { parseValue, readJson } from "../util/validate";

const FILTER_OPS = ["eq", "neq", "gt", "gte", "lt", "lte", "like", "ilike", "in"] as const;
type FilterOp = (typeof FILTER_OPS)[number];

const RESERVED_PARAMS = new Set(["select", "order", "limit", "offset"]);
const MAX_INSERT_ROWS = 100;

interface Filter {
  column: string;
  op: FilterOp;
  value: string;
}

interface TableColumn {
  name: string;
  nullable: boolean;
  primary: boolean;
  dataType: string;
}

interface TableContext {
  database: Database;
  tableName: string;
  columns: TableColumn[];
  ownerColumn: string | null;
}

const insertRowSchema = z.record(z.string(), z.unknown(), { error: "JSON object or object array required" });
const rowListSchema = z
  .array(z.record(z.string(), z.unknown(), { error: "each inserted row must be a JSON object" }))
  .min(1, "JSON object or object array required")
  .max(MAX_INSERT_ROWS, `at most ${MAX_INSERT_ROWS} rows per insert`);
const updateSchema = z.record(z.string(), z.unknown(), { error: "JSON object required" });

export const dataApiRoute = new Hono<{ Variables: { appUser: AppAuthUser } }>();

dataApiRoute.use("*", async (c, next) => {
  c.set("appUser", await appUserFromBearer(c.req.header("Authorization")));
  await next();
});

dataApiRoute.get("/:databaseName/:tableName", async (c) => {
  const ctx = await authorizedTable(c.req.param("databaseName"), c.req.param("tableName"), "select");
  const select = parseSelect(c.req.query("select"), ctx.columns);
  const filters = [
    ...parseFilters(new URL(c.req.url).searchParams, ctx.columns),
    ...ownerFilters(ctx, c.get("appUser")),
  ];
  const order = parseOrder(c.req.query("order"), ctx.columns);
  const limit = boundedInt(c.req.query("limit"), 100, 1000);
  const offset = boundedInt(c.req.query("offset"), 0, 100_000);

  const values: unknown[] = [];
  const where = buildWhere(filters, values);
  const sql = [
    `SELECT ${select.map(quoteIdent).join(", ")} FROM ${tableRef(ctx)}`,
    where,
    order ? `ORDER BY ${quoteIdent(order.column)} ${order.direction}` : "",
    "LIMIT ? OFFSET ?",
  ].filter(Boolean).join(" ");
  values.push(limit, offset);

  return withRootConnection(async (conn) => {
    const [rows] = await runClientQuery(() => conn.query<mysql.RowDataPacket[]>({ sql, values, supportBigNumbers: true }));
    return c.json({ data: rows.map(rowObject), count: rows.length });
  });
});

const WRITE_ACTION = "write rows through the Data API";

function assertWriteRoom(): void {
  assertDiskRoom(WRITE_ACTION, 0, { cachedMs: DISK_CACHE_MS });
}

dataApiRoute.post("/:databaseName/:tableName", async (c) => {
  const ctx = await authorizedTable(c.req.param("databaseName"), c.req.param("tableName"), "insert");
  assertWriteRoom();
  const body = await readJson(c);
  const payload = Array.isArray(body)
    ? parseValue(rowListSchema, body, "insert body")
    : [parseValue(insertRowSchema, isRecord(body) ? body : null, "insert body")];

  const columnSet = new Set(ctx.columns.map((col) => col.name));
  const columns = Object.keys(payload[0]!).filter((col) => columnSet.has(col));
  if (columns.length === 0) {
    throw new HTTPException(400, { message: "no writable table columns in payload" });
  }
  for (const row of payload) {
    const rowCols = Object.keys(row).filter((col) => columnSet.has(col));
    if (rowCols.length !== columns.length || !columns.every((col) => rowCols.includes(col))) {
      throw new HTTPException(400, { message: "all inserted rows must use the same table columns" });
    }
  }
  const user = c.get("appUser");
  assertOwnerInsert(ctx, user, payload);

  const placeholders = payload.map(() => `(${columns.map(() => "?").join(", ")})`).join(", ");
  const values = payload.flatMap((row) => columns.map((col) => columnValue(row[col])));
  const sql = `INSERT INTO ${tableRef(ctx)} (${columns.map(quoteIdent).join(", ")}) VALUES ${placeholders}`;

  return withRootConnection(async (conn) => {
    const [result] = await whileWriting(ctx.database.id, () =>
      runClientQuery(() => conn.query<mysql.ResultSetHeader>({ sql, values, supportBigNumbers: true })),
    );
    const affectedRows = result.affectedRows;
    audit.log(null, "data_api.insert", ctx.database.id, {
      database: ctx.database.name,
      table: ctx.tableName,
      affectedRows,
    });
    publishDatabaseChange({
      database: ctx.database.name,
      table: ctx.tableName,
      operation: "INSERT",
      sender: user,
      ownerId: ctx.ownerColumn ? user.id : null,
      payload: {
        affectedRows,
        insertId: result.insertId,
        new: Array.isArray(body) ? payload : payload[0],
      },
    });
    return c.json({ data: { affectedRows, insertId: result.insertId } }, 201);
  });
});

dataApiRoute.patch("/:databaseName/:tableName", async (c) => {
  const ctx = await authorizedTable(c.req.param("databaseName"), c.req.param("tableName"), "update");
  assertWriteRoom();
  const body = await readJson(c);
  const patch = parseValue(updateSchema, isRecord(body) ? body : null, "update body");
  const user = c.get("appUser");
  assertOwnerUpdate(ctx, user, patch);

  const columnSet = new Set(ctx.columns.map((col) => col.name));
  const writable = Object.entries(patch).filter(([col]) => columnSet.has(col));
  if (writable.length === 0) {
    throw new HTTPException(400, { message: "no writable table columns in payload" });
  }

  const filters = [
    ...parseFilters(new URL(c.req.url).searchParams, ctx.columns),
    ...ownerFilters(ctx, user),
  ];
  const values: unknown[] = writable.map(([, value]) => columnValue(value));
  const where = buildWhere(filters, values);
  const limit = boundedInt(c.req.query("limit"), 0, 1000);
  const sql = [
    `UPDATE ${tableRef(ctx)} SET ${writable.map(([col]) => `${quoteIdent(col)} = ?`).join(", ")}`,
    where,
    limit > 0 ? `LIMIT ${limit}` : "",
  ].filter(Boolean).join(" ");

  return withRootConnection(async (conn) => {
    const [result] = await whileWriting(ctx.database.id, () =>
      runClientQuery(() => conn.query<mysql.ResultSetHeader>({ sql, values, supportBigNumbers: true })),
    );
    const affectedRows = result.affectedRows;
    audit.log(null, "data_api.update", ctx.database.id, {
      database: ctx.database.name,
      table: ctx.tableName,
      affectedRows,
    });
    publishDatabaseChange({
      database: ctx.database.name,
      table: ctx.tableName,
      operation: "UPDATE",
      sender: user,
      ownerId: ctx.ownerColumn ? user.id : null,
      payload: {
        affectedRows,
        changedRows: result.changedRows,
        set: patch,
        filters: filters.map((filter) => ({ ...filter })),
      },
    });
    return c.json({ data: { affectedRows, changedRows: result.changedRows } });
  });
});

dataApiRoute.delete("/:databaseName/:tableName", async (c) => {
  const ctx = await authorizedTable(c.req.param("databaseName"), c.req.param("tableName"), "delete");
  const user = c.get("appUser");
  const filters = [
    ...parseFilters(new URL(c.req.url).searchParams, ctx.columns),
    ...ownerFilters(ctx, user),
  ];
  const values: unknown[] = [];
  const where = buildWhere(filters, values);
  const limit = boundedInt(c.req.query("limit"), 0, 1000);
  const sql = [
    `DELETE FROM ${tableRef(ctx)}`,
    where,
    limit > 0 ? `LIMIT ${limit}` : "",
  ].filter(Boolean).join(" ");

  return withRootConnection(async (conn) => {
    const [result] = await whileWriting(ctx.database.id, () =>
      runClientQuery(() => conn.query<mysql.ResultSetHeader>({ sql, values, supportBigNumbers: true })),
    );
    const affectedRows = result.affectedRows;
    audit.log(null, "data_api.delete", ctx.database.id, {
      database: ctx.database.name,
      table: ctx.tableName,
      affectedRows,
    });
    publishDatabaseChange({
      database: ctx.database.name,
      table: ctx.tableName,
      operation: "DELETE",
      sender: user,
      ownerId: ctx.ownerColumn ? user.id : null,
      payload: {
        affectedRows,
        filters: filters.map((filter) => ({ ...filter })),
      },
    });
    return c.json({ data: { affectedRows } });
  });
});

const FENCED_RETRY_SECONDS = 5;

export const FENCED_WRITE_MESSAGE = `This database is briefly closed to writes while LambData replaces its contents (a rollback, import or sync). Retry in ${FENCED_RETRY_SECONDS} seconds.`;

function assertWritable(databaseId: string): void {
  if (!isWriteFenced(databaseId)) return;
  throw new HTTPException(503, { message: FENCED_WRITE_MESSAGE });
}

async function whileWriting<T>(databaseId: string, write: () => Promise<T>): Promise<T> {
  assertWritable(databaseId);
  const done = beginWrite(databaseId);
  try {
    return await write();
  } finally {
    done();
  }
}

async function authorizedTable(
  databaseName: string,
  tableName: string,
  operation: DataApiOperation,
): Promise<TableContext> {
  if (!isSafeIdent(databaseName) || !isSafeIdent(tableName)) {
    throw new HTTPException(400, { message: "database and table must be safe identifiers" });
  }
  const database = databases.byName(databaseName);
  if (!database) throw new HTTPException(404, { message: "database not found" });
  if (database.status !== "active") throw new HTTPException(409, { message: "database not active" });
  if (operation !== "select") assertWritable(database.id);

  const columns = await withRootConnection(async (conn) => {
    const [rows] = await conn.query<mysql.RowDataPacket[]>(
      `SELECT column_name AS name,
              is_nullable AS nullable,
              column_key AS column_key,
              data_type AS data_type
         FROM information_schema.columns
        WHERE table_schema = ?
          AND table_name = ?
        ORDER BY ordinal_position ASC`,
      [database.name, tableName],
    );
    return rows.map((row) => ({
      name: String(row.name),
      nullable: row.nullable === "YES",
      primary: row.column_key === "PRI",
      dataType: String(row.data_type).toLowerCase(),
    }));
  });
  if (columns.length === 0) throw new HTTPException(404, { message: "table not found" });

  const decision = decideDataAccess(database, tableName, operation);
  if (!decision.allowed) {
    if (decision.reason === "no_policy") recordMissingPolicyDenial(database, tableName, operation);
    throw new HTTPException(403, { message: decision.message });
  }
  if (decision.ownerColumn && !columns.some((col) => col.name === decision.ownerColumn)) {
    throw new HTTPException(409, {
      message: `policy owner column ${decision.ownerColumn} does not exist on ${tableName}`,
    });
  }
  return { database, tableName, columns, ownerColumn: decision.ownerColumn };
}

async function runClientQuery<T>(query: () => Promise<T>): Promise<T> {
  try {
    return await query();
  } catch (err) {
    const sqlState = (err as { sqlState?: unknown }).sqlState;
    const message = (err as { sqlMessage?: unknown }).sqlMessage;
    if (typeof sqlState === "string" && typeof message === "string") {
      if (sqlState.startsWith("23")) throw new HTTPException(409, { message });
      if (sqlState.startsWith("22")) throw new HTTPException(400, { message });
    }
    throw err;
  }
}

function parseSelect(raw: string | undefined, columns: TableColumn[]): string[] {
  const allowed = new Set(columns.map((col) => col.name));
  if (!raw || raw === "*") return columns.map((col) => col.name);
  const selected = raw.split(",").map((col) => col.trim()).filter(Boolean);
  if (selected.length === 0) throw new HTTPException(400, { message: "select cannot be empty" });
  for (const col of selected) {
    if (!allowed.has(col)) throw new HTTPException(400, { message: `unknown selected column: ${col}` });
  }
  return selected;
}

function isFilterOp(value: string): value is FilterOp {
  return (FILTER_OPS as readonly string[]).includes(value);
}

function parseFilters(params: URLSearchParams, columns: TableColumn[]): Filter[] {
  const allowed = new Set(columns.map((col) => col.name));
  const filters: Filter[] = [];
  for (const [key, value] of params.entries()) {
    if (RESERVED_PARAMS.has(key)) continue;
    if (!allowed.has(key)) throw new HTTPException(400, { message: `unknown filter column: ${key}` });
    const dot = value.indexOf(".");
    if (dot <= 0) throw new HTTPException(400, { message: `invalid filter for ${key}` });
    const op = value.slice(0, dot);
    if (!isFilterOp(op)) {
      throw new HTTPException(400, { message: `unsupported filter op: ${op}` });
    }
    filters.push({ column: key, op, value: value.slice(dot + 1) });
  }
  return filters;
}

function parseOrder(raw: string | undefined, columns: TableColumn[]): null | {
  column: string;
  direction: "ASC" | "DESC";
} {
  if (!raw) return null;
  const [column, direction = "asc"] = raw.split(".");
  if (!column || !columns.some((col) => col.name === column)) {
    throw new HTTPException(400, { message: "unknown order column" });
  }
  if (!["asc", "desc"].includes(direction)) {
    throw new HTTPException(400, { message: "order direction must be asc or desc" });
  }
  return { column, direction: direction === "desc" ? "DESC" : "ASC" };
}

function ownerFilters(ctx: TableContext, user: AppAuthUser): Filter[] {
  return ctx.ownerColumn ? [{ column: ctx.ownerColumn, op: "eq", value: user.id }] : [];
}

function assertOwnerInsert(ctx: TableContext, user: AppAuthUser, payload: Record<string, unknown>[]): void {
  const ownerColumn = ctx.ownerColumn;
  if (!ownerColumn) return;
  for (const row of payload) {
    if (row[ownerColumn] !== user.id) {
      throw new HTTPException(403, {
        message: `insert policy requires ${ownerColumn} to match the App Auth user id`,
      });
    }
  }
}

function assertOwnerUpdate(ctx: TableContext, user: AppAuthUser, body: Record<string, unknown>): void {
  const ownerColumn = ctx.ownerColumn;
  if (!ownerColumn) return;
  if (body[ownerColumn] !== undefined && body[ownerColumn] !== user.id) {
    throw new HTTPException(403, {
      message: `update policy forbids changing ${ownerColumn} away from the App Auth user id`,
    });
  }
}

function columnValue(value: unknown): unknown {
  if (value !== null && typeof value === "object") return JSON.stringify(value);
  return value;
}

const COMPARISON: Record<Exclude<FilterOp, "like" | "ilike" | "in">, string> = {
  eq: "=",
  neq: "<>",
  gt: ">",
  gte: ">=",
  lt: "<",
  lte: "<=",
};

function buildWhere(filters: Filter[], values: unknown[]): string {
  if (filters.length === 0) return "";
  const clauses = filters.map((filter) => {
    const ref = quoteIdent(filter.column);
    switch (filter.op) {
      case "like":
        values.push(filter.value);
        return `${ref} LIKE ?`;
      case "ilike":
        values.push(filter.value.toLowerCase());
        return `LOWER(${ref}) LIKE ?`;
      case "in": {
        const list = parseInList(filter.value);
        values.push(...list);
        return `${ref} IN (${list.map(() => "?").join(", ")})`;
      }
      default:
        values.push(filter.value);
        return `${ref} ${COMPARISON[filter.op]} ?`;
    }
  });
  return `WHERE ${clauses.join(" AND ")}`;
}

function parseInList(raw: string): string[] {
  const trimmed = raw.trim();
  if (!trimmed.startsWith("(") || !trimmed.endsWith(")")) {
    throw new HTTPException(400, { message: "in filter must use parenthesized values" });
  }
  const list = trimmed.slice(1, -1).split(",").map((item) => item.trim()).filter(Boolean);
  if (list.length === 0 || list.length > 100) {
    throw new HTTPException(400, { message: "in filter supports 1-100 values" });
  }
  return list.map((item) => item.replace(/^"|"$/g, ""));
}

function boundedInt(raw: string | undefined, fallback: number, max: number): number {
  if (raw == null || raw === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(0, Math.min(max, Math.floor(parsed)));
}

function rowObject(row: mysql.RowDataPacket): Record<string, unknown> {
  return { ...row };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function quoteIdent(value: string): string {
  if (!isSafeIdent(value)) throw new HTTPException(400, { message: `unsafe identifier: ${value}` });
  return quoteSafeIdent(value);
}

function tableRef(ctx: { database: { name: string }; tableName: string }): string {
  return `${quoteIdent(ctx.database.name)}.${quoteIdent(ctx.tableName)}`;
}
