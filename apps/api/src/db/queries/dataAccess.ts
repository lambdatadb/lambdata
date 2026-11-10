import type { DataApiDenial, DataApiMode, DataApiOperation } from "@lambdata/shared";
import { db } from "../client";

type DenialRow = {
  database_id: string;
  database_name: string;
  table_name: string;
  operation: DataApiOperation;
  count: number;
  last_at: number;
};

function rowToDenial(r: DenialRow): DataApiDenial {
  return {
    databaseId: r.database_id,
    databaseName: r.database_name,
    tableName: r.table_name,
    operation: r.operation,
    count: Number(r.count),
    lastAt: Number(r.last_at),
  };
}

function toMode(value: string | null | undefined): DataApiMode {
  return value === "open" ? "open" : "closed";
}

const DENIAL_SELECT = `
  SELECT n.database_id, d.name AS database_name, n.table_name, n.operation, n.count, n.last_at
  FROM data_api_denials n
  JOIN databases d ON d.id = n.database_id
`;

export const dataAccess = {
  mode(databaseId: string): DataApiMode {
    const row = db.query("SELECT mode FROM data_api_access WHERE database_id = ?").get(databaseId) as
      | { mode: string }
      | null;
    return toMode(row?.mode);
  },
  modes(): Map<string, DataApiMode> {
    const rows = db.query("SELECT database_id, mode FROM data_api_access").all() as {
      database_id: string;
      mode: string;
    }[];
    return new Map(rows.map((r) => [r.database_id, toMode(r.mode)]));
  },
  setMode(databaseId: string, mode: DataApiMode, userId: string | null): void {
    db.query(
      `INSERT INTO data_api_access(database_id, mode, updated_by_user_id, updated_at)
       VALUES(?, ?, ?, ?)
       ON CONFLICT(database_id) DO UPDATE SET
         mode = excluded.mode,
         updated_by_user_id = excluded.updated_by_user_id,
         updated_at = excluded.updated_at`,
    ).run(databaseId, mode, userId, Date.now());
  },
  recordDenial(databaseId: string, tableName: string, operation: DataApiOperation): void {
    const now = Date.now();
    db.query(
      `INSERT INTO data_api_denials(database_id, table_name, operation, count, first_at, last_at)
       VALUES(?, ?, ?, 1, ?, ?)
       ON CONFLICT(database_id, table_name, operation) DO UPDATE SET
         count = count + 1,
         last_at = excluded.last_at`,
    ).run(databaseId, tableName, operation, now, now);
  },
  denials(databaseId: string): DataApiDenial[] {
    const rows = db
      .query(`${DENIAL_SELECT} WHERE n.database_id = ? ORDER BY n.last_at DESC, n.table_name ASC, n.operation ASC`)
      .all(databaseId) as DenialRow[];
    return rows.map(rowToDenial);
  },
  denialsByDatabase(): Map<string, DataApiDenial[]> {
    const rows = db
      .query(`${DENIAL_SELECT} ORDER BY n.last_at DESC, n.table_name ASC, n.operation ASC`)
      .all() as DenialRow[];
    const out = new Map<string, DataApiDenial[]>();
    for (const row of rows) {
      const list = out.get(row.database_id) ?? [];
      list.push(rowToDenial(row));
      out.set(row.database_id, list);
    }
    return out;
  },
  clearDenials(databaseId: string): number {
    return db.query("DELETE FROM data_api_denials WHERE database_id = ?").run(databaseId).changes;
  },
};
