import type { SyncJob, SyncSourceKind, SyncStatus } from "@lambdata/shared";
import { db } from "../client";

type SyncRow = {
  id: string;
  database_id: string;
  source_kind: SyncSourceKind;
  source_host: string;
  source_port: number;
  source_user: string;
  source_password_enc: string;
  source_database: string;
  interval_seconds: number;
  last_run_at: number | null;
  last_status: SyncStatus | null;
  last_error: string | null;
  enabled: number;
};

function rowToSync(r: SyncRow): SyncJob {
  return {
    id: r.id,
    databaseId: r.database_id,
    sourceKind: r.source_kind,
    sourceHost: r.source_host,
    sourcePort: r.source_port,
    sourceUser: r.source_user,
    sourceDatabase: r.source_database,
    intervalSeconds: r.interval_seconds,
    lastRunAt: r.last_run_at,
    lastStatus: r.last_status,
    lastError: r.last_error,
    enabled: r.enabled === 1,
  };
}

export const syncJobs = {
  byDatabaseId(databaseId: string): SyncJob | null {
    const r = db
      .query("SELECT * FROM sync_jobs WHERE database_id = ?")
      .get(databaseId) as SyncRow | null;
    return r ? rowToSync(r) : null;
  },
  passwordEncFor(databaseId: string): string | null {
    const r = db
      .query("SELECT source_password_enc FROM sync_jobs WHERE database_id = ?")
      .get(databaseId) as { source_password_enc: string } | null;
    return r?.source_password_enc ?? null;
  },
  upsert(j: Omit<SyncJob, "lastRunAt" | "lastStatus" | "lastError"> & { passwordEnc: string }): void {
    const existing = this.byDatabaseId(j.databaseId);
    if (existing) {
      db.query(
        `UPDATE sync_jobs SET source_kind=?, source_host=?, source_port=?, source_user=?,
         source_password_enc=?, source_database=?, interval_seconds=?, enabled=? WHERE database_id=?`,
      ).run(
        j.sourceKind,
        j.sourceHost,
        j.sourcePort,
        j.sourceUser,
        j.passwordEnc,
        j.sourceDatabase,
        j.intervalSeconds,
        j.enabled ? 1 : 0,
        j.databaseId,
      );
    } else {
      db.query(
        `INSERT INTO sync_jobs(id, database_id, source_kind, source_host, source_port,
         source_user, source_password_enc, source_database, interval_seconds, enabled)
         VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        j.id,
        j.databaseId,
        j.sourceKind,
        j.sourceHost,
        j.sourcePort,
        j.sourceUser,
        j.passwordEnc,
        j.sourceDatabase,
        j.intervalSeconds,
        j.enabled ? 1 : 0,
      );
    }
  },
  recordRun(databaseId: string, status: SyncStatus, error: string | null): void {
    db.query(
      "UPDATE sync_jobs SET last_run_at = ?, last_status = ?, last_error = ? WHERE database_id = ?",
    ).run(Date.now(), status, error, databaseId);
  },
  deleteByDatabaseId(databaseId: string): void {
    db.query("DELETE FROM sync_jobs WHERE database_id = ?").run(databaseId);
  },
  listEnabled(): (SyncJob & { passwordEnc: string })[] {
    const rows = db.query("SELECT * FROM sync_jobs WHERE enabled = 1").all() as SyncRow[];
    return rows.map((r) => ({ ...rowToSync(r), passwordEnc: r.source_password_enc }));
  },
  listAll(): SyncJob[] {
    const rows = db.query("SELECT * FROM sync_jobs").all() as SyncRow[];
    return rows.map(rowToSync);
  },
};
