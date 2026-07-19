CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  display_name TEXT,
  role TEXT NOT NULL CHECK (role IN ('admin','db_owner','viewer')),
  experience_level TEXT NOT NULL DEFAULT 'advanced'
    CHECK (experience_level IN ('novice','advanced')),
  data_view_enabled INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  last_login_at INTEGER
);

CREATE TABLE IF NOT EXISTS databases (
  id TEXT PRIMARY KEY,
  name TEXT UNIQUE NOT NULL,
  display_name TEXT NOT NULL,
  owner_user_id TEXT NOT NULL REFERENCES users(id),
  kind TEXT NOT NULL CHECK (kind IN ('standard','mirror')),
  mysql_user TEXT NOT NULL,
  mysql_password_enc TEXT NOT NULL,
  connections_from TEXT NOT NULL DEFAULT '%',
  tailscale_exposed INTEGER NOT NULL DEFAULT 0,
  lan_exposed INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active','suspended','deleting'))
);

CREATE TABLE IF NOT EXISTS sync_jobs (
  id TEXT PRIMARY KEY,
  database_id TEXT NOT NULL REFERENCES databases(id) ON DELETE CASCADE,
  source_kind TEXT NOT NULL CHECK (source_kind IN ('mysql','postgres')),
  source_host TEXT NOT NULL,
  source_port INTEGER NOT NULL,
  source_user TEXT NOT NULL,
  source_password_enc TEXT NOT NULL,
  source_database TEXT NOT NULL,
  interval_seconds INTEGER NOT NULL DEFAULT 3600,
  last_run_at INTEGER,
  last_status TEXT,
  last_error TEXT,
  enabled INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS snapshots (
  id TEXT PRIMARY KEY,
  database_id TEXT NOT NULL REFERENCES databases(id) ON DELETE CASCADE,
  file_path TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  trigger TEXT NOT NULL CHECK (trigger IN ('manual','scheduled'))
);

CREATE TABLE IF NOT EXISTS storage_buckets (
  id TEXT PRIMARY KEY,
  name TEXT UNIQUE NOT NULL,
  public INTEGER NOT NULL DEFAULT 0,
  owner_user_id TEXT NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS storage_objects (
  id TEXT PRIMARY KEY,
  bucket_id TEXT NOT NULL REFERENCES storage_buckets(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  relative_path TEXT NOT NULL,
  mime_type TEXT,
  size_bytes INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_storage_objects_bucket_name
  ON storage_objects(bucket_id, name);
CREATE INDEX IF NOT EXISTS idx_storage_objects_bucket
  ON storage_objects(bucket_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS data_api_policies (
  database_id TEXT NOT NULL REFERENCES databases(id) ON DELETE CASCADE,
  table_name TEXT NOT NULL,
  select_enabled INTEGER NOT NULL DEFAULT 1,
  insert_enabled INTEGER NOT NULL DEFAULT 1,
  update_enabled INTEGER NOT NULL DEFAULT 1,
  delete_enabled INTEGER NOT NULL DEFAULT 1,
  owner_column TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY(database_id, table_name)
);
CREATE INDEX IF NOT EXISTS idx_data_api_policies_database
  ON data_api_policies(database_id, table_name);

CREATE TABLE IF NOT EXISTS functions (
  name TEXT PRIMARY KEY,
  verify_jwt INTEGER NOT NULL DEFAULT 1,
  created_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS function_secrets (
  name TEXT PRIMARY KEY,
  value_enc TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS function_invocations (
  id TEXT PRIMARY KEY,
  function_name TEXT NOT NULL,
  method TEXT NOT NULL,
  path TEXT NOT NULL,
  status_code INTEGER,
  duration_ms REAL NOT NULL,
  request_bytes INTEGER NOT NULL DEFAULT 0,
  response_bytes INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  logs TEXT,
  invoked_by_app_user_id TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_function_invocations_function_created
  ON function_invocations(function_name, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_function_invocations_created
  ON function_invocations(created_at);

CREATE TABLE IF NOT EXISTS app_auth_users (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  display_name TEXT,
  email_confirmed INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active','disabled')),
  created_at INTEGER NOT NULL,
  last_sign_in_at INTEGER
);

CREATE TABLE IF NOT EXISTS metrics (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  database_id TEXT NOT NULL REFERENCES databases(id) ON DELETE CASCADE,
  collected_at INTEGER NOT NULL,
  size_bytes INTEGER,
  table_count INTEGER,
  connection_count INTEGER,
  row_count INTEGER
);
CREATE INDEX IF NOT EXISTS idx_metrics_db_time ON metrics(database_id, collected_at DESC);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT REFERENCES users(id),
  action TEXT NOT NULL,
  target TEXT,
  details TEXT,
  at INTEGER NOT NULL
);
