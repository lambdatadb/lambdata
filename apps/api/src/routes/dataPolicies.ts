import mysql from "mysql2/promise";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import type { DataApiPolicy } from "@lambdata/shared";
import { audit, dataApiPolicies } from "../db/queries";
import { dataAccess } from "../db/queries/dataAccess";
import { requireAuth, type AuthVariables } from "../auth/middleware";
import { baseTablesBySchema, requireDataApiDatabase, virtualPolicy } from "../auth/dataAccess";
import { withRootConnection } from "../mariadb/controller";
import { isSafeIdent } from "../util/ident";
import { parseJson } from "../util/validate";

const policyPatchSchema = z.object({
  selectEnabled: z.boolean().optional(),
  insertEnabled: z.boolean().optional(),
  updateEnabled: z.boolean().optional(),
  deleteEnabled: z.boolean().optional(),
  ownerColumn: z.string().nullable().optional(),
});

export const dataPoliciesRoute = new Hono<{ Variables: AuthVariables }>();

dataPoliciesRoute.use("*", requireAuth);

dataPoliciesRoute.get("/:databaseName", async (c) => {
  const database = requireDataApiDatabase(c.get("user"), c.req.param("databaseName"), "read", true);
  const tables = (await baseTablesBySchema([database.name])).get(database.name) ?? [];
  const mode = dataAccess.mode(database.id);
  const stored = new Map(dataApiPolicies.list(database.id).map((policy) => [policy.tableName, policy]));
  return c.json({
    policies: tables.map((tableName) => stored.get(tableName) ?? virtualPolicy(database.id, tableName, mode)),
  });
});

dataPoliciesRoute.get("/:databaseName/:tableName", async (c) => {
  const database = requireDataApiDatabase(c.get("user"), c.req.param("databaseName"), "read", true);
  const tableName = validateTableName(c.req.param("tableName"));
  await tableColumns(database.name, tableName);
  return c.json({ policy: effectivePolicy(database.id, tableName) });
});

dataPoliciesRoute.patch("/:databaseName/:tableName", async (c) => {
  const user = c.get("user");
  const database = requireDataApiDatabase(user, c.req.param("databaseName"), "write", true);
  const tableName = validateTableName(c.req.param("tableName"));
  const body = await parseJson(c, policyPatchSchema);
  const columns = await tableColumns(database.name, tableName);
  const existing = effectivePolicy(database.id, tableName);
  const ownerColumn = body.ownerColumn === undefined
    ? existing.ownerColumn
    : normalizeOwnerColumn(body.ownerColumn, columns);
  const next = {
    databaseId: database.id,
    tableName,
    selectEnabled: body.selectEnabled ?? existing.selectEnabled,
    insertEnabled: body.insertEnabled ?? existing.insertEnabled,
    updateEnabled: body.updateEnabled ?? existing.updateEnabled,
    deleteEnabled: body.deleteEnabled ?? existing.deleteEnabled,
    ownerColumn,
  };
  dataApiPolicies.upsert(next);
  audit.log(user.id, "data_api.policy.update", database.id, {
    database: database.name,
    table: tableName,
    selectEnabled: next.selectEnabled,
    insertEnabled: next.insertEnabled,
    updateEnabled: next.updateEnabled,
    deleteEnabled: next.deleteEnabled,
    ownerColumn,
  });
  return c.json({ policy: dataApiPolicies.byTable(database.id, tableName) });
});

dataPoliciesRoute.delete("/:databaseName/:tableName", (c) => {
  const user = c.get("user");
  const database = requireDataApiDatabase(user, c.req.param("databaseName"), "write", true);
  const tableName = validateTableName(c.req.param("tableName"));
  dataApiPolicies.delete(database.id, tableName);
  audit.log(user.id, "data_api.policy.reset", database.id, {
    database: database.name,
    table: tableName,
  });
  return c.json({ policy: virtualPolicy(database.id, tableName, dataAccess.mode(database.id)) });
});

function effectivePolicy(databaseId: string, tableName: string): DataApiPolicy {
  return dataApiPolicies.byTable(databaseId, tableName) ?? virtualPolicy(databaseId, tableName, dataAccess.mode(databaseId));
}

function validateTableName(tableName: string | undefined): string {
  if (!tableName || !isSafeIdent(tableName)) {
    throw new HTTPException(400, { message: "table must be a safe identifier" });
  }
  return tableName;
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

function normalizeOwnerColumn(ownerColumn: string | null, columns: string[]): string | null {
  const value = ownerColumn?.trim() || null;
  if (!value) return null;
  if (!isSafeIdent(value)) throw new HTTPException(400, { message: "owner column must be a safe identifier" });
  if (!columns.includes(value)) {
    throw new HTTPException(400, { message: `owner column ${value} does not exist on table` });
  }
  return value;
}
