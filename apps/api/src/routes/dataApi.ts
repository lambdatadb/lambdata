import mysql from "mysql2/promise";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { AppAuthUser, DataApiOperation, DataApiPolicy } from "@kilndb/shared";
import { appUserFromBearer } from "../auth/appBearer";
import { audit, dataApiPolicies, databases } from "../db/queries";
import { withRootConnection } from "../mariadb/controller";
import { publishDatabaseChange } from "../realtime/hub";

type FilterOp = "eq" | "neq" | "gt" | "gte" | "lt" | "lte" | "like" | "ilike" | "in";

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

export const dataApiRoute = new Hono<{ Variables: { appUser: AppAuthUser } }>();

dataApiRoute.use("/:databaseName/:tableName/*", async (c, next) => {
  c.set("appUser", await appUserFromBearer(c.req.header("Authorization")));
  await next();
});
dataApiRoute.use("/:databaseName/:tableName", async (c, next) => {
  c.set("appUser", await appUserFromBearer(c.req.header("Authorization")));
  await next();
});

dataApiRoute.get("/:databaseName/:tableName", async (c) => {
  const ctx = await tableContext(c.req.param("databaseName"), c.req.param("tableName"));
  assertPolicyAllows(ctx, "select");
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
    const [rows] = await conn.query<mysql.RowDataPacket[]>(sql, values);
    return c.json({ data: rows.map(rowObject), count: rows.length });
  });
});

dataApiRoute.post("/:databaseName/:tableName", async (c) => {
  const ctx = await tableContext(c.req.param("databaseName"), c.req.param("tableName"));
  assertPolicyAllows(ctx, "insert");
  const body = await c.req.json().catch(() => null);
  const payload = Array.isArray(body) ? body : [body];
  if (payload.length === 0 || payload.some((row) => !isRecord(row))) {
    throw new HTTPException(400, { message: "JSON object or object array required" });
  }
  if (payload.length > 100) {
    throw new HTTPException(400, { message: "at most 100 rows per insert" });
  }

  const columnSet = new Set(ctx.columns.map((col) => col.name));
  const columns = Object.keys(payload[0]!).filter((col) => columnSet.has(col));
  if (columns.length === 0) {
    throw new HTTPException(400, { message: "no writable table columns in payload" });
  }
  for (const row of payload) {
    const rowCols = Object.keys(row as Record<string, unknown>).filter((col) => columnSet.has(col));
    if (rowCols.length !== columns.length || !columns.every((col) => rowCols.includes(col))) {
      throw new HTTPException(400, { message: "all inserted rows must use the same table columns" });
    }
  }
  assertOwnerInsert(ctx, c.get("appUser"), payload);

  const placeholders = payload
    .map(() => `(${columns.map(() => "?").join(", ")})`)
    .join(", ");
  const values = payload.flatMap((row) => columns.map((col) => (row as Record<string, unknown>)[col]));
  const sql = `INSERT INTO ${tableRef(ctx)} (${columns.map(quoteIdent).join(", ")}) VALUES ${placeholders}`;

  return withRootConnection(async (conn) => {
    const [result] = await conn.query<mysql.ResultSetHeader>(sql, values);
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
      sender: c.get("appUser"),
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
  const ctx = await tableContext(c.req.param("databaseName"), c.req.param("tableName"));
  assertPolicyAllows(ctx, "update");
  const body = await c.req.json().catch(() => null);
  if (!isRecord(body)) throw new HTTPException(400, { message: "JSON object required" });
  assertOwnerUpdate(ctx, c.get("appUser"), body);

  const columnSet = new Set(ctx.columns.map((col) => col.name));
  const writable = Object.entries(body).filter(([col]) => columnSet.has(col));
  if (writable.length === 0) {
    throw new HTTPException(400, { message: "no writable table columns in payload" });
  }

  const filters = [
    ...parseFilters(new URL(c.req.url).searchParams, ctx.columns),
    ...ownerFilters(ctx, c.get("appUser")),
  ];
  const values: unknown[] = writable.map(([, value]) => value);
  const where = buildWhere(filters, values);
  const limit = boundedInt(c.req.query("limit"), 0, 1000);
  const sql = [
    `UPDATE ${tableRef(ctx)} SET ${writable.map(([col]) => `${quoteIdent(col)} = ?`).join(", ")}`,
    where,
    limit > 0 ? `LIMIT ${limit}` : "",
  ].filter(Boolean).join(" ");

  return withRootConnection(async (conn) => {
    const [result] = await conn.query<mysql.ResultSetHeader>(sql, values);
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
      sender: c.get("appUser"),
      payload: {
        affectedRows,
        changedRows: result.changedRows,
        set: body,
        filters: filters.map((filter) => ({ ...filter })),
      },
    });
    return c.json({ data: { affectedRows, changedRows: result.changedRows } });
  });
});

dataApiRoute.delete("/:databaseName/:tableName", async (c) => {
  const ctx = await tableContext(c.req.param("databaseName"), c.req.param("tableName"));
  assertPolicyAllows(ctx, "delete");
  const filters = [
    ...parseFilters(new URL(c.req.url).searchParams, ctx.columns),
    ...ownerFilters(ctx, c.get("appUser")),
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
    const [result] = await conn.query<mysql.ResultSetHeader>(sql, values);
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
      sender: c.get("appUser"),
      payload: {
        affectedRows,
        filters: filters.map((filter) => ({ ...filter })),
      },
    });
    return c.json({ data: { affectedRows } });
  });
});

async function tableContext(databaseName: string, tableName: string): Promise<{
  database: NonNullable<ReturnType<typeof databases.byName>>;
  tableName: string;
  columns: TableColumn[];
  policy: DataApiPolicy | null;
}> {
  if (!safeIdent(databaseName) || !safeIdent(tableName)) {
    throw new HTTPException(400, { message: "database and table must be safe identifiers" });
  }
  const database = databases.byName(databaseName);
  if (!database) throw new HTTPException(404, { message: "database not found" });
  if (database.status !== "active") throw new HTTPException(409, { message: "database not active" });

  return withRootConnection(async (conn) => {
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
    if (rows.length === 0) throw new HTTPException(404, { message: "table not found" });
    return {
      database,
      tableName,
      policy: dataApiPolicies.byTable(database.id, tableName),
      columns: rows.map((row) => ({
        name: String(row.name),
        nullable: row.nullable === "YES",
        primary: row.column_key === "PRI",
        dataType: String(row.data_type),
      })),
    };
  });
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

function parseFilters(params: URLSearchParams, columns: TableColumn[]): Filter[] {
  const allowed = new Set(columns.map((col) => col.name));
  const filters: Filter[] = [];
  for (const [key, value] of params.entries()) {
    if (["select", "order", "limit", "offset"].includes(key)) continue;
    if (!allowed.has(key)) throw new HTTPException(400, { message: `unknown filter column: ${key}` });
    const dot = value.indexOf(".");
    if (dot <= 0) throw new HTTPException(400, { message: `invalid filter for ${key}` });
    const op = value.slice(0, dot) as FilterOp;
    if (!["eq", "neq", "gt", "gte", "lt", "lte", "like", "ilike", "in"].includes(op)) {
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

function assertPolicyAllows(
  ctx: { tableName: string; columns: TableColumn[]; policy: DataApiPolicy | null },
  operation: DataApiOperation,
): void {
  const policy = ctx.policy;
  if (!policy) return;
  const allowed = operation === "select"
    ? policy.selectEnabled
    : operation === "insert"
      ? policy.insertEnabled
      : operation === "update"
        ? policy.updateEnabled
        : policy.deleteEnabled;
  if (!allowed) {
    throw new HTTPException(403, { message: `${operation} is disabled by table policy` });
  }
  if (policy.ownerColumn && !ctx.columns.some((col) => col.name === policy.ownerColumn)) {
    throw new HTTPException(409, {
      message: `policy owner column ${policy.ownerColumn} does not exist on ${ctx.tableName}`,
    });
  }
}

function ownerFilters(
  ctx: { policy: DataApiPolicy | null },
  user: AppAuthUser,
): Filter[] {
  const ownerColumn = ctx.policy?.ownerColumn;
  return ownerColumn ? [{ column: ownerColumn, op: "eq", value: user.id }] : [];
}

function assertOwnerInsert(
  ctx: { policy: DataApiPolicy | null },
  user: AppAuthUser,
  payload: unknown[],
): void {
  const ownerColumn = ctx.policy?.ownerColumn;
  if (!ownerColumn) return;
  for (const row of payload) {
    if (!isRecord(row) || row[ownerColumn] !== user.id) {
      throw new HTTPException(403, {
        message: `insert policy requires ${ownerColumn} to match the App Auth user id`,
      });
    }
  }
}

function assertOwnerUpdate(
  ctx: { policy: DataApiPolicy | null },
  user: AppAuthUser,
  body: Record<string, unknown>,
): void {
  const ownerColumn = ctx.policy?.ownerColumn;
  if (!ownerColumn) return;
  if (body[ownerColumn] !== undefined && body[ownerColumn] !== user.id) {
    throw new HTTPException(403, {
      message: `update policy forbids changing ${ownerColumn} away from the App Auth user id`,
    });
  }
}

function buildWhere(filters: Filter[], values: unknown[]): string {
  if (filters.length === 0) return "";
  const clauses = filters.map((filter) => {
    switch (filter.op) {
      case "eq":
        values.push(filter.value);
        return `${quoteIdent(filter.column)} = ?`;
      case "neq":
        values.push(filter.value);
        return `${quoteIdent(filter.column)} <> ?`;
      case "gt":
        values.push(filter.value);
        return `${quoteIdent(filter.column)} > ?`;
      case "gte":
        values.push(filter.value);
        return `${quoteIdent(filter.column)} >= ?`;
      case "lt":
        values.push(filter.value);
        return `${quoteIdent(filter.column)} < ?`;
      case "lte":
        values.push(filter.value);
        return `${quoteIdent(filter.column)} <= ?`;
      case "like":
        values.push(filter.value);
        return `${quoteIdent(filter.column)} LIKE ?`;
      case "ilike":
        values.push(filter.value.toLowerCase());
        return `LOWER(${quoteIdent(filter.column)}) LIKE ?`;
      case "in": {
        const list = parseInList(filter.value);
        values.push(...list);
        return `${quoteIdent(filter.column)} IN (${list.map(() => "?").join(", ")})`;
      }
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

function safeIdent(value: string): boolean {
  return /^[a-z0-9_]+$/i.test(value);
}

function quoteIdent(value: string): string {
  if (!safeIdent(value)) throw new HTTPException(400, { message: `unsafe identifier: ${value}` });
  return `\`${value}\``;
}

function tableRef(ctx: { database: { name: string }; tableName: string }): string {
  return `${quoteIdent(ctx.database.name)}.${quoteIdent(ctx.tableName)}`;
}
