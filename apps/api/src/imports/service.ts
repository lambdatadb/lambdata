import { databases, jobs } from "../db/queries";
import { importRuns } from "../db/queries/imports";
import { activeJobFor, INTERRUPTED_MESSAGE } from "../jobs";
import { intervalService, registerService, registerStartupTask } from "../lifecycle";
import { mariadbState } from "../mariadb/controller";
import { diskStatus, noteDiskStatus } from "../util/disk";
import { dropOrphanScopedAccounts } from "../mariadb/scopedAccount";
import { removeStaleUploads } from "./uploads";

const CLEANUP_INTERVAL_MS = 15 * 60 * 1000;

export async function cleanupImports(now: number = Date.now()): Promise<{ uploads: string[]; accounts: number }> {
  const uploads = await removeStaleUploads(now);
  noteDiskStatus(diskStatus(), now);
  const accounts = mariadbState() === "running" ? await dropOrphanScopedAccounts() : 0;
  return { uploads, accounts };
}

export const importsService = registerService(
  intervalService({ name: "imports", intervalMs: CLEANUP_INTERVAL_MS, tick: () => cleanupImports(), runOnStart: true }),
);

export async function undoInterruptedImports(): Promise<{ reset: string[]; cleared: number }> {
  const out = { reset: [] as string[], cleared: 0 };
  for (const run of importRuns.list()) {
    const job = jobs.byId(run.jobId);
    if (job && (job.status === "queued" || job.status === "running")) continue;
    if (activeJobFor(run.databaseId)?.id === run.jobId) continue;
    const row = databases.byId(run.databaseId);
    if (run.mode === "create" && row && row.name === run.schemaName) {
      const { resetSchema } = await import("./run");
      await resetSchema(run.schemaName);
      out.reset.push(run.schemaName);
      if (job && job.status === "failed" && (job.error ?? "").startsWith(INTERRUPTED_MESSAGE)) {
        jobs.rewriteFinished(run.jobId, {
          status: "failed",
          error: `The import was interrupted by a restart. The partly imported data was removed, so the new database "${row.displayName}" (${row.name}) is empty again; retry with "Replace data from file" or delete it.`,
        });
      }
    } else if (job && job.status === "failed" && (job.error ?? "").startsWith(INTERRUPTED_MESSAGE) && run.mode === "replace") {
      jobs.rewriteFinished(run.jobId, {
        status: "failed",
        error: "The import was interrupted by a restart before the new data was swapped in, so the database was not changed. Retry the import.",
      });
    }
    importRuns.finish(run.jobId);
    out.cleared++;
  }
  return out;
}

registerStartupTask("imports.interrupted", async () => {
  const { reset } = await undoInterruptedImports();
  if (reset.length > 0) console.log(`[imports] emptied ${reset.length} database(s) whose import was interrupted by a restart: ${reset.join(", ")}`);
});
