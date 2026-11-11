import type { ConnectionRejectionReason } from "@lambdata/shared";
import { db } from "../db/client";

export const REJECTION_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
export const MAX_REJECTION_GROUPS = 2000;
export const DATABASE_LIST_LIMIT = 50;
export const NETWORK_LIST_LIMIT = 200;

export interface RejectionGroup {
  address: string;
  account: string | null;
  reason: ConnectionRejectionReason;
  databaseId: string | null;
  count: number;
  firstAt: number;
  lastAt: number;
}

type Row = {
  address: string;
  account: string;
  reason: string;
  database_id: string | null;
  count: number;
  first_at: number;
  last_at: number;
};

function fromRow(r: Row): RejectionGroup {
  return {
    address: r.address,
    account: r.account === "" ? null : r.account,
    reason: r.reason as ConnectionRejectionReason,
    databaseId: r.database_id,
    count: r.count,
    firstAt: r.first_at,
    lastAt: r.last_at,
  };
}

export const rejectionLimits = {
  retentionMs: REJECTION_RETENTION_MS,
  maxGroups: MAX_REJECTION_GROUPS,
};

export function recordRejections(groups: RejectionGroup[], now = Date.now()): void {
  if (groups.length === 0) return;
  const upsert = db.query(
    `INSERT INTO connection_rejections(address, account, reason, database_id, count, first_at, last_at)
     VALUES(?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(address, account, reason) DO UPDATE SET
       count = count + excluded.count,
       first_at = MIN(first_at, excluded.first_at),
       last_at = MAX(last_at, excluded.last_at),
       database_id = excluded.database_id`,
  );
  db.transaction(() => {
    for (const g of groups) {
      upsert.run(g.address, g.account ?? "", g.reason, g.databaseId, g.count, g.firstAt, g.lastAt);
    }
  })();
  pruneRejections(now);
}

export function pruneRejections(now = Date.now()): number {
  let removed = db.query("DELETE FROM connection_rejections WHERE last_at < ?").run(now - rejectionLimits.retentionMs).changes;
  const total = (db.query("SELECT COUNT(*) AS n FROM connection_rejections").get() as { n: number }).n;
  if (total > rejectionLimits.maxGroups) {
    removed += db
      .query(
        `DELETE FROM connection_rejections WHERE rowid IN (
           SELECT rowid FROM connection_rejections ORDER BY last_at DESC, rowid DESC LIMIT -1 OFFSET ?
         )`,
      )
      .run(rejectionLimits.maxGroups).changes;
  }
  return removed;
}

export function rejectionsForDatabase(databaseId: string, now = Date.now(), limit = DATABASE_LIST_LIMIT): RejectionGroup[] {
  const rows = db
    .query(
      `SELECT * FROM connection_rejections WHERE database_id = ? AND last_at >= ?
       ORDER BY last_at DESC LIMIT ?`,
    )
    .all(databaseId, now - rejectionLimits.retentionMs, limit) as Row[];
  return rows.map(fromRow);
}

export function allRejections(now = Date.now(), limit = NETWORK_LIST_LIMIT): RejectionGroup[] {
  const rows = db
    .query("SELECT * FROM connection_rejections WHERE last_at >= ? ORDER BY last_at DESC LIMIT ?")
    .all(now - rejectionLimits.retentionMs, limit) as Row[];
  return rows.map(fromRow);
}

export function rejectionGroupCount(): number {
  return (db.query("SELECT COUNT(*) AS n FROM connection_rejections").get() as { n: number }).n;
}

export function clearRejections(): number {
  return db.query("DELETE FROM connection_rejections").run().changes;
}
