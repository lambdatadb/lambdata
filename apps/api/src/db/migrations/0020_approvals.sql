CREATE TABLE IF NOT EXISTS access_token_approvals (
  id TEXT PRIMARY KEY,
  token_id TEXT NOT NULL REFERENCES access_tokens(id) ON DELETE CASCADE,
  action TEXT NOT NULL,
  method TEXT NOT NULL,
  path TEXT NOT NULL,
  body_hash TEXT NOT NULL,
  summary TEXT NOT NULL,
  detail TEXT,
  database_id TEXT,
  database_name TEXT,
  note TEXT,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','approved','denied','expired','used','cancelled')),
  requested_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  decided_at INTEGER,
  decided_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  decided_by_display_name TEXT,
  approved_until INTEGER,
  used_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_access_token_approvals_status ON access_token_approvals(status, requested_at DESC);
CREATE INDEX IF NOT EXISTS idx_access_token_approvals_token ON access_token_approvals(token_id, status);
CREATE INDEX IF NOT EXISTS idx_access_token_approvals_request
  ON access_token_approvals(token_id, method, path, body_hash, status);

CREATE TABLE IF NOT EXISTS access_token_undo_points (
  token_id TEXT NOT NULL REFERENCES access_tokens(id) ON DELETE CASCADE,
  database_id TEXT NOT NULL REFERENCES databases(id) ON DELETE CASCADE,
  checkpoint_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_change_at INTEGER NOT NULL,
  PRIMARY KEY (token_id, database_id)
);
