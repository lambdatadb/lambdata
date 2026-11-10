import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { db } from "./client";

export const MIGRATIONS_DIR = join(import.meta.dir, "migrations");
const MIGRATION_FILE = /^(\d{4})_[a-z0-9_]+\.sql$/;

export interface MigrationFile {
  id: string;
  number: number;
  path: string;
}

function ensureColumn(table: string, column: string, ddl: string): void {
  const rows = db.query(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (!rows.some((r) => r.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
  }
}

function applyBaseline(): void {
  const schema = readFileSync(join(import.meta.dir, "schema.sql"), "utf8");
  db.exec(schema);
  ensureColumn("users", "data_view_enabled", "INTEGER NOT NULL DEFAULT 0");
  ensureColumn("users", "color_theme", "TEXT NOT NULL DEFAULT 'ember'");
  ensureColumn("users", "vitals_chart_style", "TEXT NOT NULL DEFAULT 'area'");
  ensureColumn("metrics", "row_count", "INTEGER");
}

export function listMigrations(dir: string = MIGRATIONS_DIR): MigrationFile[] {
  const files = readdirSync(dir).filter((name) => name.endsWith(".sql")).sort();
  const seen = new Map<number, string>();
  return files.map((name) => {
    const match = MIGRATION_FILE.exec(name);
    if (!match) throw new Error(`migration file name must look like NNNN_name.sql: ${name}`);
    const number = Number(match[1]);
    const clash = seen.get(number);
    if (clash) throw new Error(`migrations ${clash} and ${name} share number ${match[1]}`);
    seen.set(number, name);
    return { id: name.slice(0, -4), number, path: join(dir, name) };
  });
}

export function appliedMigrations(): string[] {
  const rows = db.query("SELECT id FROM schema_migrations ORDER BY id ASC").all() as { id: string }[];
  return rows.map((r) => r.id);
}

export function migrate(dir: string = MIGRATIONS_DIR): string[] {
  applyBaseline();
  db.exec(
    "CREATE TABLE IF NOT EXISTS schema_migrations (id TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)",
  );
  const applied = new Set(appliedMigrations());
  const ran: string[] = [];
  for (const migration of listMigrations(dir)) {
    if (applied.has(migration.id)) continue;
    const sql = readFileSync(migration.path, "utf8");
    db.transaction(() => {
      db.exec(sql);
      db.query("INSERT INTO schema_migrations(id, applied_at) VALUES(?, ?)").run(
        migration.id,
        Date.now(),
      );
    })();
    ran.push(migration.id);
    console.log("[lambdata] applied migration", migration.id);
  }
  return ran;
}
