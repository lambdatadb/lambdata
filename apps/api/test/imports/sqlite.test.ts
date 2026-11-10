import { createTestDatabase, mariadbAvailable, startTestInstance, type TestInstance } from "../harness/instance";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { canonicalRows, buildSqlite, columnPlan, importInto, mariaQuery, NOCASE, planFor, tablePlan } from "./helpers";

const available = mariadbAvailable();
const T = 120_000;

function ins(db: Database, sql: string, ...rows: unknown[][]): void {
  const stmt = db.query(sql);
  for (const r of rows) stmt.run(...(r as never[]));
}

async function expectRoundTrip(path: string, bp: Awaited<ReturnType<typeof planFor>>, schema: string): Promise<void> {
  for (const t of bp.tables) {
    const { sqlite, maria } = await canonicalRows(path, bp, t.sourceName, schema);
    expect(maria.length).toBe(t.rowCount);
    expect(maria).toEqual(sqlite);
  }
}

describe.skipIf(!available)("SQLite import hazards", () => {
  let instance: TestInstance;

  beforeAll(async () => {
    instance = await startTestInstance();
  }, T);

  afterAll(async () => {
    await instance?.stop();
  }, T);

  test("1. 64-bit integers such as SteamID64 survive exactly", async () => {
    const big = [76561198000000001n, 76561198000000002n, 9223372036854775807n, -9223372036854775808n, 9007199254740993n];
    const path = buildSqlite((db) => {
      db.exec("CREATE TABLE darkrp_player (uid BIGINT NOT NULL PRIMARY KEY, rpname VARCHAR(45), wallet INTEGER NOT NULL)");
      db.exec("CREATE TABLE stats (steamid, points)");
      big.forEach((v, i) => ins(db, "INSERT INTO darkrp_player VALUES (?, ?, ?)", [v, `p${i}`, v]));
      big.forEach((v) => ins(db, "INSERT INTO stats VALUES (?, ?)", [v, 1n]));
    });
    const { schema } = await createTestDatabase();
    const { blueprint } = await importInto(path, schema);
    expect(columnPlan(blueprint, "darkrp_player", "uid").mariadbType).toBe("BIGINT");
    expect(columnPlan(blueprint, "stats", "steamid").mariadbType).toBe("BIGINT");
    const rows = await mariaQuery<{ uid: string; wallet: string }>(schema, "SELECT CAST(uid AS CHAR) AS uid, CAST(wallet AS CHAR) AS wallet FROM darkrp_player ORDER BY darkrp_player.uid");
    expect(rows.map((r) => r.uid)).toEqual([...big].sort((a, b) => (a < b ? -1 : 1)).map(String));
    expect(rows.every((r) => r.uid === r.wallet)).toBe(true);
    const stats = await mariaQuery<{ s: string }>(schema, "SELECT CAST(steamid AS CHAR) AS s FROM stats WHERE steamid = 76561198000000002");
    expect(stats).toEqual([{ s: "76561198000000002" }]);
    await expectRoundTrip(path, blueprint, schema);
  }, T);

  test("2. keys differing only by case or trailing spaces stay distinct; NOCASE stays case-insensitive", async () => {
    const keys = ["abc", "ABC", "Abc", "a", "a ", "a  ", "ß", "ss"];
    const path = buildSqlite((db) => {
      db.exec("CREATE TABLE cookies (key TEXT NOT NULL PRIMARY KEY, value TEXT)");
      db.exec("CREATE TABLE playerpdata (infoid TEXT NOT NULL UNIQUE, value TEXT)");
      db.exec("CREATE TABLE names (n TEXT COLLATE NOCASE UNIQUE, note TEXT)");
      db.exec("CREATE TABLE accents (n TEXT COLLATE NOCASE UNIQUE)");
      keys.forEach((k, i) => ins(db, "INSERT INTO cookies VALUES (?, ?)", [k, `v${i}`]));
      keys.forEach((k, i) => ins(db, "INSERT INTO playerpdata VALUES (?, ?)", [`${k}[money]`, `${i}`]));
      ins(db, "INSERT INTO names VALUES (?, ?)", ["Bob", "x"], ["alice", "y"]);
      ins(db, "INSERT INTO accents VALUES (?)", ["É"], ["é"]);
    });
    const { schema } = await createTestDatabase();
    const { blueprint } = await importInto(path, schema);
    expect(columnPlan(blueprint, "cookies", "key").mariadbType).toMatch(/^VARCHAR\(\d+\) COLLATE utf8mb4_nopad_bin$/);
    expect(columnPlan(blueprint, "names", "n").mariadbType).toContain(NOCASE);
    expect(columnPlan(blueprint, "accents", "n").mariadbType).toContain("utf8mb4_nopad_bin");
    expect(tablePlan(blueprint, "accents").warnings.join(" ")).toMatch(/collide/);
    const cookies = await mariaQuery<{ k: string }>(schema, "SELECT HEX(`key`) AS k FROM cookies");
    expect(cookies.map((r) => Buffer.from(r.k, "hex").toString()).sort()).toEqual([...keys].sort());
    expect(await mariaQuery(schema, "SELECT value FROM cookies WHERE `key` = 'abc'")).toEqual([{ value: "v0" }]);
    expect(await mariaQuery(schema, "SELECT value FROM cookies WHERE `key` = 'a'")).toEqual([{ value: "v3" }]);
    expect(await mariaQuery(schema, "SELECT note FROM names WHERE n = 'BOB'")).toEqual([{ note: "x" }]);
    const unique = await mariaQuery<{ NON_UNIQUE: string; INDEX_NAME: string }>(
      "information_schema",
      "SELECT NON_UNIQUE, INDEX_NAME FROM STATISTICS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'playerpdata'",
      [schema],
    );
    expect(unique).toEqual([{ NON_UNIQUE: "0", INDEX_NAME: "infoid" }]);
    await expectRoundTrip(path, blueprint, schema);
  }, T);

  test("3. keyed text becomes VARCHAR sized from the data; keys that cannot fit are dropped with a warning", async () => {
    const path = buildSqlite((db) => {
      db.exec("CREATE TABLE pairs (a TEXT, b TEXT, PRIMARY KEY (a, b))");
      db.exec("CREATE TABLE huge (doc TEXT UNIQUE, n INTEGER)");
      db.exec("CREATE TABLE tags (tag TEXT, note TEXT)");
      db.exec("CREATE INDEX tags_tag ON tags(tag)");
      ins(db, "INSERT INTO pairs VALUES (?, ?)", ["x".repeat(300), "y".repeat(300)], ["short", "s"]);
      ins(db, "INSERT INTO huge VALUES (?, ?)", ["z".repeat(1000), 1n], ["w".repeat(10), 2n]);
      ins(db, "INSERT INTO tags VALUES (?, ?)", ["steam", "a"], ["gmod", "b"]);
    });
    const { schema } = await createTestDatabase();
    const { blueprint } = await importInto(path, schema);
    const a = columnPlan(blueprint, "pairs", "a").mariadbType;
    const b = columnPlan(blueprint, "pairs", "b").mariadbType;
    const len = (t: string) => Number(/VARCHAR\((\d+)\)/.exec(t)?.[1]);
    expect(len(a)).toBeGreaterThanOrEqual(300);
    expect(len(b)).toBeGreaterThanOrEqual(300);
    expect(4 * (len(a) + len(b))).toBeLessThanOrEqual(3072);
    expect(columnPlan(blueprint, "huge", "doc").mariadbType).toBe("TEXT COLLATE utf8mb4_nopad_bin");
    const hugeIndex = tablePlan(blueprint, "huge").indexes.find((i) => i.columns.includes("doc"));
    expect(hugeIndex?.skippedReason).toMatch(/Too long for a MariaDB index/);
    expect(tablePlan(blueprint, "huge").warnings.join(" ")).toMatch(/not created/);
    expect(len(columnPlan(blueprint, "tags", "tag").mariadbType)).toBe(32);
    const docs = await mariaQuery<{ n: string }>(schema, "SELECT LENGTH(doc) AS n FROM huge ORDER BY n");
    expect(docs.map((d) => Number(d.n))).toEqual([10, 1000]);
    const tagIndex = await mariaQuery("information_schema", "SELECT INDEX_NAME FROM STATISTICS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'tags'", [schema]);
    expect(tagIndex).toEqual([{ INDEX_NAME: "tags_tag" }]);
    await expectRoundTrip(path, blueprint, schema);
  }, T);

  test("4. mixed or mismatched types pick a type that holds every value exactly", async () => {
    const path = buildSqlite((db) => {
      db.exec("CREATE TABLE loose (id INTEGER PRIMARY KEY, anything, declared_int INTEGER, nums, bigmix, flag BOOLEAN, price DECIMAL(10,2))");
      ins(
        db,
        "INSERT INTO loose (id, anything, declared_int, nums, bigmix, flag, price) VALUES (?, ?, ?, ?, ?, ?, ?)",
        [1n, 1n, "abc", 1n, 76561198000000001n, 1n, 1.5],
        [2n, "one", 5n, 2.5, 0.25, 0n, 19.99],
        [3n, 2.75, 7n, -3n, 3n, 1n, 100n],
        [4n, new Uint8Array([0, 255, 10]), null, 1e300, null, null, null],
        [5n, null, "12", 0.1, null, 0n, 0.07],
      );
    });
    const { schema } = await createTestDatabase();
    const { blueprint } = await importInto(path, schema);
    expect(columnPlan(blueprint, "loose", "anything").mariadbType).toBe("LONGBLOB");
    expect(columnPlan(blueprint, "loose", "anything").notes.join(" ")).toMatch(/stored as binary/);
    expect(columnPlan(blueprint, "loose", "declared_int").mariadbType).toBe("TEXT COLLATE utf8mb4_nopad_bin");
    expect(columnPlan(blueprint, "loose", "nums").mariadbType).toBe("DOUBLE");
    expect(columnPlan(blueprint, "loose", "bigmix").mariadbType).toBe("TEXT COLLATE utf8mb4_nopad_bin");
    expect(columnPlan(blueprint, "loose", "flag").mariadbType).toBe("TINYINT(1)");
    expect(columnPlan(blueprint, "loose", "price").mariadbType).toBe("DECIMAL(10,2)");
    const rows = await mariaQuery<Record<string, string | null>>(
      schema,
      "SELECT id, HEX(anything) AS anything, declared_int, CAST(bigmix AS CHAR) AS bigmix, CAST(price AS CHAR) AS price FROM loose ORDER BY id",
    );
    expect(rows.map((r) => r.anything)).toEqual(["31", "6F6E65", "322E3735", "00FF0A", null]);
    expect(rows.map((r) => r.declared_int)).toEqual(["abc", "5", "7", null, "12"]);
    expect(rows.map((r) => r.bigmix)).toEqual(["76561198000000001", "0.25", "3", null, null]);
    expect(rows.map((r) => r.price)).toEqual(["1.50", "19.99", "100.00", null, "0.07"]);
    await expectRoundTrip(path, blueprint, schema);
  }, T);

  test("5. invalid UTF-8 in TEXT is stored as binary with a warning, bytes unchanged", async () => {
    const path = buildSqlite((db) => {
      db.exec("CREATE TABLE chat (id INTEGER PRIMARY KEY, msg TEXT)");
      db.exec("INSERT INTO chat VALUES (1, CAST(X'FF61C328' AS TEXT)), (2, 'héllo'), (3, CAST(X'ED A0 80' AS TEXT))".replace("X'ED A0 80'", "X'EDA080'"));
    });
    const { schema } = await createTestDatabase();
    const { blueprint } = await importInto(path, schema);
    expect(columnPlan(blueprint, "chat", "msg").mariadbType).toBe("LONGBLOB");
    expect(tablePlan(blueprint, "chat").warnings.join(" ")).toMatch(/not valid UTF-8/);
    const rows = await mariaQuery<{ h: string }>(schema, "SELECT HEX(msg) AS h FROM chat ORDER BY id");
    expect(rows.map((r) => r.h)).toEqual(["FF61C328", Buffer.from("héllo").toString("hex").toUpperCase(), "EDA080"]);
    await expectRoundTrip(path, blueprint, schema);
  }, T);

  test("6. zero and explicit ids keep their values and AUTO_INCREMENT continues above them", async () => {
    const path = buildSqlite((db) => {
      db.exec("CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT)");
      db.exec("CREATE TABLE logs (id INTEGER PRIMARY KEY AUTOINCREMENT, line TEXT)");
      ins(db, "INSERT INTO items VALUES (?, ?)", [0n, "zero"], [-3n, "negative"], [5n, "five"]);
      ins(db, "INSERT INTO logs (id, line) VALUES (?, ?)", [1n, "a"], [2n, "b"], [100n, "c"]);
      db.exec("DELETE FROM logs WHERE id = 100");
    });
    const { schema } = await createTestDatabase();
    const { blueprint } = await importInto(path, schema);
    expect(columnPlan(blueprint, "items", "id")).toMatchObject({ mariadbType: "BIGINT", autoIncrement: true, primaryKey: true });
    expect(tablePlan(blueprint, "logs").createSql).toContain("AUTO_INCREMENT=101");
    const items = await mariaQuery<{ id: string; name: string }>(schema, "SELECT CAST(id AS CHAR) AS id, name FROM items ORDER BY id");
    expect(items).toEqual([
      { id: "-3", name: "negative" },
      { id: "0", name: "zero" },
      { id: "5", name: "five" },
    ]);
    await mariaQuery(schema, "INSERT INTO items (name) VALUES ('next')");
    await mariaQuery(schema, "INSERT INTO logs (line) VALUES ('next')");
    expect(await mariaQuery(schema, "SELECT CAST(id AS CHAR) AS id FROM items WHERE name = 'next'")).toEqual([{ id: "6" }]);
    expect(await mariaQuery(schema, "SELECT CAST(id AS CHAR) AS id FROM logs WHERE line = 'next'")).toEqual([{ id: "101" }]);
  }, T);

  test("7. empty string, NULL, NUL bytes and empty blobs stay distinct", async () => {
    const path = buildSqlite((db) => {
      db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, s TEXT, b BLOB)");
      db.exec("INSERT INTO t VALUES (1, '', X''), (2, NULL, NULL), (3, CAST(X'610062' AS TEXT), X'00'), (4, ' ', X'0000')");
    });
    const { schema } = await createTestDatabase();
    const { blueprint } = await importInto(path, schema);
    const rows = await mariaQuery<{ s: string | null; b: string | null; sn: string; bn: string }>(
      schema,
      "SELECT HEX(s) AS s, HEX(b) AS b, CAST(s IS NULL AS CHAR) AS sn, CAST(b IS NULL AS CHAR) AS bn FROM t ORDER BY id",
    );
    expect(rows).toEqual([
      { s: "", b: "", sn: "0", bn: "0" },
      { s: null, b: null, sn: "1", bn: "1" },
      { s: "610062", b: "00", sn: "0", bn: "0" },
      { s: "20", b: "0000", sn: "0", bn: "0" },
    ]);
    await expectRoundTrip(path, blueprint, schema);
  }, T);

  test("8. dates become DATE/DATETIME only when declared so and every value prints back identically", async () => {
    const path = buildSqlite((db) => {
      db.exec("CREATE TABLE bans (id INTEGER PRIMARY KEY, created DATETIME, day DATE, iso DATETIME, unix TIMESTAMP, precise TIMESTAMP, text_dates TEXT)");
      ins(
        db,
        "INSERT INTO bans VALUES (?, ?, ?, ?, ?, ?, ?)",
        [1n, "2024-02-29 23:59:59", "2024-02-29", "2024-01-01T10:00:00Z", 1700000000n, "2024-01-01 00:00:00.125", "2024-01-01"],
        [2n, "1999-12-31 00:00:00", "1999-12-31", "2024-01-01 10:00:00", 1700000001n, "2024-01-01 00:00:01.500", "2024-01-02"],
        [3n, null, null, null, null, null, null],
      );
    });
    const { schema } = await createTestDatabase();
    const { blueprint } = await importInto(path, schema);
    expect(columnPlan(blueprint, "bans", "created").mariadbType).toBe("DATETIME");
    expect(columnPlan(blueprint, "bans", "day").mariadbType).toBe("DATE");
    expect(columnPlan(blueprint, "bans", "iso").mariadbType).toBe("TEXT COLLATE utf8mb4_nopad_bin");
    expect(columnPlan(blueprint, "bans", "iso").notes.join(" ")).toMatch(/kept as text/);
    expect(columnPlan(blueprint, "bans", "unix").mariadbType).toBe("BIGINT");
    expect(columnPlan(blueprint, "bans", "precise").mariadbType).toBe("DATETIME(3)");
    expect(columnPlan(blueprint, "bans", "text_dates").mariadbType).toBe("TEXT COLLATE utf8mb4_nopad_bin");
    const rows = await mariaQuery<Record<string, string | null>>(
      schema,
      "SELECT CAST(created AS CHAR) AS created, CAST(day AS CHAR) AS day, iso, CAST(precise AS CHAR) AS precise FROM bans ORDER BY id",
    );
    expect(rows[0]).toEqual({ created: "2024-02-29 23:59:59", day: "2024-02-29", iso: "2024-01-01T10:00:00Z", precise: "2024-01-01 00:00:00.125" });
    expect(rows[1]!.precise).toBe("2024-01-01 00:00:01.500");
    await expectRoundTrip(path, blueprint, schema);
  }, T);

  test("9. identifiers that MariaDB rejects or would merge are renamed and the mapping is recorded", async () => {
    const longName = `addon_${"x".repeat(70)}`;
    const path = buildSqlite((db) => {
      db.exec(`CREATE TABLE "${longName}" (id INTEGER PRIMARY KEY, "café" TEXT, "cafe" TEXT, "score " INTEGER, "tab\tname" TEXT)`);
      db.exec(`CREATE TABLE "Ünits" (a INTEGER)`);
      db.exec(`CREATE TABLE "ünits" (a INTEGER)`);
      db.exec(`CREATE TABLE "with space" ("my col" TEXT)`);
      ins(db, `INSERT INTO "${longName}" VALUES (?, ?, ?, ?, ?)`, [1n, "accent", "plain", 7n, "t"]);
      ins(db, `INSERT INTO "Ünits" VALUES (?)`, [1n]);
      ins(db, `INSERT INTO "ünits" VALUES (?)`, [2n]);
      ins(db, `INSERT INTO "with space" VALUES (?)`, ["ok"]);
    });
    const { schema } = await createTestDatabase();
    const { blueprint } = await importInto(path, schema);
    const long = tablePlan(blueprint, longName);
    expect([...long.targetName].length).toBe(64);
    expect(long.warnings.join(" ")).toMatch(/longer than 64/);
    const cols = Object.fromEntries(long.columns.map((c) => [c.sourceName, c.targetName]));
    expect(cols).toEqual({ id: "id", "café": "café", cafe: "cafe_2", "score ": "score", "tab\tname": "tab_name" });
    expect(tablePlan(blueprint, "ünits").targetName).toBe("ünits_2");
    expect(tablePlan(blueprint, "with space").targetName).toBe("with space");
    expect(blueprint.plan.warnings.join(" ")).toMatch(/Data API/);
    const rows = await mariaQuery(schema, `SELECT \`café\` AS a, cafe_2 AS b, CAST(score AS CHAR) AS s, tab_name AS t FROM \`${long.targetName}\``);
    expect(rows).toEqual([{ a: "accent", b: "plain", s: "7", t: "t" }]);
    expect(await mariaQuery(schema, "SELECT CAST(a AS CHAR) AS a FROM `ünits_2`")).toEqual([{ a: "2" }]);
    await expectRoundTrip(path, blueprint, schema);
  }, T);

  test("10. literal defaults and CURRENT_TIMESTAMP translate; expression defaults are dropped with a note", async () => {
    const path = buildSqlite((db) => {
      db.exec(`CREATE TABLE d (
        id INTEGER PRIMARY KEY,
        salary INTEGER NOT NULL DEFAULT 45,
        label TEXT DEFAULT 'it''s \\ ok',
        num_text TEXT DEFAULT 0,
        stamp TEXT DEFAULT CURRENT_TIMESTAMP,
        created DATETIME DEFAULT CURRENT_TIMESTAMP,
        seconds INTEGER DEFAULT (strftime('%s','now')),
        ratio REAL DEFAULT 0.5,
        active BOOLEAN DEFAULT TRUE,
        maybe TEXT DEFAULT NULL
      )`);
      ins(db, "INSERT INTO d (id, created) VALUES (?, ?)", [1n, "2024-01-01 00:00:00"]);
    });
    const { schema } = await createTestDatabase();
    const { blueprint } = await importInto(path, schema);
    const plan = (c: string) => columnPlan(blueprint, "d", c);
    expect(plan("salary").defaultSql).toBe("45");
    expect(plan("label").defaultSql).toBe("'it''s \\\\ ok'");
    expect(plan("num_text").defaultSql).toBe("'0'");
    expect(plan("stamp").defaultSql).toBe("(UTC_TIMESTAMP())");
    expect(plan("created").defaultSql).toBe("(UTC_TIMESTAMP())");
    expect(plan("seconds").defaultSql).toBeNull();
    expect(plan("seconds").notes.join(" ")).toMatch(/strftime.*dropped/);
    expect(plan("ratio").defaultSql).toBe("5e-1");
    expect(plan("active").defaultSql).toBe("1");
    expect(plan("maybe").defaultSql).toBe("NULL");
    await mariaQuery(schema, "INSERT INTO d (id) VALUES (2)");
    const [row] = await mariaQuery<Record<string, string | null>>(
      schema,
      "SELECT CAST(salary AS CHAR) AS salary, label, num_text, stamp, CAST(created AS CHAR) AS created, seconds, CAST(ratio AS CHAR) AS ratio, CAST(active AS CHAR) AS active, maybe FROM d WHERE id = 2",
    );
    expect(row).toMatchObject({ salary: "45", label: "it's \\ ok", num_text: "0", seconds: null, ratio: "0.5", active: "1", maybe: null });
    expect(row!.stamp).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    expect(row!.created).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  }, T);

  test("11. foreign keys are added after loading; ones the data violates are skipped with the reason", async () => {
    const path = buildSqlite((db) => {
      db.exec("CREATE TABLE players (steamid TEXT PRIMARY KEY, name TEXT)");
      db.exec("CREATE TABLE bans (id INTEGER PRIMARY KEY, steamid TEXT REFERENCES players(steamid) ON DELETE CASCADE)");
      db.exec("CREATE TABLE kills (id INTEGER PRIMARY KEY, killer TEXT REFERENCES players(steamid))");
      db.exec("CREATE TABLE ghost (id INTEGER PRIMARY KEY, x INTEGER REFERENCES nowhere(id))");
      ins(db, "INSERT INTO players VALUES (?, ?)", ["STEAM_0:1:1", "a"], ["STEAM_0:1:2", "b"]);
      ins(db, "INSERT INTO bans VALUES (?, ?)", [1n, "STEAM_0:1:1"]);
      ins(db, "INSERT INTO kills VALUES (?, ?)", [1n, "STEAM_0:1:2"], [2n, "STEAM_0:9:9"]);
      ins(db, "INSERT INTO ghost VALUES (?, ?)", [1n, 5n]);
    });
    const { schema } = await createTestDatabase();
    const { blueprint, warnings } = await importInto(path, schema);
    expect(warnings).toEqual([]);
    expect(tablePlan(blueprint, "bans").foreignKeys).toEqual([
      { columns: ["steamid"], refTable: "players", refColumns: ["steamid"], skippedReason: null },
    ]);
    expect(tablePlan(blueprint, "kills").foreignKeys[0]!.skippedReason).toMatch(/1 row\(s\) reference rows that do not exist/);
    expect(tablePlan(blueprint, "ghost").foreignKeys[0]!.skippedReason).toMatch(/does not exist in the file/);
    const fks = await mariaQuery<{ TABLE_NAME: string; DELETE_RULE: string }>(
      "information_schema",
      "SELECT TABLE_NAME, DELETE_RULE FROM REFERENTIAL_CONSTRAINTS WHERE CONSTRAINT_SCHEMA = ?",
      [schema],
    );
    expect(fks).toEqual([{ TABLE_NAME: "bans", DELETE_RULE: "CASCADE" }]);
    expect(await mariaQuery(schema, "SELECT COUNT(*) AS n FROM kills")).toEqual([{ n: "2" }]);
    await expectRoundTrip(path, blueprint, schema);
  }, T);

  test("12. tables without a primary key import without one and say so; views, triggers and virtual tables are reported", async () => {
    const path = buildSqlite((db) => {
      db.exec("CREATE TABLE eventlog (at INTEGER, what TEXT)");
      db.exec("CREATE VIEW recent AS SELECT * FROM eventlog WHERE at > 0");
      db.exec("CREATE TRIGGER tr AFTER INSERT ON eventlog BEGIN SELECT 1; END");
      try {
        db.exec("CREATE VIRTUAL TABLE docs USING fts5(body)");
        db.exec("INSERT INTO docs VALUES ('hello')");
      } catch {}
      ins(db, "INSERT INTO eventlog VALUES (?, ?)", [1n, "a"], [1n, "a"]);
    });
    const { schema } = await createTestDatabase();
    const { blueprint } = await importInto(path, schema);
    const log = tablePlan(blueprint, "eventlog");
    expect(log.createSql).not.toContain("PRIMARY KEY");
    expect(log.warnings.join(" ")).toMatch(/No primary key.*Data API/);
    const kinds = blueprint.plan.skipped.map((s) => `${s.kind}:${s.name}`);
    expect(kinds).toContain("view:recent");
    expect(kinds).toContain("trigger:tr");
    expect(blueprint.plan.skipped.find((s) => s.name === "recent")?.sql).toContain("CREATE VIEW recent");
    if (kinds.some((k) => k === "virtual-table:docs")) {
      expect(blueprint.plan.tables.map((t) => t.sourceName)).toEqual(["eventlog"]);
      expect(kinds.filter((k) => k.startsWith("virtual-table:docs_")).length).toBeGreaterThan(0);
    }
    expect(await mariaQuery(schema, "SELECT COUNT(*) AS n FROM eventlog")).toEqual([{ n: "2" }]);
    await expectRoundTrip(path, blueprint, schema);
  }, T);

  test("the plan's createSql is exactly what MariaDB ran", async () => {
    const path = buildSqlite((db) => {
      db.exec("CREATE TABLE playerpdata (infoid TEXT NOT NULL UNIQUE, value TEXT)");
      db.exec("CREATE TABLE cookies (key TEXT NOT NULL PRIMARY KEY, value TEXT)");
      ins(db, "INSERT INTO playerpdata VALUES (?, ?)", ["76561198000000001[money]", "500"]);
      ins(db, "INSERT INTO cookies VALUES (?, ?)", ["lastvisit", "2024"]);
    });
    const { schema } = await createTestDatabase();
    const { blueprint } = await importInto(path, schema);
    for (const t of blueprint.plan.tables) {
      expect(t.createSql.startsWith(`CREATE TABLE \`${t.targetName}\` (`)).toBe(true);
      const shown = await mariaQuery<{ "Create Table": string }>(schema, `SHOW CREATE TABLE \`${t.targetName}\``);
      const actual = shown[0]!["Create Table"];
      for (const c of t.columns) expect(actual).toContain(`\`${c.targetName}\``);
    }
    const desc = await mariaQuery<{ COLUMN_NAME: string; COLUMN_TYPE: string; COLLATION_NAME: string | null }>(
      "information_schema",
      "SELECT COLUMN_NAME, COLUMN_TYPE, COLLATION_NAME FROM COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'cookies' ORDER BY ORDINAL_POSITION",
      [schema],
    );
    const plan = tablePlan(blueprint, "cookies").columns;
    expect(desc.map((d) => `${d.COLUMN_TYPE} COLLATE ${d.COLLATION_NAME}`.toUpperCase())).toEqual(plan.map((c) => c.mariadbType.toUpperCase()));
  }, T);
});
