import mysql from "mysql2/promise";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { DataApiPolicy, User } from "@kilndb/shared";
import { audit, dataApiPolicies, databases } from "../db/queries";
import { requireAuth, type AuthVariables } from "../auth/middleware";
import { withRootConnection } from "../mariadb/controller";

export const dataPoliciesRoute = new Hono<{ Variables: AuthVariables }>();

dataPoliciesRoute.use("*", requireAuth);

dataPoliciesRoute.get("/:databaseName", async (c) => {
  const database = requireDatabase(c.req.param("databaseName"), c.get("user"));
  const tables = await tableNames(database.name);
  const stored = new Map(dataApiPolicies.list(database.id).map((policy) => [policy.tableName, policy]));
  return c.json({
    policies: tables.map((tableName) => stored.get(tableName) ?? defaultPolicy(database.id, tableName)),
  });
});

dataPoliciesRoute.get("/:databaseName/:tableName", async (c) => {
  const database = requireDatabase(c.req.param("databaseName"), c.get("user"));
  const tableName = validateTableName(c.req.param("tableName"));
  await assertTableExists(database.name, tableName);
  return c.json({
    policy: dataApiPolicies.byTable(database.id, tableName) ?? defaultPolicy(database.id, tableName),
  });
});

dataPoliciesRoute.patch("/:databaseName/:tableName", async (c) => {
  const user = c.get("user");
  if (user.role === "viewer") throw new HTTPException(403, { message: "read-only role" });
  const database = requireDatabase(c.req.param("databaseName"), user);
  const tableName = validateTableName(c.req.param("tableName"));
  const columns = await tableColumns(database.name, tableName);
  const existing = dataApiPolicies.byTable(database.id, tableName) ?? defaultPolicy(database.id, tableName);
  const body = (await c.req.json()) as Partial<{
    selectEnabled: boolean;
    insertEnabled: boolean;
    updateEnabled: boolean;
    deleteEnabled: boolean;
    ownerColumn: string | null;
  }>;
  const ownerColumn = body.ownerColumn === undefined
    ? existing.ownerColumn
    : normalizeOwnerColumn(body.ownerColumn, columns);

  dataApiPolicies.upsert({
    databaseId: database.id,
    tableName,
    selectEnabled: body.selectEnabled ?? existing.selectEnabled,
    insertEnabled: body.insertEnabled ?? existing.insertEnabled,
    updateEnabled: body.updateEnabled ?? existing.updateEnabled,
    deleteEnabled: body.deleteEnabled ?? existing.deleteEnabled,
    ownerColumn,
  });
  audit.log(user.id, "data_api.policy.update", database.id, {
    database: database.name,
    table: tableName,
    ownerColumn,
  });
  return c.json({ policy: dataApiPolicies.byTable(database.id, tableName) });
});

dataPoliciesRoute.delete("/:databaseName/:tableName", (c) => {
  const user = c.get("user");
  if (user.role === "viewer") throw new HTTPException(403, { message: "read-only role" });
  const database = requireDatabase(c.req.param("databaseName"), user);
  const tableName = validateTableName(c.req.param("tableName"));
  dataApiPolicies.delete(database.id, tableName);
  audit.log(user.id, "data_api.policy.reset", database.id, {
    database: database.name,
    table: tableName,
  });
  return c.json({ policy: defaultPolicy(database.id, tableName) });
});

function requireDatabase(databaseName: string, user: User): NonNullable<ReturnType<typeof databases.byName>> {
  if (!safeIdent(databaseName)) throw new HTTPException(400, { message: "database must be a safe identifier" });
  const database = databases.byName(databaseName);
  if (!database) throw new HTTPException(404, { message: "database not found" });
  if (database.status !== "active") throw new HTTPException(409, { message: "database not active" });
  if (user.role === "db_owner" && database.ownerUserId !== user.id) {
    throw new HTTPException(403, { message: "not database owner" });
  }
  return database;
}

function validateTableName(tableName: string): string {
  if (!safeIdent(tableName)) throw new HTTPException(400, { message: "table must be a safe identifier" });
  return tableName;
}

async function tableNames(databaseName: string): Promise<string[]> {
  return withRootConnection(async (conn) => {
    const [rows] = await conn.query<mysql.RowDataPacket[]>(
      `SELECT table_name AS name
         FROM information_schema.tables
        WHERE table_schema = ?
          AND table_type = 'BASE TABLE'
        ORDER BY table_name ASC`,
      [databaseName],
    );
    return rows.map((row) => String(row.name));
  });
}

async function tableColumns(databaseName: string, tableName: string): Promise<string[]> {
  return withRootConnection(async (conn) => {
    const [rows] = await conn.query<mysql.RowDataPacket[]>(
      `SELECT column_name AS name
         FROM information_schema.columns
        WHERE table_schema = ?
          AND table_name = ?
        ORDER BY ordinal_position ASC`,
      [databaseName, tableName],
    );
    if (rows.length === 0) throw new HTTPException(404, { message: "table not found" });
    return rows.map((row) => String(row.name));
  });
}

async function assertTableExists(databaseName: string, tableName: string): Promise<void> {
  await tableColumns(databaseName, tableName);
}

function normalizeOwnerColumn(ownerColumn: string | null | undefined, columns: string[]): string | null {
  const value = ownerColumn?.trim() || null;
  if (!value) return null;
  if (!safeIdent(value)) throw new HTTPException(400, { message: "owner column must be a safe identifier" });
  if (!columns.includes(value)) {
    throw new HTTPException(400, { message: `owner column ${value} does not exist on table` });
  }
  return value;
}

function defaultPolicy(databaseId: string, tableName: string): DataApiPolicy {
  return {
    databaseId,
    tableName,
    selectEnabled: true,
    insertEnabled: true,
    updateEnabled: true,
    deleteEnabled: true,
    ownerColumn: null,
    createdAt: null,
    updatedAt: null,
  };
}

function safeIdent(value: string): boolean {
  return /^[a-zA-Z0-9_]+$/.test(value);
}
