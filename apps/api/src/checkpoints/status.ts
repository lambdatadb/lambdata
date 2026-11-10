import type { CheckpointDiff, CheckpointTableDiff, WorkingCopyStatus } from "@lambdata/shared";
import { checkpoints, databases } from "../db/queries";
import type { CheckpointEntryRecord } from "../db/queries/checkpoints";
import { isDatabaseBusy } from "../jobs";
import { openAdminConnection } from "../mariadb/controller";
import { healthLimits, mariadbResponding, notRespondingMessage } from "../util/mariadbHealth";
import { collectLiveStats, liveCodeHash, type LiveStats } from "./capture";

export const STATUS_TTL_MS = 30_000;
export const AUTO_STATUS_MAX_BYTES = 2 * 1024 * 1024 * 1024;

export interface LiveSnapshot {
  stats: LiveStats;
  codeHash: string | null;
  computedAt: number;
}

interface CacheEntry {
  snapshot: LiveSnapshot;
  expiresAt: number;
}

const cache = new Map<string, CacheEntry>();
const generation = new Map<string, number>();
const inflight = new Map<string, Promise<LiveSnapshot>>();

export function invalidateWorkingCopyStatus(databaseId: string): void {
  cache.delete(databaseId);
  generation.set(databaseId, (generation.get(databaseId) ?? 0) + 1);
}

async function computeLive(databaseId: string, schema: string): Promise<LiveSnapshot> {
  const stats = await collectLiveStats(schema, false);
  const codeHash = stats.codeObjects > 0 ? await liveCodeHash(schema) : null;
  return { stats, codeHash, computedAt: Date.now() };
}

export async function liveSnapshot(databaseId: string, opts: { refresh?: boolean } = {}): Promise<LiveSnapshot> {
  const row = databases.byId(databaseId);
  if (!row) throw new Error("database not found");
  const cached = cache.get(databaseId);
  if (!opts.refresh && cached && cached.expiresAt > Date.now()) return cached.snapshot;
  const running = inflight.get(databaseId);
  if (running) return running;
  const gen = generation.get(databaseId) ?? 0;
  const work = computeLive(databaseId, row.name)
    .then((snapshot) => {
      if ((generation.get(databaseId) ?? 0) === gen) {
        cache.set(databaseId, { snapshot, expiresAt: Date.now() + STATUS_TTL_MS });
      }
      return snapshot;
    })
    .finally(() => {
      inflight.delete(databaseId);
    });
  inflight.set(databaseId, work);
  return work;
}

function tableEntries(entries: CheckpointEntryRecord[]): Map<string, CheckpointEntryRecord> {
  return new Map(entries.filter((e) => e.kind === "table").map((e) => [e.name, e]));
}

function codeHashOf(entries: CheckpointEntryRecord[]): string | null {
  return entries.find((e) => e.kind === "code")?.objectHash ?? null;
}

function sumRows(values: (number | null)[]): number | null {
  if (values.some((v) => v === null)) return null;
  return values.reduce<number>((n, v) => n + (v ?? 0), 0);
}

function sortTables(tables: CheckpointTableDiff[]): CheckpointTableDiff[] {
  return tables.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

export function diffEntries(
  fromId: string | null,
  toId: string,
  from: CheckpointEntryRecord[],
  to: CheckpointEntryRecord[],
): CheckpointDiff {
  const before = tableEntries(from);
  const after = tableEntries(to);
  const tables: CheckpointTableDiff[] = [];
  let unchanged = 0;
  for (const [name, a] of after) {
    const b = before.get(name);
    if (!b) {
      tables.push({ name, change: "added", schemaChanged: true, rowsBefore: null, rowsAfter: a.rowCount });
    } else if (b.objectHash !== a.objectHash) {
      tables.push({
        name,
        change: "modified",
        schemaChanged: b.schemaHash !== a.schemaHash,
        rowsBefore: b.rowCount,
        rowsAfter: a.rowCount,
      });
    } else {
      unchanged++;
    }
  }
  for (const [name, b] of before) {
    if (!after.has(name)) {
      tables.push({ name, change: "removed", schemaChanged: true, rowsBefore: b.rowCount, rowsAfter: null });
    }
  }
  const beforeRows = sumRows([...before.values()].map((e) => e.rowCount));
  const afterRows = sumRows([...after.values()].map((e) => e.rowCount));
  return {
    fromId,
    toId,
    tables: sortTables(tables),
    codeChanged: codeHashOf(from) !== codeHashOf(to),
    unchangedTables: unchanged,
    rowDelta: beforeRows !== null && afterRows !== null ? afterRows - beforeRows : null,
  };
}

export function diffAgainstLive(fromId: string, from: CheckpointEntryRecord[], live: LiveSnapshot): CheckpointDiff {
  const before = tableEntries(from);
  const tables: CheckpointTableDiff[] = [];
  let unchanged = 0;
  const liveNames = new Set<string>();
  for (const t of live.stats.tables) {
    liveNames.add(t.name);
    const b = before.get(t.name);
    if (!b) {
      tables.push({ name: t.name, change: "added", schemaChanged: true, rowsBefore: null, rowsAfter: t.rowCount });
      continue;
    }
    const schemaChanged = b.schemaHash === null || b.schemaHash !== t.schemaHash;
    const dataChanged = b.checksum === null || t.checksum === null || b.checksum !== t.checksum || b.rowCount !== t.rowCount;
    const counterChanged =
      b.autoIncrement !== null && b.autoIncrement !== undefined && t.autoIncrement !== null && t.autoIncrement !== undefined && b.autoIncrement !== t.autoIncrement;
    if (schemaChanged || dataChanged || counterChanged) {
      tables.push({ name: t.name, change: "modified", schemaChanged, rowsBefore: b.rowCount, rowsAfter: t.rowCount });
    } else {
      unchanged++;
    }
  }
  for (const [name, b] of before) {
    if (!liveNames.has(name)) {
      tables.push({ name, change: "removed", schemaChanged: true, rowsBefore: b.rowCount, rowsAfter: null });
    }
  }
  const beforeRows = sumRows([...before.values()].map((e) => e.rowCount));
  const afterRows = sumRows(live.stats.tables.map((t) => t.rowCount));
  return {
    fromId,
    toId: "working",
    tables: sortTables(tables),
    codeChanged: codeHashOf(from) !== live.codeHash,
    unchangedTables: unchanged,
    rowDelta: beforeRows !== null && afterRows !== null ? afterRows - beforeRows : null,
  };
}

export async function unlessFrozen<T>(start: () => Promise<T>): Promise<{ value: T } | null> {
  if (!(await mariadbResponding())) return null;
  const work = start();
  for (;;) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), healthLimits.timeoutMs);
    });
    try {
      const done = await Promise.race([work.then((value) => ({ value })), tick]);
      if (done) return done;
    } finally {
      clearTimeout(timer);
    }
    if (!(await mariadbResponding())) {
      work.catch(() => {});
      return null;
    }
  }
}

export async function boundedLiveSnapshot(databaseId: string, opts: { refresh?: boolean } = {}): Promise<LiveSnapshot | null> {
  const cached = cache.get(databaseId);
  if (!opts.refresh && cached && cached.expiresAt > Date.now()) return cached.snapshot;
  return (await unlessFrozen(() => liveSnapshot(databaseId, opts)))?.value ?? null;
}

function isClean(diff: CheckpointDiff): boolean {
  return diff.tables.length === 0 && !diff.codeChanged;
}

export async function getWorkingCopyStatus(
  databaseId: string,
  opts: { refresh?: boolean; force?: boolean } = {},
): Promise<WorkingCopyStatus> {
  const row = databases.byId(databaseId);
  if (!row) throw new Error("database not found");
  const baseId = row.baseCheckpointId;
  const base = baseId ? checkpoints.byId(baseId) : null;
  const status = (state: WorkingCopyStatus["state"], reason: string | null, computedAt: number | null = null) => ({
    databaseId,
    baseCheckpointId: base?.id ?? null,
    state,
    reason,
    computedAt,
    diff: null,
  });
  if (!base || base.databaseId !== databaseId) {
    if (checkpoints.countForDatabase(databaseId) === 0) return status("no-checkpoint", null);
    return status("unknown", "The working copy is not linked to a checkpoint; create one to start tracking changes.");
  }
  if (base.format === "legacy") {
    return status(
      "unknown",
      "The base checkpoint is an imported snapshot without per-table data; create a checkpoint to start tracking changes.",
    );
  }
  const cached = cache.get(databaseId);
  const fresh = cached && cached.expiresAt > Date.now() ? cached.snapshot : null;
  if (!opts.force && isDatabaseBusy(databaseId) && !fresh) {
    return status("unknown", "A job is running on this database; status will be available when it finishes.");
  }
  if (!opts.refresh && !opts.force && !fresh) {
    const size = await unlessFrozen(() => collectSizeHint(row.name));
    if (!size) return status("unknown", notRespondingMessage());
    if ((size.value ?? 0) > AUTO_STATUS_MAX_BYTES) {
      return status("unknown", "This database is larger than 2 GB, so status is not computed automatically. Check now to compute it.");
    }
  }
  const live = fresh && !opts.refresh ? fresh : await boundedLiveSnapshot(databaseId, { refresh: opts.refresh || opts.force });
  if (!live) return status("unknown", notRespondingMessage());
  const diff = diffAgainstLive(base.id, checkpoints.entries(base.id), live);
  return {
    databaseId,
    baseCheckpointId: base.id,
    state: isClean(diff) ? "clean" : "dirty",
    reason: null,
    computedAt: live.computedAt,
    diff,
  };
}

async function collectSizeHint(schema: string): Promise<number | null> {
  const conn = await openAdminConnection();
  try {
    const [rows] = await conn.query(
      `SELECT COALESCE(SUM(DATA_LENGTH + INDEX_LENGTH), 0) AS n FROM information_schema.TABLES WHERE TABLE_SCHEMA = ?`,
      [schema],
    );
    return Number((rows as { n: unknown }[])[0]?.n ?? 0);
  } catch {
    return null;
  } finally {
    await conn.end().catch(() => conn.destroy());
  }
}
