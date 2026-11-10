CREATE TABLE IF NOT EXISTS readonly_accounts (
  database_id TEXT PRIMARY KEY REFERENCES databases(id) ON DELETE CASCADE,
  mysql_user TEXT NOT NULL UNIQUE,
  mysql_host TEXT NOT NULL,
  password_enc TEXT NOT NULL,
  ready INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
