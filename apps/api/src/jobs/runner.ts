import { AsyncLocalStorage } from "node:async_hooks";
import type { Job, JobErrorCode, JobErrorDetails, JobKind, JobStatus } from "@lambdata/shared";
import { databases, jobs as jobStore } from "../db/queries";
import { env } from "../env";
import { assertDiskRoom, lowSpaceWarning } from "../util/disk";
import { newId } from "../util/id";
import { notifyJobFinished } from "../notifications/bus";
import { sanitizeErrorMessage } from "./sanitize";

export interface JobContext {
  readonly jobId: string;
  readonly databaseId: string | null;
  stage(label: string): void;
  progress(fraction: number | null): void;
  warn(message: string): void;
}

export interface StartJobOptions {
  kind: JobKind;
  databaseId: string | null;
  userId: string | null;
  exclusive?: boolean;
}

export type JobWork = (ctx: JobContext) => Promise<object | null | undefined | void>;

const BUSY_TEXT: Record<JobKind, { running: (db: string) => string; queued: (db: string) => string }> = {
  "checkpoint.create": {
    running: (db) => `A checkpoint of ${db} is being created right now`,
    queued: (db) => `A checkpoint of ${db} is waiting to start`,
  },
  "checkpoint.restore": {
    running: (db) => `${db} is being rolled back to a checkpoint right now`,
    queued: (db) => `A rollback of ${db} is waiting to start`,
  },
  "sync.run": {
    running: (db) => `${db} is syncing from its source right now`,
    queued: (db) => `A sync of ${db} is waiting to start`,
  },
  "import.sqlite": {
    running: (db) => `A SQLite file is being imported into ${db} right now`,
    queued: (db) => `An import into ${db} is waiting to start`,
  },
  "import.sql": {
    running: (db) => `A SQL dump is being imported into ${db} right now`,
    queued: (db) => `An import into ${db} is waiting to start`,
  },
};

function databaseLabel(databaseId: string): string {
  try {
    const name = databases.byId(databaseId)?.displayName;
    if (name) return `"${name}"`;
  } catch {}
  return "this database";
}

interface ConflictHolder {
  id: string;
  kind: JobKind | null;
  status: JobStatus | null;
}

export function jobConflictMessage(databaseId: string, job: Pick<ConflictHolder, "kind" | "status">): string {
  const db = databaseLabel(databaseId);
  const text = job.kind ? BUSY_TEXT[job.kind] : undefined;
  const busy = text ? (job.status === "queued" ? text.queued(db) : text.running(db)) : `Another operation on ${db} is in progress`;
  const sentence = busy.charAt(0).toUpperCase() + busy.slice(1);
  return `${sentence}. Try again when it has finished.`;
}

export class JobConflictError extends Error {
  readonly databaseId: string;
  readonly jobId: string;

  constructor(databaseId: string, job: ConflictHolder) {
    super(jobConflictMessage(databaseId, job));
    this.name = "JobConflictError";
    this.databaseId = databaseId;
    this.jobId = job.id;
  }
}

export class JobFailure extends Error {
  readonly code: JobErrorCode;
  readonly details: JobErrorDetails | null;

  constructor(message: string, code: JobErrorCode, details: JobErrorDetails | null = null, options?: ErrorOptions) {
    super(message, options);
    this.name = "JobFailure";
    this.code = code;
    this.details = details;
  }
}

const DISK_ACTIONS: Partial<Record<JobKind, string>> = {
  "checkpoint.create": "create a checkpoint",
  "checkpoint.restore": "roll back to a checkpoint (it first saves a checkpoint and loads a full copy)",
  "sync.run": "sync this mirror (it loads a full copy of the source)",
};

interface ActiveJob {
  job: Job;
  exclusive: boolean;
  work: JobWork;
  dirty: boolean;
  lastFlush: number;
  flushTimer: ReturnType<typeof setTimeout> | null;
  finished: boolean;
  done: Promise<Job>;
  resolve: (job: Job) => void;
}

export const PERSIST_INTERVAL_MS = 500;
export const JOB_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
export const INTERRUPTED_MESSAGE = "interrupted by restart";
export const SWAP_DONE_KEY = "swapCompletedNote";
const MAX_WARNINGS = 200;

const active = new Map<string, ActiveJob>();
const queue: ActiveJob[] = [];
const exclusiveHolder = new Map<string, string>();
const opsActive = new Map<string, number>();
const opChains = new Map<string, Promise<void>>();
const lockScope = new AsyncLocalStorage<ReadonlySet<string>>();
let runningCount = 0;

function copy(job: Job): Job {
  return {
    ...job,
    errorDetails: job.errorDetails ? { ...job.errorDetails } : null,
    warnings: [...job.warnings],
    result: job.result ? { ...job.result } : null,
  };
}

function detailsOf(details: JobErrorDetails | null): JobErrorDetails | null {
  if (!details) return null;
  const out: JobErrorDetails = {};
  if (typeof details.checkpointId === "string") out.checkpointId = details.checkpointId;
  if (details.codeFailures) {
    out.codeFailures = details.codeFailures.slice(0, 200).map((f) => ({
      kind: String(f.kind),
      name: String(f.name),
      error: sanitizeErrorMessage(f.error).slice(0, 1000),
    }));
  }
  return out;
}

function maxConcurrent(): number {
  return Math.max(1, env.maxConcurrentJobs);
}

function flush(entry: ActiveJob): void {
  if (entry.flushTimer) {
    clearTimeout(entry.flushTimer);
    entry.flushTimer = null;
  }
  if (!entry.dirty) return;
  entry.dirty = false;
  entry.lastFlush = Date.now();
  try {
    jobStore.save(entry.job);
  } catch (err) {
    console.error(`[jobs] could not persist job ${entry.job.id}:`, sanitizeErrorMessage(err));
  }
}

function forceFlush(entry: ActiveJob): void {
  entry.dirty = true;
  flush(entry);
}

function scheduleFlush(entry: ActiveJob): void {
  entry.dirty = true;
  if (entry.flushTimer) return;
  const wait = entry.lastFlush + PERSIST_INTERVAL_MS - Date.now();
  if (wait <= 0) {
    flush(entry);
    return;
  }
  entry.flushTimer = setTimeout(() => {
    entry.flushTimer = null;
    flush(entry);
  }, wait);
}

function makeContext(entry: ActiveJob): JobContext {
  return {
    jobId: entry.job.id,
    databaseId: entry.job.databaseId,
    stage(label: string) {
      if (entry.finished) return;
      entry.job.stage = String(label).slice(0, 200);
      scheduleFlush(entry);
    },
    progress(fraction: number | null) {
      if (entry.finished) return;
      entry.job.progress =
        fraction === null || !Number.isFinite(fraction) ? null : Math.min(1, Math.max(0, fraction));
      scheduleFlush(entry);
    },
    warn(message: string) {
      if (entry.finished || entry.job.warnings.length >= MAX_WARNINGS) return;
      entry.job.warnings.push(sanitizeErrorMessage(message).slice(0, 1000));
      scheduleFlush(entry);
    },
  };
}

function normalizeResult(result: unknown): Record<string, unknown> | null {
  if (result === null || result === undefined) return null;
  if (typeof result !== "object" || Array.isArray(result)) {
    throw new Error("job result must be an object");
  }
  const text = JSON.stringify(result, (_key, value) =>
    typeof value === "bigint" ? value.toString() : value,
  );
  return JSON.parse(text) as Record<string, unknown>;
}

function releaseExclusive(entry: ActiveJob): void {
  const dbId = entry.job.databaseId;
  if (entry.exclusive && dbId && exclusiveHolder.get(dbId) === entry.job.id) {
    exclusiveHolder.delete(dbId);
  }
}

async function execute(entry: ActiveJob): Promise<void> {
  entry.job.status = "running";
  entry.job.startedAt = Date.now();
  forceFlush(entry);
  const scope = new Set<string>();
  if (entry.exclusive && entry.job.databaseId) scope.add(entry.job.databaseId);
  try {
    const result = await lockScope.run(scope, () => entry.work(makeContext(entry)));
    entry.job.result = normalizeResult(result);
    entry.job.status = "succeeded";
  } catch (err) {
    entry.job.status = "failed";
    entry.job.error = sanitizeErrorMessage(err);
    if (err instanceof JobFailure) {
      entry.job.errorCode = err.code;
      entry.job.errorDetails = detailsOf(err.details);
    }
  } finally {
    entry.finished = true;
    entry.job.finishedAt = Date.now();
    forceFlush(entry);
    active.delete(entry.job.id);
    releaseExclusive(entry);
    runningCount--;
    notifyJobFinished(copy(entry.job));
    entry.resolve(copy(entry.job));
    pump();
  }
}

function pump(): void {
  for (let i = 0; i < queue.length && runningCount < maxConcurrent(); ) {
    const entry = queue[i]!;
    const dbId = entry.job.databaseId;
    if (entry.exclusive && dbId && (opsActive.get(dbId) ?? 0) > 0) {
      i++;
      continue;
    }
    queue.splice(i, 1);
    runningCount++;
    void Promise.resolve()
      .then(() => execute(entry))
      .catch((err) => console.error(`[jobs] job ${entry.job.id} crashed:`, sanitizeErrorMessage(err)));
  }
}

function holderJob(jobId: string): ConflictHolder {
  const entry = active.get(jobId);
  if (entry) return entry.job;
  return jobStore.byId(jobId) ?? { id: jobId, kind: null, status: null };
}

export function startJob(opts: StartJobOptions, work: JobWork): Job {
  const databaseId = opts.databaseId ?? null;
  const exclusive = databaseId !== null && opts.exclusive !== false;
  if (exclusive) {
    const holder = exclusiveHolder.get(databaseId);
    if (holder) throw new JobConflictError(databaseId, holderJob(holder));
  }
  const diskAction = DISK_ACTIONS[opts.kind];
  const disk = diskAction ? assertDiskRoom(diskAction) : null;
  const lowSpace = disk ? lowSpaceWarning(disk) : null;
  const now = Date.now();
  const job: Job = {
    id: newId("job"),
    kind: opts.kind,
    databaseId,
    status: "queued",
    stage: null,
    progress: null,
    error: null,
    errorCode: null,
    errorDetails: null,
    warnings: lowSpace ? [lowSpace] : [],
    result: null,
    createdByUserId: opts.userId ?? null,
    createdAt: now,
    startedAt: null,
    finishedAt: null,
  };
  jobStore.insert({ ...job, exclusive });
  let resolve!: (job: Job) => void;
  const done = new Promise<Job>((r) => {
    resolve = r;
  });
  const entry: ActiveJob = {
    job,
    exclusive,
    work,
    dirty: false,
    lastFlush: 0,
    flushTimer: null,
    finished: false,
    done,
    resolve,
  };
  active.set(job.id, entry);
  if (exclusive) exclusiveHolder.set(databaseId, job.id);
  queue.push(entry);
  pump();
  return copy(job);
}

export async function runExclusive<T>(databaseId: string, fn: () => Promise<T> | T): Promise<T> {
  if (lockScope.getStore()?.has(databaseId)) return await fn();
  const assertFree = (): void => {
    const holder = exclusiveHolder.get(databaseId);
    if (holder) throw new JobConflictError(databaseId, holderJob(holder));
  };
  assertFree();
  const previous = opChains.get(databaseId) ?? Promise.resolve();
  let release!: () => void;
  const mine = new Promise<void>((r) => {
    release = r;
  });
  const chained = previous.then(() => mine);
  opChains.set(databaseId, chained);
  await previous;
  opsActive.set(databaseId, (opsActive.get(databaseId) ?? 0) + 1);
  try {
    assertFree();
    const scope = new Set(lockScope.getStore() ?? []);
    scope.add(databaseId);
    return await lockScope.run(scope, async () => await fn());
  } finally {
    const left = (opsActive.get(databaseId) ?? 1) - 1;
    if (left > 0) opsActive.set(databaseId, left);
    else opsActive.delete(databaseId);
    release();
    if (opChains.get(databaseId) === chained) opChains.delete(databaseId);
    pump();
  }
}

export function isDatabaseBusy(databaseId: string): boolean {
  return exclusiveHolder.has(databaseId) || (opsActive.get(databaseId) ?? 0) > 0;
}

export function activeJobFor(databaseId: string): Job | null {
  const holder = exclusiveHolder.get(databaseId);
  const entry = holder ? active.get(holder) : undefined;
  return entry ? copy(entry.job) : null;
}

export function hasActiveJobs(): boolean {
  return active.size > 0;
}

export function hasActiveWork(): boolean {
  return active.size > 0 || opsActive.size > 0;
}

export function getJob(id: string): Job | null {
  const entry = active.get(id);
  if (entry) return copy(entry.job);
  return jobStore.byId(id);
}

export function withLiveState(list: Job[]): Job[] {
  return list.map((job) => {
    const entry = active.get(job.id);
    return entry ? copy(entry.job) : job;
  });
}

export async function waitForJob(id: string): Promise<Job | null> {
  const entry = active.get(id);
  if (entry) return entry.done;
  return jobStore.byId(id);
}

export function recordSwapOutcome(jobId: string, result: Record<string, unknown>, warning: string): boolean {
  const entry = active.get(jobId);
  if (!entry || entry.finished) return false;
  entry.job.result = normalizeResult({ ...result, [SWAP_DONE_KEY]: warning });
  forceFlush(entry);
  return true;
}

export function recoverInterruptedJobs(now: number = Date.now()): { failed: number; pruned: number; completed: number } {
  const completed = jobStore.finishCompletedSwaps(SWAP_DONE_KEY, now);
  const failed = jobStore.failInterrupted(INTERRUPTED_MESSAGE, now);
  const pruned = jobStore.pruneFinishedBefore(now - JOB_RETENTION_MS);
  if (completed > 0) console.warn(`[jobs] marked ${completed} job(s) as succeeded: their tables were already swapped in when LambData stopped`);
  if (failed > 0) console.warn(`[jobs] marked ${failed} interrupted job(s) as failed`);
  return { failed, pruned, completed };
}
