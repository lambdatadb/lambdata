import { afterAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { testRoot } from "../harness/isolate";
import { setDataDir } from "../../src/env";
import { closeDb, db, reopenDb } from "../../src/db/client";
import { MIGRATIONS_DIR, appliedMigrations, listMigrations, migrate } from "../../src/db/migrate";
import { redactAuditDetails } from "../../src/db/queries";
import {
  LEGACY_TABLES,
  SAMPLE_AUDIT,
  createLegacyDataDir,
  dumpTables,
  tableCounts,
} from "./legacy";

const dirs: string[] = [];

function openApp(dir: string): void {
  closeDb();
  setDataDir(dir);
  reopenDb();
}

function foundationOnly(): string {
  const dir = mkdtempSync(join(testRoot(), "mig-0001-"));
  dirs.push(dir);
  copyFileSync(join(MIGRATIONS_DIR, "0001_foundation.sql"), join(dir, "0001_foundation.sql"));
  return dir;
}

function allMigrationIds(): string[] {
  return listMigrations().map((m) => m.id);
}

function ledgerInInsertOrder(): string[] {
  return (db.query("SELECT id FROM schema_migrations ORDER BY rowid").all() as { id: string }[]).map((r) => r.id);
}

function allTables(): string[] {
  return (
    db
      .query("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
      .all() as { name: string }[]
  ).map((r) => r.name);
}

function columns(table: string): string[] {
  return (db.query(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((r) => r.name);
}

afterAll(() => {
  closeDb();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

describe("migrations", () => {
  test("every migration applies exactly once, in order, without losing legacy rows", () => {
    const dir = createLegacyDataDir();
    dirs.push(dir);
    const before = tableCounts(join(dir, "metadata.sqlite"));
    openApp(dir);
    const expected = allMigrationIds();
    expect(expected).toContain("0001_foundation");
    expect(migrate()).toEqual(expected);
    expect(appliedMigrations()).toEqual(expected);
    expect(ledgerInInsertOrder()).toEqual(expected);
    expect(migrate()).toEqual([]);
    expect(ledgerInInsertOrder()).toEqual(expected);
    closeDb();
    expect(tableCounts(join(dir, "metadata.sqlite"))).toEqual(before);
  });

  test("0001_foundation adds its columns and repairs legacy data", () => {
    const dir = createLegacyDataDir();
    dirs.push(dir);
    const before = tableCounts(join(dir, "metadata.sqlite"));
    openApp(dir);
    expect(migrate(foundationOnly())).toEqual(["0001_foundation"]);
    closeDb();
    expect(tableCounts(join(dir, "metadata.sqlite"))).toEqual(before);
    openApp(dir);

    expect(columns("users")).toContain("theme");
    expect(columns("users")).toContain("color_theme");
    expect(columns("databases")).toEqual(
      expect.arrayContaining(["versioned", "base_checkpoint_id", "show_in_vitals", "provision_state"]),
    );
    expect(columns("audit_log")).toContain("actor_email");
    expect(columns("jobs")).toEqual(
      expect.arrayContaining([
        "id",
        "kind",
        "database_id",
        "status",
        "stage",
        "progress",
        "error",
        "warnings",
        "result",
        "created_by_user_id",
        "created_at",
        "started_at",
        "finished_at",
      ]),
    );

    const themes = Object.fromEntries(
      (db.query("SELECT id, theme FROM users").all() as { id: string; theme: string }[]).map((r) => [r.id, r.theme]),
    );
    expect(themes).toEqual({ u_admin: "tide", u_default: "lime", u_chose_ember: "ember" });

    const vitals = Object.fromEntries(
      (db.query("SELECT name, show_in_vitals, versioned FROM databases").all() as {
        name: string;
        show_in_vitals: number;
        versioned: number;
      }[]).map((r) => [r.name, [r.show_in_vitals, r.versioned]]),
    );
    expect(vitals).toEqual({ shop: [1, 0], tickets_mirror: [1, 0] });

    const audit = db
      .query("SELECT user_id, actor_email, action, details FROM audit_log ORDER BY id")
      .all() as { user_id: string | null; actor_email: string | null; action: string; details: string | null }[];
    expect(audit.map((a) => a.actor_email)).toEqual([
      "ember@example.test",
      "ember@example.test",
      "admin@example.test",
      null,
      "admin@example.test",
      "admin@example.test",
    ]);
    expect(JSON.parse(audit[2]!.details!)).toEqual({ password: "[redacted]" });
    expect(audit[2]!.details).not.toContain("plain-text-password");
    expect(audit[4]!.details).toBe("not json at all");
    expect(audit[5]!.details).toBeNull();
  });

  test("a second migrate is a no-op", () => {
    const dir = createLegacyDataDir();
    dirs.push(dir);
    openApp(dir);
    expect(migrate()).toEqual(allMigrationIds());
    const tables = allTables();
    expect(tables).toEqual(expect.arrayContaining([...LEGACY_TABLES, "jobs", "schema_migrations"]));
    const snapshot = dumpTables(db, tables);
    expect(migrate()).toEqual([]);
    expect(allTables()).toEqual(tables);
    expect(dumpTables(db, tables)).toBe(snapshot);
  });

  test("a fresh data directory gets the full schema", () => {
    const dir = mkdtempSync(join(testRoot(), "fresh-"));
    dirs.push(dir);
    openApp(dir);
    expect(migrate()).toEqual(allMigrationIds());
    expect(ledgerInInsertOrder()).toEqual(allMigrationIds());
    expect(columns("users")).toContain("theme");
    db.query(
      "INSERT INTO users(id, email, password_hash, role, created_at) VALUES('u', 'u@x', 'h', 'admin', 1)",
    ).run();
    expect(db.query("SELECT theme FROM users").get()).toEqual({ theme: "lime" });
  });

  test("the migration scrub matches the runtime redactor", () => {
    const dir = createLegacyDataDir(false);
    dirs.push(dir);
    const raw = new Database(join(dir, "metadata.sqlite"));
    const insert = raw.query("INSERT INTO audit_log(action, details, at) VALUES(?, ?, ?)");
    SAMPLE_AUDIT.forEach((s, i) => insert.run(s.action, JSON.stringify(s.details), i));
    raw.close();
    openApp(dir);
    migrate(foundationOnly());
    const rows = db.query("SELECT action, details FROM audit_log ORDER BY id").all() as {
      action: string;
      details: string;
    }[];
    expect(rows.length).toBe(SAMPLE_AUDIT.length);
    rows.forEach((row, i) => {
      const sample = SAMPLE_AUDIT[i]!;
      expect({ action: row.action, details: JSON.parse(row.details) }).toEqual({
        action: sample.action,
        details: redactAuditDetails(sample.action, sample.details),
      });
    });
    const all = rows.map((r) => r.details).join("\n");
    for (const secret of ["hunter2", "sk_live", "tskey", "Bearer x", "\"s\"", "\"t\"", "\"a\"", "\"p\"", "\"z\""]) {
      expect(all).not.toContain(secret);
    }
    expect(all).toContain("keep me");
    expect(all).toContain("tokenTtlSeconds");
  });

  test("migration files are well-formed and uniquely numbered", () => {
    const list = listMigrations();
    expect(list[0]?.id).toBe("0001_foundation");
    expect(new Set(list.map((m) => m.number)).size).toBe(list.length);
    expect([...list.map((m) => m.id)].sort()).toEqual(list.map((m) => m.id));
  });

  test("no migration changes rows picked out by one install's data, such as a database name", () => {
    const literalRowFilter = /\b(?:UPDATE|DELETE\s+FROM)\s+\w+\b[^;]*\bWHERE\b[^;]*\b(?:name|display_name|email|mysql_user)\s*(?:=|IN|LIKE)\s*\(?\s*'/i;
    for (const m of listMigrations()) {
      const sql = readFileSync(m.path, "utf8");
      expect({ id: m.id, filtersByLiteral: literalRowFilter.test(sql) }).toEqual({ id: m.id, filtersByLiteral: false });
    }
  });

  test("bad migration names and duplicate numbers are rejected", () => {
    const bad = mkdtempSync(join(testRoot(), "mig-bad-"));
    dirs.push(bad);
    writeFileSync(join(bad, "0001_ok.sql"), "SELECT 1;");
    writeFileSync(join(bad, "0002-dash.sql"), "SELECT 1;");
    expect(() => listMigrations(bad)).toThrow(/NNNN_name\.sql/);
    const dup = mkdtempSync(join(testRoot(), "mig-dup-"));
    dirs.push(dup);
    writeFileSync(join(dup, "0002_a.sql"), "SELECT 1;");
    writeFileSync(join(dup, "0002_b.sql"), "SELECT 1;");
    expect(() => listMigrations(dup)).toThrow(/share number 0002/);
  });

  test("a failing migration rolls back and is not recorded", () => {
    const dir = mkdtempSync(join(testRoot(), "mig-fail-"));
    dirs.push(dir);
    const migrations = mkdtempSync(join(testRoot(), "mig-set-"));
    dirs.push(migrations);
    writeFileSync(join(migrations, "0001_good.sql"), "CREATE TABLE extra_a (id INTEGER);");
    writeFileSync(
      join(migrations, "0002_bad.sql"),
      "CREATE TABLE extra_b (id INTEGER); INSERT INTO no_such_table VALUES (1);",
    );
    openApp(dir);
    expect(() => migrate(migrations)).toThrow();
    expect(appliedMigrations()).toEqual(["0001_good"]);
    const tables = (db.query("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map(
      (r) => r.name,
    );
    expect(tables).toContain("extra_a");
    expect(tables).not.toContain("extra_b");
  });

  const fixture = process.env.LAMBDATA_LEGACY_FIXTURE;
  test.skipIf(!fixture || !existsSync(fixture))("the real legacy fixture keeps every row", async () => {
    const work = mkdtempSync(join(testRoot(), "fixture-"));
    dirs.push(work);
    const files = ["metadata.sqlite", "metadata.sqlite-wal", "metadata.sqlite-shm"];
    const tar = Bun.spawn(["tar", "-xzf", fixture!, "-C", work, ...files.map((f) => `data/${f}`)], {
      stdout: "ignore",
      stderr: "pipe",
    });
    expect(await tar.exited).toBe(0);
    const dataDir = join(work, "app");
    mkdirSync(dataDir);
    for (const f of files) {
      if (existsSync(join(work, "data", f))) copyFileSync(join(work, "data", f), join(dataDir, f));
    }
    const before = tableCounts(join(dataDir, "metadata.sqlite"));
    openApp(dataDir);
    expect(migrate()).toEqual(allMigrationIds());
    expect(migrate()).toEqual([]);
    expect(ledgerInInsertOrder()).toEqual(allMigrationIds());
    closeDb();
    expect(tableCounts(join(dataDir, "metadata.sqlite"))).toEqual(before);
    openApp(dataDir);
    const leaked = db
      .query("SELECT COUNT(*) AS n FROM audit_log WHERE details LIKE '%password\":\"%' AND details NOT LIKE '%[redacted]%'")
      .get() as { n: number };
    expect(leaked.n).toBe(0);
  });
});
