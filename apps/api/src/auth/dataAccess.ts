import mysql from "mysql2/promise";
import { HTTPException } from "hono/http-exception";
import type { Database, DataApiMode, DataApiOperation, DataApiPolicy, User } from "@lambdata/shared";
import { dataApiPolicies, databases } from "../db/queries";
import { dataAccess } from "../db/queries/dataAccess";
import { withRootConnection } from "../mariadb/controller";
import { isSafeIdent } from "../util/ident";

export const DATA_API_OPERATIONS: readonly DataApiOperation[] = ["select", "insert", "update", "delete"];

const OPERATION_FIELD = {
  select: "selectEnabled",
  insert: "insertEnabled",
  update: "updateEnabled",
  delete: "deleteEnabled",
} as const satisfies Record<DataApiOperation, keyof DataApiPolicy>;

export interface DatabaseRef {
  id: string;
  name: string;
}

export type DataAccessDecision =
  | { allowed: true; mode: DataApiMode; policy: DataApiPolicy | null; ownerColumn: string | null }
  | { allowed: false; reason: "no_policy" | "operation_disabled"; message: string };

export function noPolicyMessage(databaseName: string, tableName: string, operation: DataApiOperation): string {
  return (
    `${operation} denied: table "${tableName}" in database "${databaseName}" has no Data API policy. ` +
    `Tables without a policy are closed to app users. Enable a policy for "${tableName}" on the Data API page ` +
    `of the LambData console, or open the whole database to app users there.`
  );
}

export function requireDataApiDatabase(
  user: User,
  databaseName: string | undefined,
  access: "read" | "write",
  requireActive: boolean,
): Database {
  if (access === "write" && user.role === "viewer") throw new HTTPException(403, { message: "read-only role" });
  const name = databaseName ?? "";
  if (!isSafeIdent(name)) throw new HTTPException(400, { message: "database must be a safe identifier" });
  const database = databases.byName(name);
  if (!database || database.status === "deleting") throw new HTTPException(404, { message: "database not found" });
  if (user.role === "db_owner" && database.ownerUserId !== user.id) {
    throw new HTTPException(403, { message: "not database owner" });
  }
  if (requireActive && database.status !== "active") {
    throw new HTTPException(409, { message: "database not active" });
  }
  return database;
}

export function decideDataAccess(
  database: DatabaseRef,
  tableName: string,
  operation: DataApiOperation,
): DataAccessDecision {
  const policy = dataApiPolicies.byTable(database.id, tableName);
  const mode = dataAccess.mode(database.id);
  if (policy) {
    if (!policy[OPERATION_FIELD[operation]]) {
      return { allowed: false, reason: "operation_disabled", message: `${operation} is disabled by table policy` };
    }
    return { allowed: true, mode, policy, ownerColumn: policy.ownerColumn };
  }
  if (mode === "open") return { allowed: true, mode, policy: null, ownerColumn: null };
  return { allowed: false, reason: "no_policy", message: noPolicyMessage(database.name, tableName, operation) };
}

export function recordMissingPolicyDenial(
  database: DatabaseRef,
  tableName: string,
  operation: DataApiOperation,
): void {
  try {
    dataAccess.recordDenial(database.id, tableName, operation);
  } catch (err) {
    console.warn("[data-api] could not record a denial:", err instanceof Error ? err.message : err);
  }
}

export function anyTableReadable(database: DatabaseRef): boolean {
  if (dataAccess.mode(database.id) === "open") return true;
  return dataApiPolicies.list(database.id).some((policy) => policy.selectEnabled);
}

export function virtualPolicy(databaseId: string, tableName: string, mode: DataApiMode): DataApiPolicy {
  const enabled = mode === "open";
  return {
    databaseId,
    tableName,
    selectEnabled: enabled,
    insertEnabled: enabled,
    updateEnabled: enabled,
    deleteEnabled: enabled,
    ownerColumn: null,
    createdAt: null,
    updatedAt: null,
  };
}

export async function baseTablesBySchema(schemas: string[]): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  if (schemas.length === 0) return out;
  const rows = await withRootConnection(async (conn) => {
    const [result] = await conn.query<mysql.RowDataPacket[]>(
      `SELECT table_schema AS schema_name, table_name AS name
         FROM information_schema.tables
        WHERE table_type = 'BASE TABLE'
          AND table_schema IN (?)
        ORDER BY table_schema ASC, table_name ASC`,
      [schemas],
    );
    return result;
  });
  for (const row of rows) {
    const schema = String(row.schema_name);
    const list = out.get(schema) ?? [];
    list.push(String(row.name));
    out.set(schema, list);
  }
  return out;
}

export async function baseTableExists(schema: string, tableName: string): Promise<boolean> {
  try {
    const tables = await baseTablesBySchema([schema]);
    return (tables.get(schema) ?? []).includes(tableName);
  } catch {
    return false;
  }
}
