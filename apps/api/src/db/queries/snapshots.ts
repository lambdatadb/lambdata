import type { Snapshot, SnapshotTrigger } from "@lambdata/shared";
import { db } from "../client";

type SnapshotRow = {
  id: string;
  database_id: string;
  file_path: string;
  size_bytes: number;
  created_at: number;
  trigger: SnapshotTrigger;
};

function rowToSnapshot(r: SnapshotRow): Snapshot {
  return {
    id: r.id,
    databaseId: r.database_id,
    filePath: r.file_path,
    sizeBytes: r.size_bytes,
    createdAt: r.created_at,
    trigger: r.trigger,
  };
}

export const snapshots = {
  list(databaseId: string): Snapshot[] {
    const rows = db
      .query("SELECT * FROM snapshots WHERE database_id = ? ORDER BY created_at DESC")
      .all(databaseId) as SnapshotRow[];
    return rows.map(rowToSnapshot);
  },
  listAll(): Snapshot[] {
    const rows = db
      .query("SELECT * FROM snapshots ORDER BY database_id ASC, created_at ASC, id ASC")
      .all() as SnapshotRow[];
    return rows.map(rowToSnapshot);
  },
  count(): number {
    const r = db.query("SELECT COUNT(*) AS n FROM snapshots").get() as { n: number };
    return Number(r.n);
  },
  byId(id: string): Snapshot | null {
    const r = db.query("SELECT * FROM snapshots WHERE id = ?").get(id) as SnapshotRow | null;
    return r ? rowToSnapshot(r) : null;
  },
  insert(s: Snapshot): void {
    db.query(
      "INSERT INTO snapshots(id, database_id, file_path, size_bytes, created_at, trigger) VALUES(?, ?, ?, ?, ?, ?)",
    ).run(s.id, s.databaseId, s.filePath, s.sizeBytes, s.createdAt, s.trigger);
  },
  delete(id: string): void {
    db.query("DELETE FROM snapshots WHERE id = ?").run(id);
  },
};
