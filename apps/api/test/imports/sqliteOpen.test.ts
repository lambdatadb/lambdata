import { useTempMetadata, seedUser, type TempMetadata } from "../harness/sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { testRoot } from "../harness/isolate";
import { openSqliteReadOnly, sqliteReadOnlyUri } from "../../src/imports/sqliteFile";
import { buildSqliteBlueprint } from "../../src/imports/sqlitePlan";
import { receiveUpload, uploadPath } from "../../src/imports/uploads";

const NOCASE = "utf8mb4_uca1400_nopad_as_ci";
const BIG = 76561198000000001n;
const lockedDirs: string[] = [];

interface Fixture {
  dir: string;
  path: string;
  sha256: string;
  mtimeMs: number;
  listing: string[];
}

function sha256(path: string): string {
  return new Bun.CryptoHasher("sha256").update(readFileSync(path)).digest("hex");
}

function snapshot(dir: string, path: string): Fixture {
  return { dir, path, sha256: sha256(path), mtimeMs: statSync(path).mtimeMs, listing: readdirSync(dir).sort() };
}

function copiedOffRunningServer(): Fixture {
  const work = mkdtempSync(join(testRoot(), "sqlopen-"));
  const live = join(work, "sv.db");
  const db = new Database(live, { create: true, safeIntegers: true });
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("CREATE TABLE players (steamid BIGINT PRIMARY KEY, name TEXT NOT NULL)");
  db.query("INSERT INTO players VALUES (?, ?)").run(BIG, "Avery Chen");
  db.query("INSERT INTO players VALUES (?, ?)").run(9007199254740993n, "Jordan Lee");
  db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  db.query("INSERT INTO players VALUES (?, ?)").run(3n, "only in the wal file");
  const dir = join(work, "copied #1 ?50% off");
  mkdirSync(dir);
  const path = join(dir, "sv.db");
  copyFileSync(live, path);
  db.close();
  chmodSync(dir, 0o555);
  lockedDirs.push(dir);
  return snapshot(dir, path);
}

function expectUntouched(f: Fixture): void {
  expect(sha256(f.path)).toBe(f.sha256);
  expect(statSync(f.path).mtimeMs).toBe(f.mtimeMs);
  expect(readdirSync(f.dir).sort()).toEqual(f.listing);
}

describe("opening uploaded SQLite files", () => {
  let md: TempMetadata;

  beforeAll(() => {
    md = useTempMetadata();
  });

  afterAll(() => {
    for (const dir of lockedDirs) chmodSync(dir, 0o755);
    md.cleanup();
  });

  test("the fixture is a WAL-mode main file whose -wal file was left behind", () => {
    const f = copiedOffRunningServer();
    const header = readFileSync(f.path).subarray(18, 20);
    expect([...header]).toEqual([2, 2]);
    expect(f.listing).toEqual(["sv.db"]);
  });

  test("a WAL database copied without its -wal file opens read-only from a read-only folder and is never modified", () => {
    const f = copiedOffRunningServer();
    const db = openSqliteReadOnly(f.path);
    try {
      const rows = db.query("SELECT steamid, name FROM players ORDER BY steamid").all() as { steamid: bigint; name: string }[];
      expect(rows).toEqual([
        { steamid: 9007199254740993n, name: "Jordan Lee" },
        { steamid: BIG, name: "Avery Chen" },
      ]);
      const prepared = db.prepare("SELECT max(steamid) AS m FROM players").get() as { m: bigint };
      expect(prepared.m).toBe(BIG);
      expect(() => db.exec("DELETE FROM players")).toThrow();
    } finally {
      db.close();
    }
    expectUntouched(f);
  });

  test("the plan reads the copied file with exact 64-bit integers and leaves it untouched", async () => {
    const f = copiedOffRunningServer();
    const now = Date.now();
    const blueprint = await buildSqliteBlueprint(
      f.path,
      { id: "upl_00000000000000000000000000000000", fileName: "sv.db", sizeBytes: statSync(f.path).size, sha256: f.sha256, format: "sqlite", createdAt: now, expiresAt: now + 60_000 },
      { nocaseCollation: NOCASE },
    );
    const players = blueprint.plan.tables.find((t) => t.sourceName === "players");
    expect(players?.rowCount).toBe(2);
    expect(players?.columns.find((c) => c.sourceName === "steamid")?.mariadbType).toBe("BIGINT");
    expectUntouched(f);
  });

  test("uploading that file is accepted as SQLite and the stored upload is byte-identical", async () => {
    const f = copiedOffRunningServer();
    const user = seedUser("db_owner");
    const upload = await receiveUpload({
      body: Bun.file(f.path).stream(),
      fileName: "sv.db",
      userId: user.id,
      role: user.role,
      declaredLength: null,
    });
    expect(upload.format).toBe("sqlite");
    expect(upload.sha256).toBe(f.sha256);
    expect(sha256(uploadPath(upload.id))).toBe(f.sha256);
    const before = readdirSync(join(md.dataDir, "imports")).sort();
    const db = openSqliteReadOnly(uploadPath(upload.id));
    try {
      expect((db.query("SELECT count(*) AS n FROM players").get() as { n: bigint }).n).toBe(2n);
    } finally {
      db.close();
    }
    expect(readdirSync(join(md.dataDir, "imports")).sort()).toEqual(before);
    expect(sha256(uploadPath(upload.id))).toBe(f.sha256);
    expectUntouched(f);
  });

  test("the URI escapes characters SQLite would read as query or fragment and is absolute", () => {
    expect(sqliteReadOnlyUri("/data/a #1 ?50%/x.db")).toBe("file:///data/a %231 %3f50%25/x.db?mode=ro&immutable=1");
    expect(sqliteReadOnlyUri("rel/x.db").startsWith(`file://${process.cwd()}/rel/x.db?`)).toBe(true);
  });
});
