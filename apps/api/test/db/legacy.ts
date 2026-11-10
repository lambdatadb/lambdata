import { Database } from "bun:sqlite";
import { mkdtempSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { testRoot } from "../harness/isolate";

export const LEGACY_TABLES = [
  "settings",
  "users",
  "databases",
  "sync_jobs",
  "snapshots",
  "storage_buckets",
  "storage_objects",
  "data_api_policies",
  "functions",
  "function_secrets",
  "function_invocations",
  "app_auth_users",
  "metrics",
  "sessions",
  "audit_log",
] as const;

export const SAMPLE_AUDIT: { action: string; details: unknown }[] = [
  { action: "user.update", details: { password: "hunter2", colorTheme: "grove" } },
  { action: "settings.update", details: { jwt_secret: "abc", dashboard_show_addresses: true, mariadb_root_password_enc: "x" } },
  { action: "function.secret.upsert", details: { name: "STRIPE", value: "sk_live" } },
  { action: "db.update", details: { value: "keep me", displayName: "Shop" } },
  { action: "sync.upsert", details: { nested: { sourcePassword: "s", port: 3306, list: [{ token: "t" }, { accessToken: "a" }] } } },
  { action: "app_auth.settings.update", details: { allowSignup: true, tokenTtlSeconds: 3600 } },
  { action: "x.secrets", details: { secrets: { password: "p" }, authKey: "k", "a.b": { newPassword: "z" }, currentPassword: "c" } },
  { action: "tailscale.up", details: { auth_key: "tskey", apiKey: "k2", private_key: "pk", pwd: "w", cookie: "c", Authorization: "Bearer x" } },
  { action: "x.array", details: [{ currentPassword: "c" }, "plain"] },
  { action: "x.null", details: null },
  { action: "x.string", details: "just text" },
  { action: "x.number", details: 42 },
];

export function legacySchemaSql(): string {
  return readFileSync(join(import.meta.dir, "fixtures", "legacy-schema.sql"), "utf8");
}

export function createLegacyDataDir(seed = true): string {
  const dir = mkdtempSync(join(testRoot(), "legacy-"));
  const d = new Database(join(dir, "metadata.sqlite"), { create: true });
  d.exec("PRAGMA foreign_keys = ON;");
  d.exec(legacySchemaSql());
  if (seed) seedLegacy(d);
  d.close();
  return dir;
}

function seedLegacy(d: Database): void {
  const now = 1_700_000_000_000;
  d.query("INSERT INTO settings(key, value) VALUES(?, ?)").run("setup_complete", "1");
  d.query("INSERT INTO settings(key, value) VALUES(?, ?)").run("dashboard_show_addresses", "false");
  const user = d.query(
    `INSERT INTO users(id, email, password_hash, display_name, role, experience_level, data_view_enabled,
      color_theme, vitals_chart_style, created_at, last_login_at) VALUES(?, ?, 'h', ?, ?, 'advanced', 0, ?, 'area', ?, NULL)`,
  );
  user.run("u_admin", "admin@example.test", "Admin", "admin", "tide", now);
  user.run("u_default", "default@example.test", "Default", "db_owner", "ember", now + 1);
  user.run("u_chose_ember", "ember@example.test", "Ember", "viewer", "ember", now + 2);
  const dbRow = d.query(
    `INSERT INTO databases(id, name, display_name, owner_user_id, kind, mysql_user, mysql_password_enc,
      connections_from, tailscale_exposed, lan_exposed, created_at, status)
     VALUES(?, ?, ?, 'u_admin', ?, ?, 'enc', '%', 0, 1, ?, 'active')`,
  );
  dbRow.run("db_shop", "shop", "Shop", "standard", "ld_shop_abcd", now);
  dbRow.run("db_hidden", "tickets_mirror", "Tickets mirror", "mirror", "ld_tickets_abcd", now + 1);
  d.query(
    `INSERT INTO sync_jobs(id, database_id, source_kind, source_host, source_port, source_user,
      source_password_enc, source_database, interval_seconds, enabled)
     VALUES('sj_1', 'db_hidden', 'mysql', '10.0.0.5', 3306, 'reader', 'enc', 'tickets', 3600, 1)`,
  ).run();
  d.query(
    `INSERT INTO snapshots(id, database_id, file_path, size_bytes, created_at, trigger)
     VALUES('snap_1', 'db_shop', '/old/data/snapshots/db_shop_1.sql', 10, ?, 'scheduled')`,
  ).run(now);
  d.query(
    `INSERT INTO storage_buckets(id, name, public, owner_user_id, created_at, updated_at)
     VALUES('bucket_1', 'assets', 1, 'u_default', ?, ?)`,
  ).run(now, now);
  d.query(
    `INSERT INTO storage_objects(id, bucket_id, name, relative_path, mime_type, size_bytes, created_at, updated_at)
     VALUES('obj_1', 'bucket_1', 'logo.png', 'bucket_1/obj_1', 'image/png', 3, ?, ?)`,
  ).run(now, now);
  d.query(
    `INSERT INTO data_api_policies(database_id, table_name, select_enabled, insert_enabled, update_enabled,
      delete_enabled, owner_column, created_at, updated_at) VALUES('db_shop', 'items', 1, 0, 0, 0, NULL, ?, ?)`,
  ).run(now, now);
  d.query(
    `INSERT INTO functions(name, verify_jwt, created_by_user_id, created_at, updated_at)
     VALUES('echo', 1, 'u_admin', ?, ?)`,
  ).run(now, now);
  d.query(
    "INSERT INTO function_secrets(name, value_enc, created_at, updated_at) VALUES('KEY', 'enc', ?, ?)",
  ).run(now, now);
  d.query(
    `INSERT INTO function_invocations(id, function_name, method, path, status_code, duration_ms,
      request_bytes, response_bytes, error, logs, invoked_by_app_user_id, created_at)
     VALUES('inv_1', 'echo', 'GET', '/', 200, 1.5, 0, 10, NULL, NULL, NULL, ?)`,
  ).run(now);
  d.query(
    `INSERT INTO app_auth_users(id, email, password_hash, display_name, email_confirmed, status, created_at)
     VALUES('app_1', 'app@example.test', 'h', NULL, 1, 'active', ?)`,
  ).run(now);
  d.query(
    `INSERT INTO metrics(database_id, collected_at, size_bytes, table_count, connection_count, row_count)
     VALUES('db_shop', ?, 100, 2, 1, 5)`,
  ).run(now);
  d.query("INSERT INTO sessions(id, user_id, created_at, expires_at) VALUES('s_1', 'u_admin', ?, ?)").run(now, now + 1);
  const audit = d.query("INSERT INTO audit_log(user_id, action, target, details, at) VALUES(?, ?, ?, ?, ?)");
  audit.run("u_chose_ember", "user.update", "u_chose_ember", JSON.stringify({ colorTheme: "tide" }), now);
  audit.run("u_chose_ember", "user.update", "u_chose_ember", JSON.stringify({ colorTheme: "ember" }), now + 1);
  audit.run("u_admin", "user.update", "u_default", JSON.stringify({ password: "plain-text-password" }), now + 2);
  audit.run(null, "data_dir.initial", null, JSON.stringify({ path: "/data" }), now + 3);
  audit.run("u_admin", "settings.update", null, "not json at all", now + 4);
  audit.run("u_admin", "auth.login", null, null, now + 5);
}

export function tableCounts(path: string, tables: readonly string[] = LEGACY_TABLES): Record<string, number> {
  const d = new Database(path);
  try {
    const out: Record<string, number> = {};
    for (const t of tables) {
      out[t] = Number((d.query(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n);
    }
    return out;
  } finally {
    d.close();
  }
}

export function dumpTables(d: { query(sql: string): { all(): unknown[] } }, tables: readonly string[]): string {
  const out: Record<string, unknown[]> = {};
  for (const t of tables) out[t] = d.query(`SELECT * FROM ${t} ORDER BY rowid`).all();
  return JSON.stringify(out);
}
