import type { RowDataPacket } from "mysql2/promise";
import { checkpoints, databases } from "../db/queries";
import { isDatabaseBusy, JobConflictError, startJob, waitForJob } from "../jobs";
import { registerService, safeTick, type BackgroundService } from "../lifecycle";
import { mariadbState, withRootConnection } from "../mariadb/controller";
import { DiskSpaceError } from "../util/disk";
import { createCheckpoint } from "./index";
import { collectGarbage } from "./manage";
import { legacyConversionHasRun, retryFailedConversions, snapshotAwaitingConversion } from "./startup";

const HOUR_MS = 60 * 60 * 1000;
const TICK_MS = HOUR_MS;
const FIRST_TICK_MS = 3 * 60 * 1000;
const DUE_TOLERANCE_MS = 10 * 60 * 1000;
const SKIP_LOG_INTERVAL_MS = HOUR_MS;
const FOLLOW_UP_MS = 3 * 60 * 1000;
const JOB_WAIT_CAP_MS = 2 * HOUR_MS;
const MAX_FOLLOW_UPS = 20;

const lastDiskSkipLog = new Map<string, number>();

function capped<T>(p: Promise<T>, ms: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const cap = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), ms);
    timer.unref?.();
  });
  return Promise.race([p, cap]).finally(() => clearTimeout(timer));
}

export function lastAutomaticCheck(databaseId: string): number | null {
  const checked = checkpoints.lastScheduledCheck(databaseId);
  const created = checkpoints.lastCreatedAt(databaseId, "scheduled");
  if (checked === null && created === null) return null;
  return Math.max(checked ?? 0, created ?? 0);
}

export function isScheduledCheckpointDue(databaseId: string, now: number): boolean {
  const { autoIntervalHours } = checkpoints.policy(databaseId);
  if (autoIntervalHours <= 0) return false;
  const last = lastAutomaticCheck(databaseId);
  return last === null || now - last >= autoIntervalHours * HOUR_MS - DUE_TOLERANCE_MS;
}

export function noteSkippedForDisk(scope: string, err: DiskSpaceError, now: number = Date.now()): void {
  const last = lastDiskSkipLog.get(scope) ?? 0;
  if (last !== 0 && now - last < SKIP_LOG_INTERVAL_MS) return;
  lastDiskSkipLog.set(scope, now);
  console.warn(`[${scope}] skipping this round: ${err.message}`);
}

export function startScheduledCheckpoint(databaseId: string): string | null {
  const startedAt = Date.now();
  try {
    const job = startJob({ kind: "checkpoint.create", databaseId, userId: null }, async (ctx) => {
      const result = await createCheckpoint(databaseId, { trigger: "scheduled", hooks: ctx });
      checkpoints.markScheduledCheck(databaseId, startedAt);
      try {
        await collectGarbage(databaseId);
      } catch (err) {
        ctx.warn(`could not clean up unused checkpoint files: ${err instanceof Error ? err.message : String(err)}`);
      }
      return result;
    });
    return job.id;
  } catch (err) {
    if (err instanceof JobConflictError) return null;
    throw err;
  }
}

interface SchemaFacts {
  tables: number;
  bytes: number;
}

async function schemaFacts(): Promise<Map<string, SchemaFacts>> {
  return withRootConnection(async (c) => {
    const [rows] = await c.query<RowDataPacket[]>(
      `SELECT TABLE_SCHEMA AS s, COUNT(*) AS n, COALESCE(SUM(DATA_LENGTH + INDEX_LENGTH), 0) AS b
         FROM information_schema.TABLES WHERE TABLE_TYPE IN ('BASE TABLE', 'SYSTEM VERSIONED', 'SEQUENCE')
        GROUP BY TABLE_SCHEMA`,
    );
    return new Map(rows.map((r) => [String(r.s), { tables: Number(r.n ?? 0), bytes: Number(r.b ?? 0) }]));
  });
}

export async function dueScheduledCheckpoints(now: number = Date.now()): Promise<string[]> {
  const facts = await schemaFacts();
  return databases
    .list()
    .filter((d) => d.status === "active" && databases.provisionStateOf(d.id) === null)
    .filter((d) => (facts.get(d.name)?.tables ?? 0) > 0)
    .filter((d) => !snapshotAwaitingConversion(d.id))
    .filter((d) => isScheduledCheckpointDue(d.id, now))
    .sort((a, b) => (facts.get(a.name)?.bytes ?? 0) - (facts.get(b.name)?.bytes ?? 0) || (a.name < b.name ? -1 : 1))
    .map((d) => d.id);
}

export async function runScheduledCheckpoints(now: number = Date.now()): Promise<string[]> {
  if (mariadbState() !== "running") return [];
  await retryFailedConversions(now).catch((err) => {
    console.error("[checkpoints] retrying legacy snapshot conversion failed:", err instanceof Error ? err.message : String(err));
  });
  const started: string[] = [];
  for (const id of await dueScheduledCheckpoints(now)) {
    if (mariadbState() !== "running") break;
    const row = databases.byId(id);
    if (!row || isDatabaseBusy(id) || !isScheduledCheckpointDue(id, Date.now())) continue;
    let jobId: string | null;
    try {
      jobId = startScheduledCheckpoint(id);
    } catch (err) {
      if (err instanceof DiskSpaceError) {
        noteSkippedForDisk("checkpoints", err);
        break;
      }
      console.error(`[checkpoints] could not schedule a checkpoint for ${row.name}:`, err instanceof Error ? err.message : String(err));
      continue;
    }
    if (!jobId) continue;
    started.push(jobId);
    await capped(waitForJob(jobId), JOB_WAIT_CAP_MS);
  }
  return started;
}

function waitingForConversion(): boolean {
  if (!legacyConversionHasRun()) return true;
  return databases.list().some((d) => snapshotAwaitingConversion(d.id));
}

function schedulerService(): BackgroundService {
  let first: ReturnType<typeof setTimeout> | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;
  let followUps = 0;
  let busy = false;
  const tick = safeTick("checkpoints", () => runScheduledCheckpoints());
  const run = (): void => {
    if (busy) return;
    busy = true;
    tick().finally(() => {
      busy = false;
      if (timer && followUps < MAX_FOLLOW_UPS && (mariadbState() !== "running" || waitingForConversion())) {
        followUps++;
        first = setTimeout(run, FOLLOW_UP_MS);
      }
    });
  };
  return {
    name: "checkpoints",
    start() {
      if (timer) return;
      first = setTimeout(run, FIRST_TICK_MS);
      timer = setInterval(run, TICK_MS);
    },
    stop() {
      if (first) clearTimeout(first);
      if (timer) clearInterval(timer);
      first = null;
      timer = null;
    },
    running() {
      return timer !== null;
    },
  };
}

export const checkpointsService = registerService(schedulerService());
