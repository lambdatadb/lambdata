ALTER TABLE users ADD COLUMN kind TEXT NOT NULL DEFAULT 'person';

ALTER TABLE databases ADD COLUMN created_by_token_id TEXT;

CREATE INDEX IF NOT EXISTS idx_databases_created_by_token ON databases(created_by_token_id);

CREATE TABLE IF NOT EXISTS access_tokens (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  preset TEXT NOT NULL CHECK (preset IN ('read_only','builder','admin')),
  prefix TEXT NOT NULL,
  secret_hash TEXT NOT NULL UNIQUE,
  actor_user_id TEXT NOT NULL UNIQUE REFERENCES users(id),
  created_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_by_display_name TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER,
  revoked_at INTEGER,
  paused INTEGER NOT NULL DEFAULT 0,
  database_ids TEXT,
  allowed_from TEXT NOT NULL,
  reveal_credentials INTEGER NOT NULL DEFAULT 0,
  ask_first INTEGER NOT NULL DEFAULT 0,
  max_databases INTEGER,
  requests_per_minute INTEGER NOT NULL DEFAULT 120,
  last_used_at INTEGER,
  last_used_from TEXT,
  last_used_via TEXT
);

CREATE INDEX IF NOT EXISTS idx_access_tokens_creator ON access_tokens(created_by_user_id);

CREATE TABLE IF NOT EXISTS access_token_activity (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  token_id TEXT NOT NULL REFERENCES access_tokens(id) ON DELETE CASCADE,
  at INTEGER NOT NULL,
  via TEXT NOT NULL,
  action TEXT NOT NULL,
  summary TEXT NOT NULL,
  database_id TEXT,
  database_name TEXT,
  outcome TEXT NOT NULL,
  status INTEGER NOT NULL,
  note TEXT,
  from_address TEXT,
  detail TEXT
);

CREATE INDEX IF NOT EXISTS idx_access_token_activity_token ON access_token_activity(token_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_access_token_activity_at ON access_token_activity(at);
