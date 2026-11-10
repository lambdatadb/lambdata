ALTER TABLE users ADD COLUMN theme TEXT NOT NULL DEFAULT 'lime';

UPDATE users SET theme = color_theme
WHERE color_theme IN ('tide', 'grove', 'orchid')
   OR (
     color_theme = 'ember'
     AND (
       SELECT CASE WHEN json_valid(a.details) THEN json_extract(a.details, '$.colorTheme') END
       FROM audit_log a
       WHERE a.action = 'user.update'
         AND a.target = users.id
         AND (CASE WHEN json_valid(a.details) THEN json_type(a.details, '$.colorTheme') END) = 'text'
       ORDER BY a.at DESC, a.id DESC
       LIMIT 1
     ) = 'ember'
   );

ALTER TABLE databases ADD COLUMN versioned INTEGER NOT NULL DEFAULT 0;
ALTER TABLE databases ADD COLUMN base_checkpoint_id TEXT;
ALTER TABLE databases ADD COLUMN show_in_vitals INTEGER NOT NULL DEFAULT 1;
ALTER TABLE databases ADD COLUMN provision_state TEXT;

ALTER TABLE audit_log ADD COLUMN actor_email TEXT;

UPDATE audit_log
SET actor_email = (SELECT email FROM users WHERE users.id = audit_log.user_id)
WHERE actor_email IS NULL AND user_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_audit_log_at ON audit_log(at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_log_user ON audit_log(user_id);

WITH RECURSIVE
hits(id, path, n) AS (
  SELECT a.id, t.fullkey, ROW_NUMBER() OVER (PARTITION BY a.id ORDER BY t.id)
  FROM audit_log a,
       json_tree(CASE WHEN json_valid(a.details) THEN a.details ELSE 'null' END) t
  WHERE typeof(t.key) = 'text'
    AND (
      lower(replace(replace(t.key, '_', ''), '-', '')) LIKE '%password%'
      OR lower(replace(replace(t.key, '_', ''), '-', '')) LIKE '%passwd%'
      OR lower(replace(replace(t.key, '_', ''), '-', '')) LIKE '%secret%'
      OR lower(replace(replace(t.key, '_', ''), '-', '')) LIKE '%credential%'
      OR lower(replace(replace(t.key, '_', ''), '-', '')) LIKE '%token'
      OR lower(replace(replace(t.key, '_', ''), '-', '')) LIKE '%authkey'
      OR lower(replace(replace(t.key, '_', ''), '-', '')) LIKE '%apikey'
      OR lower(replace(replace(t.key, '_', ''), '-', '')) LIKE '%privatekey'
      OR lower(replace(replace(t.key, '_', ''), '-', '')) LIKE '%pwd'
      OR lower(replace(replace(t.key, '_', ''), '-', '')) LIKE '%enc'
      OR lower(replace(replace(t.key, '_', ''), '-', '')) IN ('authorization', 'cookie')
      OR (lower(t.key) = 'value' AND a.action LIKE '%secret%')
    )
),
applied(id, n, doc) AS (
  SELECT a.id, 0, a.details FROM audit_log a WHERE a.id IN (SELECT id FROM hits)
  UNION ALL
  SELECT applied.id, applied.n + 1, json_set(applied.doc, hits.path, '[redacted]')
  FROM applied JOIN hits ON hits.id = applied.id AND hits.n = applied.n + 1
)
UPDATE audit_log
SET details = (
  SELECT doc FROM applied WHERE applied.id = audit_log.id ORDER BY n DESC LIMIT 1
)
WHERE id IN (SELECT id FROM hits);

CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  database_id TEXT,
  status TEXT NOT NULL,
  exclusive INTEGER NOT NULL DEFAULT 1,
  stage TEXT,
  progress REAL,
  error TEXT,
  warnings TEXT NOT NULL DEFAULT '[]',
  result TEXT,
  created_by_user_id TEXT,
  created_at INTEGER NOT NULL,
  started_at INTEGER,
  finished_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_jobs_database_created ON jobs(database_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);
CREATE INDEX IF NOT EXISTS idx_jobs_created ON jobs(created_at DESC);
