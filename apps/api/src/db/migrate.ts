import { readFileSync } from "node:fs";
import { join } from "node:path";
import { db } from "./client";

function ensureColumn(table: string, column: string, ddl: string): void {
  const rows = db.query(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (!rows.some((r) => r.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
  }
}

export function migrate(): void {
  const schema = readFileSync(join(import.meta.dir, "schema.sql"), "utf8");
  db.exec(schema);
  // Incremental column adds for existing installs.
  ensureColumn("users", "data_view_enabled", "INTEGER NOT NULL DEFAULT 0");
  ensureColumn("metrics", "row_count", "INTEGER");
}
