ALTER TABLE checkpoint_entries ADD COLUMN auto_increment INTEGER;

CREATE TABLE IF NOT EXISTS import_runs (
  job_id TEXT PRIMARY KEY,
  database_id TEXT NOT NULL,
  mode TEXT NOT NULL,
  schema_name TEXT NOT NULL,
  started_at INTEGER NOT NULL
);
