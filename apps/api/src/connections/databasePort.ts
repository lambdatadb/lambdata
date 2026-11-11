import type { DatabasePortStatus } from "@lambdata/shared";
import { databases, jobs } from "../db/queries";
import { env } from "../env";
import { hasActiveWork, jobConflictMessage } from "../jobs/runner";
import { mariadbExpected, rebindMariaDb, type RebindOutcome } from "../mariadb/controller";
import { isWriteFenced } from "../mariadb/writeFence";
import { swapInProgress } from "../mariadb/schemaSwap";
import { bindFor, isLoopbackBind, resolveDatabaseBind, saveOutsideConnections } from "./bind";
import { rejectionsSupported } from "./capture";

export class DatabasePortBusyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DatabasePortBusyError";
  }
}

export class DatabasePortLockedError extends Error {
  constructor() {
    super(
      "The database address is set by the container's LAMBDATA_MARIADB_BIND variable, which always wins. Change or remove that variable and restart the container to change it.",
    );
    this.name = "DatabasePortLockedError";
  }
}

export class DatabasePortRestartError extends Error {
  readonly restored: boolean;

  constructor(message: string, restored: boolean) {
    super(message);
    this.name = "DatabasePortRestartError";
    this.restored = restored;
  }
}

export function databasePortStatus(): DatabasePortStatus {
  const resolved = resolveDatabaseBind();
  const bind = env.mariadbBind;
  return {
    bind,
    port: env.mariadbPort,
    outsideConnections: !isLoopbackBind(bind),
    source: resolved.source,
    lockedByEnv: resolved.lockedByEnv,
    inContainer: env.inContainer,
    rejectionsSupported: rejectionsSupported(),
  };
}

function closedDatabases(): string[] {
  return databases
    .list()
    .filter((d) => isWriteFenced(d.id) || swapInProgress(d.id) || swapInProgress(d.name))
    .map((d) => d.displayName);
}

export function assertDatabasePortIdle(): void {
  const closed = closedDatabases();
  if (closed.length > 0) {
    const list = closed.join(", ");
    throw new DatabasePortBusyError(
      `${list} ${closed.length === 1 ? "is" : "are"} closed for a rollback, import or sync right now, and restarting MariaDB would interrupt it. Try again when it has finished.`,
    );
  }
  const active = jobs.list({ activeOnly: true, limit: 1 })[0];
  if (active) {
    if (active.databaseId) throw new DatabasePortBusyError(jobConflictMessage(active.databaseId, active));
    throw new DatabasePortBusyError("A background job is running right now. Try again when it has finished.");
  }
  if (hasActiveWork()) {
    throw new DatabasePortBusyError("An operation on a database is running right now. Try again when it has finished.");
  }
}

export async function setOutsideConnections(on: boolean): Promise<{ status: DatabasePortStatus; outcome: RebindOutcome }> {
  if (resolveDatabaseBind().lockedByEnv) throw new DatabasePortLockedError();
  const next = bindFor(on);
  const wasExpected = mariadbExpected();
  if (!wasExpected) saveOutsideConnections(on);
  let outcome: RebindOutcome;
  try {
    outcome = await rebindMariaDb(next, assertDatabasePortIdle);
  } catch (err) {
    if (err instanceof DatabasePortBusyError) throw err;
    throw new DatabasePortRestartError(err instanceof Error ? err.message : String(err), true);
  }
  if (outcome.ok) {
    saveOutsideConnections(on);
    return { status: databasePortStatus(), outcome };
  }
  const where = on ? "on every network address" : "on this machine only";
  throw new DatabasePortRestartError(
    outcome.restored
      ? `MariaDB did not start ${where} (${outcome.error}), so LambData went back to the previous setting and MariaDB is running again as before.`
      : `MariaDB did not start ${where} (${outcome.error}), and it did not come back on the previous setting either. LambData keeps retrying with the previous setting.`,
    outcome.restored,
  );
}
