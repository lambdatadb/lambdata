import type { RowDataPacket } from "mysql2/promise";
import { databases } from "../db/queries";
import { dropDatabaseAndUser } from "../mariadb/manager";
import { withRootConnection } from "../mariadb/controller";
import { STAGING_PREFIX, TRASH_PREFIX } from "../mariadb/schemaSwap";
import { isDatabaseBusy, runExclusive, sanitizeErrorMessage } from "../jobs";
import { completeDeprovision, listMariaDbSchemas } from "./provision";

const SYSTEM_SCHEMAS = new Set(["mysql", "information_schema", "performance_schema", "sys", "test"]);
const PROCESS_STARTED_AT = Date.now() - Math.round(process.uptime() * 1000);

export interface ReconcileReport {
  rolledBack: string[];
  finalized: string[];
  deleted: string[];
  failed: string[];
  orphanSchemas: string[];
}

async function tableCount(schema: string): Promise<number> {
  return withRootConnection(async (c) => {
    const [rows] = await c.query<RowDataPacket[]>(
      "SELECT COUNT(*) AS n FROM information_schema.TABLES WHERE TABLE_SCHEMA = ?",
      [schema],
    );
    return Number(rows[0]?.n ?? 0);
  });
}

export async function reconcileDatabases(opts: { startedBefore?: number } = {}): Promise<ReconcileReport> {
  const cutoff = opts.startedBefore ?? PROCESS_STARTED_AT;
  const report: ReconcileReport = { rolledBack: [], finalized: [], deleted: [], failed: [], orphanSchemas: [] };

  for (const row of databases.listProvisioning()) {
    if (row.provisionState === "creating" && row.createdAt >= cutoff) continue;
    if (isDatabaseBusy(row.id)) continue;
    try {
      await runExclusive(row.id, async () => {
        if (row.provisionState === "deleting") {
          await completeDeprovision(row);
          report.deleted.push(row.name);
          return;
        }
        const schemas = await listMariaDbSchemas();
        if (schemas.has(row.name.toLowerCase()) && (await tableCount(row.name)) > 0) {
          databases.setProvisionState(row.id, null);
          report.finalized.push(row.name);
          console.warn(`[reconcile] ${row.name} was left half-created but already holds tables; kept it`);
          return;
        }
        await dropDatabaseAndUser({ schema: row.name, user: row.mysqlUser, connectionsFrom: row.connectionsFrom });
        databases.delete(row.id);
        report.rolledBack.push(row.name);
      });
    } catch (err) {
      report.failed.push(row.name);
      console.error(`[reconcile] could not reconcile ${row.name}:`, sanitizeErrorMessage(err));
    }
  }

  const known = new Set(databases.allNames().map((n) => n.toLowerCase()));
  for (const schema of await listMariaDbSchemas()) {
    if (SYSTEM_SCHEMAS.has(schema) || known.has(schema)) continue;
    if (schema.startsWith(STAGING_PREFIX) || schema.startsWith(TRASH_PREFIX)) continue;
    report.orphanSchemas.push(schema);
  }
  if (report.orphanSchemas.length > 0) {
    console.warn(
      `[reconcile] MariaDB schemas without LambData metadata were left untouched: ${report.orphanSchemas.join(", ")}`,
    );
  }
  for (const [key, names] of Object.entries(report)) {
    if (key !== "orphanSchemas" && names.length > 0) console.log(`[reconcile] ${key}: ${names.join(", ")}`);
  }
  return report;
}
