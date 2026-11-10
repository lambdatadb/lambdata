ALTER TABLE checkpoints ADD COLUMN schema_charset TEXT;
ALTER TABLE checkpoints ADD COLUMN schema_collation TEXT;
ALTER TABLE checkpoints ADD COLUMN limitations TEXT;
ALTER TABLE checkpoints ADD COLUMN verified_at INTEGER;

CREATE TABLE IF NOT EXISTS legacy_conversion_failures (
  snapshot_id TEXT PRIMARY KEY,
  database_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  failed_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_legacy_conversion_failures_database ON legacy_conversion_failures(database_id);
