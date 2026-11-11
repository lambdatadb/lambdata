import { db } from "../client";

export interface BaselineTable {
  name: string;
  rowCount: number | null;
  checksum: number | null;
  schemaHash: string | null;
  autoIncrement: number | null;
}

export interface SyncBaseline {
  tables: BaselineTable[];
  codeHash: string | null;
  recordedAt: number;
}

export const syncBaselines = {
  get(databaseId: string): SyncBaseline | null {
    const r = db.query("SELECT fingerprint, recorded_at FROM sync_baselines WHERE database_id = ?").get(databaseId) as {
      fingerprint: string;
      recorded_at: number;
    } | null;
    if (!r) return null;
    try {
      const parsed = JSON.parse(r.fingerprint) as { tables?: BaselineTable[]; codeHash?: string | null };
      if (!Array.isArray(parsed.tables)) return null;
      return { tables: parsed.tables, codeHash: parsed.codeHash ?? null, recordedAt: Number(r.recorded_at) };
    } catch {
      return null;
    }
  },
  set(databaseId: string, baseline: SyncBaseline): void {
    db.query(
      `INSERT INTO sync_baselines(database_id, fingerprint, recorded_at) VALUES(?, ?, ?)
       ON CONFLICT(database_id) DO UPDATE SET fingerprint = excluded.fingerprint, recorded_at = excluded.recorded_at`,
    ).run(databaseId, JSON.stringify({ tables: baseline.tables, codeHash: baseline.codeHash }), baseline.recordedAt);
  },
  remove(databaseId: string): void {
    db.query("DELETE FROM sync_baselines WHERE database_id = ?").run(databaseId);
  },
};
