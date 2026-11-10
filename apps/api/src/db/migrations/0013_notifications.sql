CREATE TABLE IF NOT EXISTS notification_destinations (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  config_enc TEXT NOT NULL,
  target TEXT NOT NULL,
  has_secret INTEGER NOT NULL DEFAULT 0,
  header_names TEXT NOT NULL DEFAULT '[]',
  ntfy_priority INTEGER,
  events TEXT NOT NULL DEFAULT '[]',
  database_ids TEXT,
  icon_url TEXT,
  last_success_at INTEGER,
  last_failure_at INTEGER,
  last_error TEXT,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  created_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS notification_deliveries (
  id TEXT PRIMARY KEY,
  destination_id TEXT NOT NULL REFERENCES notification_destinations(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  title TEXT NOT NULL,
  payload TEXT NOT NULL,
  status TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  response_status INTEGER,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  sent_at INTEGER,
  next_attempt_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_notification_deliveries_destination ON notification_deliveries(destination_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_notification_deliveries_status ON notification_deliveries(status, destination_id);

CREATE TABLE IF NOT EXISTS notification_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
