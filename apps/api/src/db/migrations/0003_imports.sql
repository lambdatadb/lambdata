CREATE TABLE IF NOT EXISTS import_uploads (
  id TEXT PRIMARY KEY,
  user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
  file_name TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  format TEXT NOT NULL,
  compressed INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_import_uploads_expires ON import_uploads(expires_at);
CREATE INDEX IF NOT EXISTS idx_import_uploads_user ON import_uploads(user_id);

CREATE TABLE IF NOT EXISTS imports (
  id TEXT PRIMARY KEY,
  database_id TEXT NOT NULL REFERENCES databases(id) ON DELETE CASCADE,
  file_name TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  format TEXT NOT NULL,
  mode TEXT NOT NULL,
  table_count INTEGER,
  row_count INTEGER,
  warning_count INTEGER NOT NULL DEFAULT 0,
  imported_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  imported_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_imports_database ON imports(database_id, imported_at DESC);
