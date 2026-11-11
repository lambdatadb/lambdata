ALTER TABLE checkpoint_policies ADD COLUMN manual_sync_checkpoint TEXT NOT NULL DEFAULT 'ask';

CREATE TABLE IF NOT EXISTS sync_baselines (
  database_id TEXT PRIMARY KEY REFERENCES databases(id) ON DELETE CASCADE,
  fingerprint TEXT NOT NULL,
  recorded_at INTEGER NOT NULL
);
