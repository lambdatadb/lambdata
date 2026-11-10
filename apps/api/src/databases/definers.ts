import { databases } from "../db/queries";
import { JobConflictError, runExclusive } from "../jobs";
import { accountKey, applyCodeRecords, captureCodeRecords, existingAccountKeys } from "../mariadb/codeObjects";
import { openAdminConnection } from "../mariadb/controller";
import { isSafeIdent } from "../util/ident";
import { sanitizeMariaDbMessage } from "../mariadb/messages";

export interface DefinerRepairReport {
  moved: number;
  databases: string[];
  warnings: string[];
}

function errorMessage(err: unknown): string {
  return sanitizeMariaDbMessage(err instanceof Error ? err.message : String(err));
}

export async function repairMissingDefiners(): Promise<DefinerRepairReport> {
  const report: DefinerRepairReport = { moved: 0, databases: [], warnings: [] };
  const existing = await existingAccountKeys();
  for (const row of databases.list()) {
    if (databases.provisionStateOf(row.id) !== null) continue;
    if (!isSafeIdent(row.name)) continue;
    try {
      await runExclusive(row.id, async () => {
        const conn = await openAdminConnection();
        let records;
        try {
          records = await captureCodeRecords(conn, row.name);
        } finally {
          await conn.end().catch(() => conn.destroy());
        }
        const ownKey = accountKey({ user: row.mysqlUser, host: row.connectionsFrom });
        const orphaned = records.filter((r) =>
          row.kind === "mirror" ? !r.definer || accountKey(r.definer) !== ownKey : r.definer !== null && !existing.has(accountKey(r.definer)),
        );
        if (orphaned.length === 0) return;
        const owner = { user: row.mysqlUser, host: row.connectionsFrom };
        const result = await applyCodeRecords(row.name, orphaned, { definers: { account: owner, keep: "account" } });
        report.moved += result.applied;
        report.databases.push(row.name);
        for (const f of result.failures) {
          report.warnings.push(
            `${row.name}: ${f.kind.toLowerCase()} ${f.name} could not be moved onto ${row.mysqlUser}@${row.connectionsFrom}: ${f.explanation ?? f.error}`,
          );
        }
      });
    } catch (err) {
      if (err instanceof JobConflictError) {
        report.warnings.push(`${row.name}: skipped because a job is running; retried at the next start`);
        continue;
      }
      report.warnings.push(`${row.name}: ${errorMessage(err)}`);
    }
  }
  return report;
}
