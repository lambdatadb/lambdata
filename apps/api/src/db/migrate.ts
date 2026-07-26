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
  ensureColumn("users", "data_view_enabled", "INTEGER NOT NULL DEFAULT 0");
  ensureColumn("users", "color_theme", "TEXT NOT NULL DEFAULT 'ember'");
  ensureColumn("users", "vitals_chart_style", "TEXT NOT NULL DEFAULT 'area'");
  ensureColumn("metrics", "row_count", "INTEGER");
}
