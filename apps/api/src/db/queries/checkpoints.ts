import type {
  Checkpoint,
  CheckpointEntry,
  CheckpointFormat,
  CheckpointPolicy,
  CheckpointStorageStats,
  CheckpointTrigger,
  ManualSyncCheckpointMode,
  UnconvertedSnapshot,
} from "@lambdata/shared";
import { db } from "../client";

export type EntryKind = CheckpointEntry["kind"];

export interface CheckpointEntryRecord {
  kind: EntryKind;
  name: string;
  objectHash: string;
  rowCount: number | null;
  logicalBytes: number;
  storedBytes: number;
  schemaHash: string | null;
  checksum: number | null;
  autoIncrement?: number | null;
}

export interface NewCheckpoint {
  id: string;
  databaseId: string;
  hash: string;
  treeHash: string | null;
  parentId: string | null;
  message: string;
  trigger: CheckpointTrigger;
  format: CheckpointFormat;
  createdByUserId: string | null;
  createdAt: number;
  tableCount: number | null;
  rowCount: number | null;
  logicalBytes: number;
  storedBytes: number;
  newBytes: number;
  schemaCharset?: string | null;
  schemaCollation?: string | null;
  limitations?: string[];
}

export const AUTOMATIC_TRIGGERS: readonly CheckpointTrigger[] = [
  "scheduled",
  "sync",
  "pre-sync",
  "pre-restore",
  "pre-import",
];

export type RetentionGroup = "automatic" | "safety";

export const RETENTION_GROUPS: Record<RetentionGroup, readonly CheckpointTrigger[]> = {
  automatic: ["scheduled", "sync"],
  safety: ["pre-sync", "pre-restore", "pre-import"],
};

export const MANUAL_SYNC_CHECKPOINT_MODES: readonly ManualSyncCheckpointMode[] = ["ask", "always", "never"];

function manualModeOf(raw: unknown): ManualSyncCheckpointMode {
  return MANUAL_SYNC_CHECKPOINT_MODES.includes(raw as ManualSyncCheckpointMode) ? (raw as ManualSyncCheckpointMode) : "ask";
}

export function retentionGroupOf(trigger: CheckpointTrigger): RetentionGroup | null {
  for (const [group, triggers] of Object.entries(RETENTION_GROUPS) as [RetentionGroup, readonly CheckpointTrigger[]][]) {
    if (triggers.includes(trigger)) return group;
  }
  return null;
}

export const DEFAULT_POLICY: Omit<CheckpointPolicy, "versioned"> = {
  autoIntervalHours: 24,
  autoRetention: 7,
  checkpointOnSync: true,
  manualSyncCheckpoint: "ask",
};

type CheckpointRow = {
  id: string;
  database_id: string;
  hash: string;
  tree_hash: string | null;
  parent_id: string | null;
  message: string;
  trigger: CheckpointTrigger;
  format: CheckpointFormat;
  created_by_user_id: string | null;
  created_by_display_name: string | null;
  created_at: number;
  table_count: number | null;
  row_count: number | null;
  logical_bytes: number;
  stored_bytes: number;
  new_bytes: number;
  pinned: number;
  is_base: number | null;
  schema_charset: string | null;
  schema_collation: string | null;
  limitations: string | null;
  verified_at: number | null;
};

type FailureRow = {
  snapshot_id: string;
  database_id: string;
  reason: string;
  failed_at: number;
  attempts: number;
  created_at: number | null;
  trigger: string | null;
  size_bytes: number | null;
};

type EntryRow = {
  checkpoint_id: string;
  kind: EntryKind;
  name: string;
  object_hash: string;
  row_count: number | null;
  logical_bytes: number;
  stored_bytes: number;
  schema_hash: string | null;
  checksum: number | null;
  auto_increment?: number | null;
};

const SELECT = `
  SELECT c.*, u.display_name AS created_by_display_name,
         (d.base_checkpoint_id IS NOT NULL AND d.base_checkpoint_id = c.id) AS is_base
  FROM checkpoints c
  JOIN databases d ON d.id = c.database_id
  LEFT JOIN users u ON u.id = c.created_by_user_id
`;

function parseLimitations(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

function rowToCheckpoint(r: CheckpointRow): Checkpoint {
  return {
    id: r.id,
    databaseId: r.database_id,
    hash: r.hash,
    shortHash: r.hash.slice(0, 7),
    treeHash: r.tree_hash,
    parentId: r.parent_id,
    message: r.message,
    trigger: r.trigger,
    format: r.format,
    createdByUserId: r.created_by_user_id,
    createdByDisplayName: r.created_by_display_name ?? null,
    createdAt: r.created_at,
    tableCount: r.table_count,
    rowCount: r.row_count,
    logicalBytes: Number(r.logical_bytes),
    storedBytes: Number(r.stored_bytes),
    newBytes: Number(r.new_bytes),
    pinned: r.pinned === 1,
    isBase: Number(r.is_base ?? 0) === 1,
    limitations: parseLimitations(r.limitations),
    schemaCharset: r.schema_charset ?? null,
    schemaCollation: r.schema_collation ?? null,
    verifiedAt: r.verified_at ?? null,
  };
}

function rowToEntry(r: EntryRow): CheckpointEntryRecord {
  return {
    kind: r.kind,
    name: r.name,
    objectHash: r.object_hash,
    rowCount: r.row_count === null ? null : Number(r.row_count),
    logicalBytes: Number(r.logical_bytes),
    storedBytes: Number(r.stored_bytes),
    schemaHash: r.schema_hash,
    checksum: r.checksum === null ? null : Number(r.checksum),
    autoIncrement: r.auto_increment === null || r.auto_increment === undefined ? null : Number(r.auto_increment),
  };
}

function placeholders(n: number): string {
  return Array.from({ length: n }, () => "?").join(",");
}

export const checkpoints = {
  listForDatabase(databaseId: string): Checkpoint[] {
    const rows = db
      .query(`${SELECT} WHERE c.database_id = ? ORDER BY c.created_at DESC, c.rowid DESC`)
      .all(databaseId) as CheckpointRow[];
    return rows.map(rowToCheckpoint);
  },
  byId(id: string): Checkpoint | null {
    const r = db.query(`${SELECT} WHERE c.id = ?`).get(id) as CheckpointRow | null;
    return r ? rowToCheckpoint(r) : null;
  },
  hashOf(id: string): string | null {
    const r = db.query("SELECT hash FROM checkpoints WHERE id = ?").get(id) as { hash: string } | null;
    return r?.hash ?? null;
  },
  countForDatabase(databaseId: string): number {
    const r = db.query("SELECT COUNT(*) AS n FROM checkpoints WHERE database_id = ?").get(databaseId) as {
      n: number;
    };
    return Number(r.n);
  },
  entries(checkpointId: string): CheckpointEntryRecord[] {
    const rows = db
      .query("SELECT * FROM checkpoint_entries WHERE checkpoint_id = ? ORDER BY kind, name")
      .all(checkpointId) as EntryRow[];
    return rows.map(rowToEntry);
  },
  insert(cp: NewCheckpoint, entries: CheckpointEntryRecord[], setBase: boolean): void {
    db.transaction(() => {
      db.query(
        `INSERT INTO checkpoints(id, database_id, hash, tree_hash, parent_id, message, trigger, format,
          created_by_user_id, created_at, table_count, row_count, logical_bytes, stored_bytes, new_bytes, pinned,
          schema_charset, schema_collation, limitations)
         VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`,
      ).run(
        cp.id,
        cp.databaseId,
        cp.hash,
        cp.treeHash,
        cp.parentId,
        cp.message,
        cp.trigger,
        cp.format,
        cp.createdByUserId,
        cp.createdAt,
        cp.tableCount,
        cp.rowCount,
        cp.logicalBytes,
        cp.storedBytes,
        cp.newBytes,
        cp.schemaCharset ?? null,
        cp.schemaCollation ?? null,
        cp.limitations && cp.limitations.length > 0 ? JSON.stringify(cp.limitations) : null,
      );
      const insertEntry = db.query(
        `INSERT INTO checkpoint_entries(checkpoint_id, kind, name, object_hash, row_count, logical_bytes,
          stored_bytes, schema_hash, checksum, auto_increment) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const e of entries) {
        insertEntry.run(
          cp.id,
          e.kind,
          e.name,
          e.objectHash,
          e.rowCount,
          e.logicalBytes,
          e.storedBytes,
          e.schemaHash,
          e.checksum,
          e.autoIncrement ?? null,
        );
      }
      if (setBase) {
        db.query("UPDATE databases SET base_checkpoint_id = ? WHERE id = ?").run(cp.id, cp.databaseId);
      }
    })();
  },
  refreshEntryStats(
    checkpointId: string,
    stats: { name: string; rowCount: number | null; schemaHash: string | null; checksum: number | null; autoIncrement?: number | null }[],
  ): void {
    const stmt = db.query(
      `UPDATE checkpoint_entries SET row_count = ?, schema_hash = ?, checksum = ?, auto_increment = ?
       WHERE checkpoint_id = ? AND kind = 'table' AND name = ?`,
    );
    db.transaction(() => {
      for (const s of stats) stmt.run(s.rowCount, s.schemaHash, s.checksum, s.autoIncrement ?? null, checkpointId, s.name);
    })();
  },
  update(id: string, patch: { message?: string; pinned?: boolean }): void {
    if (patch.message !== undefined) {
      db.query("UPDATE checkpoints SET message = ? WHERE id = ?").run(patch.message, id);
    }
    if (patch.pinned !== undefined) {
      db.query("UPDATE checkpoints SET pinned = ? WHERE id = ?").run(patch.pinned ? 1 : 0, id);
    }
  },
  remove(id: string): { objectHashes: string[] } {
    const hashes: string[] = [];
    db.transaction(() => {
      const row = db.query("SELECT database_id, parent_id FROM checkpoints WHERE id = ?").get(id) as {
        database_id: string;
        parent_id: string | null;
      } | null;
      if (!row) return;
      for (const e of db
        .query("SELECT DISTINCT object_hash FROM checkpoint_entries WHERE checkpoint_id = ?")
        .all(id) as { object_hash: string }[]) {
        hashes.push(e.object_hash);
      }
      db.query("UPDATE checkpoints SET parent_id = ? WHERE parent_id = ?").run(row.parent_id, id);
      db.query("UPDATE databases SET base_checkpoint_id = ? WHERE id = ? AND base_checkpoint_id = ?").run(
        row.parent_id,
        row.database_id,
        id,
      );
      db.query("DELETE FROM checkpoints WHERE id = ?").run(id);
    })();
    return { objectHashes: hashes };
  },
  isObjectReferenced(databaseId: string, objectHash: string): boolean {
    return (
      db
        .query(
          `SELECT 1 AS x FROM checkpoint_entries e JOIN checkpoints c ON c.id = e.checkpoint_id
           WHERE c.database_id = ? AND e.object_hash = ? LIMIT 1`,
        )
        .get(databaseId, objectHash) !== null
    );
  },
  referencedObjects(databaseId: string): Set<string> {
    const rows = db
      .query(
        `SELECT DISTINCT e.object_hash AS h FROM checkpoint_entries e JOIN checkpoints c ON c.id = e.checkpoint_id
         WHERE c.database_id = ?`,
      )
      .all(databaseId) as { h: string }[];
    return new Set(rows.map((r) => r.h));
  },
  storage(databaseId: string): CheckpointStorageStats {
    const totals = db
      .query("SELECT COUNT(*) AS n, COALESCE(SUM(logical_bytes), 0) AS logical FROM checkpoints WHERE database_id = ?")
      .get(databaseId) as { n: number; logical: number };
    const stored = db
      .query(
        `SELECT COALESCE(SUM(s), 0) AS stored FROM (
           SELECT MAX(e.stored_bytes) AS s FROM checkpoint_entries e
           JOIN checkpoints c ON c.id = e.checkpoint_id
           WHERE c.database_id = ? GROUP BY e.object_hash)`,
      )
      .get(databaseId) as { stored: number };
    return { checkpoints: Number(totals.n), storedBytes: Number(stored.stored), logicalBytes: Number(totals.logical) };
  },
  stats(
    sinceMs: number,
    databaseIds?: string[],
  ): { total: number; lastAt: number | null; last24hCount: number; storedBytes: number } {
    let where = "";
    const params: (string | number)[] = [];
    if (databaseIds) {
      if (databaseIds.length === 0) return { total: 0, lastAt: null, last24hCount: 0, storedBytes: 0 };
      where = `WHERE c.database_id IN (${placeholders(databaseIds.length)})`;
      params.push(...databaseIds);
    }
    const r = db
      .query(
        `SELECT COUNT(*) AS total, MAX(c.created_at) AS last_at, COALESCE(SUM(c.created_at >= ?), 0) AS recent
         FROM checkpoints c ${where}`,
      )
      .get(sinceMs, ...params) as { total: number; last_at: number | null; recent: number };
    const stored = db
      .query(
        `SELECT COALESCE(SUM(s), 0) AS stored FROM (
           SELECT MAX(e.stored_bytes) AS s FROM checkpoint_entries e
           JOIN checkpoints c ON c.id = e.checkpoint_id ${where}
           GROUP BY c.database_id, e.object_hash)`,
      )
      .get(...params) as { stored: number };
    return {
      total: Number(r.total),
      lastAt: r.last_at,
      last24hCount: Number(r.recent),
      storedBytes: Number(stored.stored),
    };
  },
  automaticForRetention(
    databaseId: string,
    triggers: readonly CheckpointTrigger[] = AUTOMATIC_TRIGGERS,
  ): { id: string; pinned: boolean; isBase: boolean }[] {
    if (triggers.length === 0) return [];
    const rows = db
      .query(
        `SELECT c.id, c.pinned, (d.base_checkpoint_id IS NOT NULL AND d.base_checkpoint_id = c.id) AS is_base
         FROM checkpoints c JOIN databases d ON d.id = c.database_id
         WHERE c.database_id = ? AND c.trigger IN (${placeholders(triggers.length)})
         ORDER BY c.created_at DESC, c.rowid DESC`,
      )
      .all(databaseId, ...triggers) as { id: string; pinned: number; is_base: number }[];
    return rows.map((r) => ({ id: r.id, pinned: r.pinned === 1, isBase: Number(r.is_base) === 1 }));
  },
  setVerified(id: string, at: number): void {
    db.query("UPDATE checkpoints SET verified_at = ? WHERE id = ?").run(at, id);
  },
  recordConversionFailure(snapshotId: string, databaseId: string, reason: string, at: number): void {
    db.query(
      `INSERT INTO legacy_conversion_failures(snapshot_id, database_id, reason, failed_at, attempts) VALUES(?, ?, ?, ?, 1)
       ON CONFLICT(snapshot_id) DO UPDATE SET reason = excluded.reason, failed_at = excluded.failed_at,
         attempts = legacy_conversion_failures.attempts + 1`,
    ).run(snapshotId, databaseId, reason, at);
  },
  clearConversionFailure(snapshotId: string): void {
    db.query("DELETE FROM legacy_conversion_failures WHERE snapshot_id = ?").run(snapshotId);
  },
  conversionFailures(databaseId?: string): UnconvertedSnapshot[] {
    const rows = db
      .query(
        `SELECT f.snapshot_id, f.database_id, f.reason, f.failed_at, f.attempts, s.created_at, s.trigger, s.size_bytes
         FROM legacy_conversion_failures f JOIN snapshots s ON s.id = f.snapshot_id
         ${databaseId === undefined ? "" : "WHERE f.database_id = ?"}
         ORDER BY s.created_at DESC`,
      )
      .all(...(databaseId === undefined ? [] : [databaseId])) as FailureRow[];
    return rows.map((r) => ({
      snapshotId: r.snapshot_id,
      databaseId: r.database_id,
      createdAt: Number(r.created_at ?? 0),
      trigger: r.trigger === "scheduled" ? "scheduled" : "manual",
      sizeBytes: Number(r.size_bytes ?? 0),
      reason: r.reason,
      failedAt: Number(r.failed_at),
      attempts: Number(r.attempts),
    }));
  },
  pruneConversionFailures(): void {
    db.query("DELETE FROM legacy_conversion_failures WHERE snapshot_id NOT IN (SELECT id FROM snapshots)").run();
  },
  lastCreatedAt(databaseId: string, trigger: CheckpointTrigger): number | null {
    const r = db
      .query("SELECT MAX(created_at) AS t FROM checkpoints WHERE database_id = ? AND trigger = ?")
      .get(databaseId, trigger) as { t: number | null };
    return r.t ?? null;
  },
  latestLegacyBefore(databaseId: string, createdAt: number): string | null {
    const r = db
      .query(
        `SELECT id FROM checkpoints WHERE database_id = ? AND format = 'legacy' AND created_at < ?
         ORDER BY created_at DESC LIMIT 1`,
      )
      .get(databaseId, createdAt) as { id: string } | null;
    return r?.id ?? null;
  },
  exists(id: string): boolean {
    return db.query("SELECT 1 AS x FROM checkpoints WHERE id = ?").get(id) !== null;
  },
  policy(databaseId: string): Omit<CheckpointPolicy, "versioned"> {
    const r = db
      .query("SELECT auto_interval_hours, auto_retention, checkpoint_on_sync, manual_sync_checkpoint FROM checkpoint_policies WHERE database_id = ?")
      .get(databaseId) as { auto_interval_hours: number; auto_retention: number; checkpoint_on_sync: number; manual_sync_checkpoint: string | null } | null;
    if (!r) return { ...DEFAULT_POLICY };
    return {
      autoIntervalHours: Number(r.auto_interval_hours),
      autoRetention: Number(r.auto_retention),
      checkpointOnSync: r.checkpoint_on_sync === 1,
      manualSyncCheckpoint: manualModeOf(r.manual_sync_checkpoint),
    };
  },
  setPolicy(databaseId: string, p: Omit<CheckpointPolicy, "versioned">): void {
    const manual = p.manualSyncCheckpoint === undefined ? (checkpoints.policy(databaseId).manualSyncCheckpoint ?? "ask") : manualModeOf(p.manualSyncCheckpoint);
    db.query(
      `INSERT INTO checkpoint_policies(database_id, auto_interval_hours, auto_retention, checkpoint_on_sync, manual_sync_checkpoint)
       VALUES(?, ?, ?, ?, ?)
       ON CONFLICT(database_id) DO UPDATE SET auto_interval_hours = excluded.auto_interval_hours,
         auto_retention = excluded.auto_retention, checkpoint_on_sync = excluded.checkpoint_on_sync,
         manual_sync_checkpoint = excluded.manual_sync_checkpoint`,
    ).run(databaseId, p.autoIntervalHours, p.autoRetention, p.checkpointOnSync ? 1 : 0, manual);
  },
  lastScheduledCheck(databaseId: string): number | null {
    const r = db.query("SELECT last_checked_at FROM checkpoint_schedule WHERE database_id = ?").get(databaseId) as {
      last_checked_at: number;
    } | null;
    return r ? Number(r.last_checked_at) : null;
  },
  markScheduledCheck(databaseId: string, at: number): void {
    db.query(
      `INSERT INTO checkpoint_schedule(database_id, last_checked_at) VALUES(?, ?)
       ON CONFLICT(database_id) DO UPDATE SET last_checked_at = excluded.last_checked_at`,
    ).run(databaseId, at);
  },
  insertLegacy(cp: NewCheckpoint, entry: CheckpointEntryRecord, snapshotId: string): boolean {
    let inserted = false;
    db.transaction(() => {
      if (!db.query("SELECT 1 AS x FROM checkpoints WHERE id = ?").get(cp.id)) {
        checkpoints.insert(cp, [entry], false);
        inserted = true;
      }
      db.query("DELETE FROM snapshots WHERE id = ?").run(snapshotId);
    })();
    return inserted;
  },
};
