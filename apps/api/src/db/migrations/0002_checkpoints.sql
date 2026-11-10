CREATE TABLE IF NOT EXISTS checkpoints (
  id TEXT PRIMARY KEY,
  database_id TEXT NOT NULL REFERENCES databases(id) ON DELETE CASCADE,
  hash TEXT NOT NULL,
  tree_hash TEXT,
  parent_id TEXT,
  message TEXT NOT NULL,
  trigger TEXT NOT NULL,
  format TEXT NOT NULL DEFAULT 'v1',
  created_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL,
  table_count INTEGER,
  row_count INTEGER,
  logical_bytes INTEGER NOT NULL DEFAULT 0,
  stored_bytes INTEGER NOT NULL DEFAULT 0,
  new_bytes INTEGER NOT NULL DEFAULT 0,
  pinned INTEGER NOT NULL DEFAULT 0,
  UNIQUE (database_id, hash)
);
CREATE INDEX IF NOT EXISTS idx_checkpoints_database_created ON checkpoints(database_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_checkpoints_parent ON checkpoints(parent_id);

CREATE TABLE IF NOT EXISTS checkpoint_entries (
  checkpoint_id TEXT NOT NULL REFERENCES checkpoints(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  object_hash TEXT NOT NULL,
  row_count INTEGER,
  logical_bytes INTEGER NOT NULL DEFAULT 0,
  stored_bytes INTEGER NOT NULL DEFAULT 0,
  schema_hash TEXT,
  checksum INTEGER,
  PRIMARY KEY (checkpoint_id, kind, name)
);
CREATE INDEX IF NOT EXISTS idx_checkpoint_entries_object ON checkpoint_entries(object_hash);

CREATE TABLE IF NOT EXISTS checkpoint_policies (
  database_id TEXT PRIMARY KEY REFERENCES databases(id) ON DELETE CASCADE,
  auto_interval_hours INTEGER NOT NULL DEFAULT 24,
  auto_retention INTEGER NOT NULL DEFAULT 7,
  checkpoint_on_sync INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS checkpoint_schedule (
  database_id TEXT PRIMARY KEY REFERENCES databases(id) ON DELETE CASCADE,
  last_checked_at INTEGER NOT NULL
);
