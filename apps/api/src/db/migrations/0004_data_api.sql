CREATE TABLE IF NOT EXISTS data_api_access (
  database_id TEXT PRIMARY KEY REFERENCES databases(id) ON DELETE CASCADE,
  mode TEXT NOT NULL DEFAULT 'closed' CHECK (mode IN ('closed', 'open')),
  updated_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS data_api_denials (
  database_id TEXT NOT NULL REFERENCES databases(id) ON DELETE CASCADE,
  table_name TEXT NOT NULL,
  operation TEXT NOT NULL CHECK (operation IN ('select', 'insert', 'update', 'delete')),
  count INTEGER NOT NULL DEFAULT 0,
  first_at INTEGER NOT NULL,
  last_at INTEGER NOT NULL,
  PRIMARY KEY (database_id, table_name, operation)
);
CREATE INDEX IF NOT EXISTS idx_data_api_denials_last ON data_api_denials(database_id, last_at DESC);
