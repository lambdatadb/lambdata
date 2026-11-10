import type { RowDataPacket } from "mysql2/promise";
import { checkpoints, databases } from "../db/queries";
import { withRootConnection } from "../mariadb/controller";
import { sanitizeMariaDbMessage } from "../mariadb/messages";
import {
  SwapBlockedError,
  SwapRefusedError,
  SwapStaleError,
  swapStagingIntoLive,
  type ExpectLive,
  type SwapOptions,
  type SwapPhase,
  type SwapResult,
} from "../mariadb/schemaSwap";
import { deleteCheckpointRecord } from "./manage";

export const STALE_RETRIES = 3;

export const checkpointSwap = {
  run(opts: SwapOptions): Promise<SwapResult> {
    return swapStagingIntoLive(opts);
  },
};

export interface SafetyPoint {
  checkpointId: string | null;
  created: boolean;
  expectLive: ExpectLive;
}

export function expectLiveFrom(checkpointId: string | null, capturedAt: number): ExpectLive {
  const tables = checkpointId
    ? checkpoints
        .entries(checkpointId)
        .filter((e) => e.kind === "table")
        .map((e) => ({ name: e.name, rowCount: e.rowCount, checksum: e.checksum }))
    : [];
  return { tables, capturedAt };
}

export async function safetyPoint(
  databaseId: string,
  take: () => Promise<string | null>,
): Promise<SafetyPoint> {
  const capturedAt = Date.now();
  const id = await take();
  const used = id ?? databases.byId(databaseId)?.baseCheckpointId ?? null;
  return { checkpointId: used, created: id !== null, expectLive: expectLiveFrom(used, capturedAt) };
}

export async function discardSafetyPoint(databaseId: string, safety: SafetyPoint | null): Promise<boolean> {
  if (!safety?.created || !safety.checkpointId || !checkpoints.exists(safety.checkpointId)) return false;
  try {
    await deleteCheckpointRecord(databaseId, safety.checkpointId);
    return true;
  } catch (err) {
    console.warn(`[checkpoints] could not remove the unused safety checkpoint ${safety.checkpointId}:`, err instanceof Error ? err.message : String(err));
    return false;
  }
}

export function isStale(err: unknown): err is SwapStaleError {
  return err instanceof SwapStaleError;
}

export function changedNothing(err: unknown, phase: SwapPhase | null): boolean {
  if (err instanceof SwapBlockedError || err instanceof SwapRefusedError || err instanceof SwapStaleError) return true;
  return phase === null || phase === "prepared";
}

export function staleFailure(subject: string, changed: string[]): Error {
  const list = changed.slice(0, 8).join(", ") + (changed.length > 8 ? `, and ${changed.length - 8} more` : "");
  return new Error(
    `${subject} was not done: ${list} kept changing while their safety checkpoint was taken, although this database's own account was closed to writes. Something other than its own account is writing to them (another MariaDB account, or a scheduled event). Nothing was changed. Stop that writer, or let it finish, and try again.`,
  );
}

export class PhaseTracker {
  private last: SwapPhase | null = null;

  readonly onPhase = (phase: SwapPhase): void => {
    this.last = phase;
  };

  get phase(): SwapPhase | null {
    return this.last;
  }

  reset(): void {
    this.last = null;
  }

  explain(err: unknown): Error {
    const message = sanitizeMariaDbMessage(err instanceof Error ? err.message : String(err));
    if (err instanceof Error) err.message = message;
    if (/nothing was changed|new tables are in place|was left exactly as it was|put back automatically/i.test(message)) {
      return err instanceof Error ? err : new Error(message);
    }
    let note: string;
    if (changedNothing(err, this.last)) {
      note = "Nothing was changed.";
    } else if (this.last === "moved-out") {
      note = "It stopped part-way through the swap; LambData puts the database back as it was automatically when MariaDB is available again or at the next start.";
    } else {
      note = "The new tables were already in place; LambData finishes re-creating views, triggers and routines automatically when MariaDB is available again or at the next start.";
    }
    const out = new Error(`${message.replace(/\.?\s*$/, ".")} ${note}`, { cause: err });
    out.name = err instanceof Error ? err.name : "Error";
    return out;
  }
}

export async function stagingExists(name: string): Promise<boolean> {
  return withRootConnection(async (c) => {
    const [rows] = await c.query<RowDataPacket[]>("SELECT COUNT(*) AS n FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = ?", [name]);
    return Number(rows[0]?.n ?? 0) > 0;
  });
}

export function staleRetryNote(changed: string[]): string {
  const list = changed.slice(0, 5).join(", ") + (changed.length > 5 ? `, and ${changed.length - 5} more` : "");
  return `The database changed after its safety checkpoint was taken (${list}), so nothing was swapped yet; the safety checkpoint is taken again and the swap retried.`;
}

export function connectionsClosedWarning(n: number, what: string): string | null {
  if (n <= 0) return null;
  return `${n} connection(s) of this database's own account were closed ${what}`;
}
