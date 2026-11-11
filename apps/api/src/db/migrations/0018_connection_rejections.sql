CREATE TABLE IF NOT EXISTS connection_rejections (
  address TEXT NOT NULL,
  account TEXT NOT NULL DEFAULT '',
  reason TEXT NOT NULL,
  database_id TEXT REFERENCES databases(id) ON DELETE CASCADE,
  count INTEGER NOT NULL DEFAULT 0,
  first_at INTEGER NOT NULL,
  last_at INTEGER NOT NULL,
  PRIMARY KEY (address, account, reason)
);

CREATE INDEX IF NOT EXISTS idx_connection_rejections_last ON connection_rejections(last_at);
CREATE INDEX IF NOT EXISTS idx_connection_rejections_database ON connection_rejections(database_id, last_at);
