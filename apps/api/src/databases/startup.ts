import { registerStartupTask, runStartupTasksOnce } from "../lifecycle";
import { onMariaDbReady } from "../mariadb/controller";
import { cleanupOrphanSchemas, recoverInterruptedSwaps } from "../mariadb/schemaSwap";
import { dropOrphanScopedAccounts } from "../mariadb/scopedAccount";
import { liftLeftoverWriteFences, reconcileFencesAfterRestart } from "../mariadb/writeFence";
import * as manager from "../mariadb/manager";
import { reconcileReadonlyAccounts } from "../mariadb/readonly";
import { repairMissingDefiners } from "./definers";
import { reconcileDatabases } from "./reconcile";

async function recoverSwaps(): Promise<void> {
  const swaps = await recoverInterruptedSwaps();
  for (const name of swaps.failed) console.warn(`[startup] the interrupted swap of ${name} is still pending; it is retried later`);
}

async function recoverInterruptedWork(): Promise<void> {
  await recoverSwaps();
  const fences = await liftLeftoverWriteFences();
  if (fences.lifted.length > 0) console.log(`[startup] reopened databases left closed to writes: ${fences.lifted.join(", ")}`);
  for (const warning of fences.warnings) console.warn(`[startup] write fence: ${warning}`);
}

async function dropOrphans(): Promise<void> {
  const dropped = await cleanupOrphanSchemas();
  if (dropped.length > 0) console.log(`[startup] dropped leftover staging schemas: ${dropped.join(", ")}`);
  const accounts = await dropOrphanScopedAccounts();
  if (accounts > 0) console.log(`[startup] removed ${accounts} leftover temporary account(s)`);
}

async function recoverAfterRestart(): Promise<void> {
  await recoverSwaps();
  const fences = await reconcileFencesAfterRestart();
  for (const name of fences.aborted) console.warn(`[mariadb] stopped the work that held ${name} closed to writes, because MariaDB restarted under it`);
  for (const warning of fences.warnings) console.warn(`[mariadb] write fence: ${warning}`);
  await dropOrphans();
}

onMariaDbReady(async (reason) => {
  if (reason === "restart") {
    await recoverAfterRestart();
    return;
  }
  await recoverInterruptedWork();
  if (reason === "retry") void runStartupTasksOnce();
});

registerStartupTask("mariadb.recover", recoverInterruptedWork);

registerStartupTask("mariadb.orphans", dropOrphans);

registerStartupTask("mariadb.grants", async () => {
  const { fixed, warnings } = await manager.reconcileDatabaseGrants();
  console.log(`[startup] database grants checked; fixed ${fixed}`);
  for (const warning of warnings) console.warn(`[startup] grants: ${warning}`);
});

registerStartupTask("mariadb.readonly", async () => {
  const { created, repaired, dropped, warnings } = await reconcileReadonlyAccounts();
  console.log(`[startup] read-only viewer accounts checked; created ${created}, repaired ${repaired}, removed ${dropped}`);
  for (const warning of warnings) {
    console.warn(`[startup] read-only viewer account: ${warning}; viewer queries for it are refused until this succeeds`);
  }
});

registerStartupTask("mariadb.definers", async () => {
  const { moved, databases, warnings } = await repairMissingDefiners();
  if (moved > 0) {
    console.log(
      `[startup] moved ${moved} view(s), routine(s), trigger(s) or event(s) onto their database's own account, because their definer no longer exists or, on a mirror, is another account (${databases.join(", ")})`,
    );
  }
  for (const warning of warnings) console.warn(`[startup] definers: ${warning}`);
});

registerStartupTask("databases.reconcile", async () => {
  await reconcileDatabases();
});
