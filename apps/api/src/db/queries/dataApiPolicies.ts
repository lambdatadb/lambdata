import type { DataApiPolicy } from "@lambdata/shared";
import { db } from "../client";

type DataApiPolicyRow = {
  database_id: string;
  table_name: string;
  select_enabled: number;
  insert_enabled: number;
  update_enabled: number;
  delete_enabled: number;
  owner_column: string | null;
  created_at: number;
  updated_at: number;
};

function rowToDataApiPolicy(r: DataApiPolicyRow): DataApiPolicy {
  return {
    databaseId: r.database_id,
    tableName: r.table_name,
    selectEnabled: r.select_enabled === 1,
    insertEnabled: r.insert_enabled === 1,
    updateEnabled: r.update_enabled === 1,
    deleteEnabled: r.delete_enabled === 1,
    ownerColumn: r.owner_column,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export const dataApiPolicies = {
  list(databaseId: string): DataApiPolicy[] {
    const rows = db
      .query("SELECT * FROM data_api_policies WHERE database_id = ? ORDER BY table_name ASC")
      .all(databaseId) as DataApiPolicyRow[];
    return rows.map(rowToDataApiPolicy);
  },
  byTable(databaseId: string, tableName: string): DataApiPolicy | null {
    const row = db
      .query("SELECT * FROM data_api_policies WHERE database_id = ? AND table_name = ?")
      .get(databaseId, tableName) as DataApiPolicyRow | null;
    return row ? rowToDataApiPolicy(row) : null;
  },
  upsert(input: {
    databaseId: string;
    tableName: string;
    selectEnabled: boolean;
    insertEnabled: boolean;
    updateEnabled: boolean;
    deleteEnabled: boolean;
    ownerColumn: string | null;
  }): void {
    const now = Date.now();
    db.query(
      `INSERT INTO data_api_policies(
        database_id, table_name, select_enabled, insert_enabled, update_enabled,
        delete_enabled, owner_column, created_at, updated_at
       ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(database_id, table_name) DO UPDATE SET
        select_enabled = excluded.select_enabled,
        insert_enabled = excluded.insert_enabled,
        update_enabled = excluded.update_enabled,
        delete_enabled = excluded.delete_enabled,
        owner_column = excluded.owner_column,
        updated_at = excluded.updated_at`,
    ).run(
      input.databaseId,
      input.tableName,
      input.selectEnabled ? 1 : 0,
      input.insertEnabled ? 1 : 0,
      input.updateEnabled ? 1 : 0,
      input.deleteEnabled ? 1 : 0,
      input.ownerColumn,
      now,
      now,
    );
  },
  delete(databaseId: string, tableName: string): void {
    db.query("DELETE FROM data_api_policies WHERE database_id = ? AND table_name = ?").run(
      databaseId,
      tableName,
    );
  },
};
