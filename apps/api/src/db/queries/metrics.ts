import type { MetricSample } from "@lambdata/shared";
import { db } from "../client";

type MetricRow = {
  collected_at: number;
  size_bytes: number | null;
  table_count: number | null;
  connection_count: number | null;
  row_count: number | null;
};

const SAMPLE_COLUMNS = "collected_at, size_bytes, table_count, connection_count, row_count";

function rowToSample(r: MetricRow): MetricSample {
  return {
    collectedAt: r.collected_at,
    sizeBytes: r.size_bytes,
    tableCount: r.table_count,
    connectionCount: r.connection_count,
    rowCount: r.row_count,
  };
}

export const metrics = {
  insert(
    databaseId: string,
    m: {
      sizeBytes: number | null;
      tableCount: number | null;
      connectionCount: number | null;
      rowCount: number | null;
    },
  ): void {
    db.query(
      "INSERT INTO metrics(database_id, collected_at, size_bytes, table_count, connection_count, row_count) VALUES(?, ?, ?, ?, ?, ?)",
    ).run(databaseId, Date.now(), m.sizeBytes, m.tableCount, m.connectionCount, m.rowCount);
  },
  range(databaseId: string, sinceMs: number, bucketMs?: number): MetricSample[] {
    const rows =
      bucketMs && bucketMs > 1
        ? db
            .query(
              "SELECT MAX(collected_at) as collected_at, size_bytes, table_count, connection_count, row_count FROM metrics WHERE database_id = ? AND collected_at >= ? GROUP BY collected_at / ? ORDER BY collected_at ASC",
            )
            .all(databaseId, sinceMs, bucketMs)
        : db
            .query(
              `SELECT ${SAMPLE_COLUMNS} FROM metrics WHERE database_id = ? AND collected_at >= ? ORDER BY collected_at ASC`,
            )
            .all(databaseId, sinceMs);
    return (rows as MetricRow[]).map(rowToSample);
  },
  latestBefore(databaseId: string, beforeMs: number): MetricSample | null {
    const row = db
      .query(
        `SELECT ${SAMPLE_COLUMNS} FROM metrics WHERE database_id = ? AND collected_at < ? ORDER BY collected_at DESC LIMIT 1`,
      )
      .get(databaseId, beforeMs) as MetricRow | null;
    return row ? rowToSample(row) : null;
  },
  prune(olderThanMs: number): void {
    db.query("DELETE FROM metrics WHERE collected_at < ?").run(olderThanMs);
  },
  latestFor(databaseId: string): MetricSample | null {
    const row = db
      .query(
        `SELECT ${SAMPLE_COLUMNS} FROM metrics WHERE database_id = ? ORDER BY collected_at DESC LIMIT 1`,
      )
      .get(databaseId) as MetricRow | null;
    return row ? rowToSample(row) : null;
  },
};
