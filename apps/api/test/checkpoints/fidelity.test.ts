import { exec, makeDatabase, mariadbAvailable, rootQuery, select, setup, type Fixture } from "./helpers";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createCheckpoint, restoreCheckpoint } from "../../src/checkpoints";
import { checkpoints } from "../../src/db/queries";
import { readObjectText } from "../../src/checkpoints/store";
import { fingerprint, diffFingerprints, roundTrip, type RoundTrip } from "./fidelity";

const T = 240_000;

function expectExact(r: RoundTrip) {
  expect(r.captureError).toBeNull();
  expect(r.restoreError).toBeNull();
  expect(r.diffs).toEqual([]);
  expect(r.warnings).toEqual([]);
  expect(r.status).toBe("clean");
}

describe.skipIf(!mariadbAvailable())("checkpoint fidelity", () => {
  let fx: Fixture;

  beforeAll(async () => {
    fx = await setup();
    await rootQuery("CREATE DATABASE IF NOT EXISTS zz_fid_other");
    await rootQuery("CREATE TABLE IF NOT EXISTS zz_fid_other.log (id INT AUTO_INCREMENT PRIMARY KEY, msg VARCHAR(100))");
    await rootQuery("CREATE FUNCTION IF NOT EXISTS zz_fid_other.f_ext(x INT) RETURNS INT DETERMINISTIC RETURN x + 1000");
  }, 180_000);

  afterAll(async () => {
    await fx?.instance.stop();
  }, 120_000);

  test("FLOAT values come back bit for bit, including the reviewer's values and every edge", async () => {
    const r = await roundTrip(fx, [
      "CREATE TABLE flt (id INT PRIMARY KEY, f FLOAT, fu FLOAT UNSIGNED, fx FLOAT(7,4))",
      `INSERT INTO flt (id, f) VALUES (1, 1.0000001), (2, 16777217), (3, 0.1), (4, 123456.789), (5, 3.14159265),
         (6, -0e0), (7, 1.4e-45), (8, 1.1754942e-38), (9, 1.17549435e-38), (10, 3.4028234e38), (11, -3.4028234e38),
         (12, NULL), (13, 1e-46), (14, -1.4e-45), (15, 0), (16, 8388607.5), (17, 2.7182817)`,
      "UPDATE flt SET fu = ABS(f), fx = IF(ABS(f) < 1000, f, NULL)",
    ]);
    expectExact(r);
    const rows = await select<{ id: number; f: string | null }>(r.schema, "SELECT id, CONCAT(CAST(f AS DOUBLE)) AS f FROM flt ORDER BY id");
    const byId = Object.fromEntries(rows.map((x) => [x.id, x.f]));
    expect(byId[1]).toBe("1.0000001192092896");
    expect(byId[2]).toBe("16777216");
    expect(byId[4]).toBe("123456.7890625");
    expect(byId[5]).toBe("3.1415927410125732");
    expect(byId[6]).toBe("-0");
    expect(byId[7]).toBe("1.401298464324817e-45");
    expect(byId[10]).toBe("3.4028234663852886e38");
    expect(byId[12]).toBeNull();
    const sign = await select<{ s: number }>(r.schema, "SELECT ATAN2(f, -1) < 0 AS s FROM flt WHERE id = 6");
    expect(Number(sign[0]!.s)).toBe(1);
  }, T);

  test("DOUBLE values, extremes, denormals and negative zero round-trip bit for bit", async () => {
    expectExact(
      await roundTrip(fx, [
        "CREATE TABLE dbl (id INT PRIMARY KEY, d DOUBLE, dm DOUBLE(10,3), r REAL)",
        `INSERT INTO dbl (id, d) VALUES (1, 0.30000000000000004), (2, 1.7976931348623157e308), (3, -1.7976931348623157e308),
           (4, 2.2250738585072014e-308), (5, 4.9e-324), (6, -0e0), (7, 1e-320), (8, NULL), (9, 123456.789012345678), (10, -5e-324)`,
        "UPDATE dbl SET dm = IF(ABS(d) < 1e6, d, NULL), r = d",
      ]),
    );
  }, T);

  test("float objects are deterministic and store exact literals", async () => {
    const { database } = await makeDatabase(fx.owner);
    await exec(database.name, "CREATE TABLE f (id INT PRIMARY KEY, v FLOAT)", "INSERT INTO f VALUES (1, 1.0000001), (2, -0e0)");
    const a = (await createCheckpoint(database.id, { trigger: "manual", allowUnchanged: true })).checkpointId!;
    const b = (await createCheckpoint(database.id, { trigger: "manual", allowUnchanged: true })).checkpointId!;
    const hashOf = (id: string) => checkpoints.entries(id).find((e) => e.name === "f")!.objectHash;
    expect(hashOf(b)).toBe(hashOf(a));
    const text = await readObjectText(database.id, hashOf(a));
    expect(text).toContain("(1,1.0000001192092896e0),(2,-0e0)");
  }, T);

  test("invalid and zero dates stored under a permissive sql_mode survive", async () => {
    expectExact(
      await roundTrip(fx, [
        "SET SESSION sql_mode = 'ALLOW_INVALID_DATES'",
        "CREATE TABLE dates (id INT PRIMARY KEY, d DATE NULL, dt DATETIME NULL)",
        "INSERT INTO dates VALUES (1, '2026-02-31', '2026-04-31 10:00:00'), (2, '0000-00-00', '0000-00-00 00:00:00'), (3, '2026-00-15', '2026-13-01 00:00:00')",
      ]),
    );
  }, T);

  test("timestamps across DST, with a literal default, under different session time zones", async () => {
    expectExact(
      await roundTrip(fx, [
        "CREATE TABLE ts (id INT PRIMARY KEY, t TIMESTAMP(6) NULL, d DATETIME(6) NULL, tz_default TIMESTAMP NOT NULL DEFAULT '2026-03-08 07:30:00')",
        "SET SESSION time_zone = '+00:00'",
        "INSERT INTO ts (id, t, d) VALUES (1, '2026-11-01 05:30:00.123456', '2026-11-01 01:30:00'), (2, '2038-01-19 03:14:07.999999', '9999-12-31 23:59:59.999999')",
        "SET SESSION time_zone = 'SYSTEM'",
      ]),
    );
  }, T);

  test("system-versioned tables keep their history, with implicit and explicit period columns", async () => {
    const r = await roundTrip(fx, [
      "CREATE TABLE hist (id INT PRIMARY KEY, v INT) WITH SYSTEM VERSIONING",
      "INSERT INTO hist VALUES (1, 1), (2, 2)",
      "UPDATE hist SET v = v + 10",
      "DELETE FROM hist WHERE id = 2",
      "CREATE TABLE hist2 (id INT PRIMARY KEY, v INT, s TIMESTAMP(6) GENERATED ALWAYS AS ROW START INVISIBLE, e TIMESTAMP(6) GENERATED ALWAYS AS ROW END INVISIBLE, PERIOD FOR SYSTEM_TIME(s, e)) WITH SYSTEM VERSIONING",
      "INSERT INTO hist2 (id, v) VALUES (1, 1)",
      "UPDATE hist2 SET v = 2",
    ]);
    expectExact(r);
    expect(r.limitations).toEqual([]);
    const all = await select<{ n: string }>(r.schema, "SELECT COUNT(*) AS n FROM hist FOR SYSTEM_TIME ALL");
    expect(Number(all[0]!.n)).toBe(4);
  }, T);

  test("sequences and a table defaulting to NEXTVAL", async () => {
    const r = await roundTrip(fx, [
      "CREATE SEQUENCE seq_a START WITH 100 INCREMENT BY 5 CACHE 10 MAXVALUE 130 CYCLE",
      "SELECT NEXTVAL(seq_a), NEXTVAL(seq_a), NEXTVAL(seq_a), NEXTVAL(seq_a), NEXTVAL(seq_a), NEXTVAL(seq_a), NEXTVAL(seq_a), NEXTVAL(seq_a)",
      "CREATE SEQUENCE seq_b NOCACHE",
      "SELECT NEXTVAL(seq_b)",
      "CREATE TABLE uses_seq (id INT NOT NULL DEFAULT NEXTVAL(seq_b) PRIMARY KEY, v INT)",
      "INSERT INTO uses_seq (v) VALUES (1), (2)",
    ]);
    expectExact(r);
    await exec(r.schema, "INSERT INTO uses_seq (v) VALUES (3)");
  }, T);

  test("rows larger than half the packet limit, and text that doubles when escaped", async () => {
    const r = await roundTrip(fx, [
      "CREATE TABLE big (id INT PRIMARY KEY, b LONGBLOB, t LONGTEXT)",
      "INSERT INTO big VALUES (1, REPEAT(0xAB, 9 * 1024 * 1024), REPEAT(CONCAT(CHAR(10), CHAR(39)), 4 * 1024 * 1024))",
    ]);
    expectExact({ ...r, diffs: r.diffs.map((d) => d.slice(0, 200)) });
  }, T);

  test("names with a newline, a leading dash, backticks and the old splitter markers", async () => {
    expectExact(
      await roundTrip(fx, [
        "CREATE TABLE `line\nbreak` (id INT PRIMARY KEY)",
        "INSERT INTO `line\nbreak` VALUES (1)",
        "CREATE TABLE `-archive` (id INT PRIMARY KEY)",
        "INSERT INTO `-archive` VALUES (2)",
        "CREATE TABLE `we``ird` (`c``ol` INT PRIMARY KEY)",
        "CREATE TABLE `Table structure for table ``x``` (id INT PRIMARY KEY)",
        "CREATE TABLE `-- LambData table v2 y` (id INT PRIMARY KEY)",
        "INSERT INTO `we``ird` VALUES (3)",
      ]),
    );
  }, T);

  test("character sets, binary data, spatial, bit, json, enum, set, inet6, uuid and vector-free types", async () => {
    const latin1 = Array.from({ length: 128 }, (_, i) => (i + 128).toString(16).padStart(2, "0")).join("");
    expectExact(
      await roundTrip(fx, [
        "CREATE TABLE cs (id INT PRIMARY KEY, l1 VARCHAR(200) CHARACTER SET latin1, a VARCHAR(20) CHARACTER SET ascii, u16 VARCHAR(50) CHARACTER SET utf16, sj VARCHAR(20) CHARACTER SET sjis, raw VARBINARY(300), e ENUM('a','b','c d'), st SET('x','y','z'), j JSON, i6 INET6, uu UUID, b64 BIT(64), pt POINT NULL, ch CHAR(10), yr YEAR)",
        `INSERT INTO cs VALUES (1, UNHEX('${latin1}'), 'plain', 'Ωmega 中', UNHEX('82A082A2'), UNHEX('${latin1}'), 'c d', 'x,z', '{"a": [1, 2.50, "x\\\\u0000y"]}', '::ffff:192.168.0.1', '123e4567-e89b-12d3-a456-426614174000', b'1010101010101010101010101010101010101010101010101010101010101010', ST_GeomFromText('POINT(1.5 -2.25)'), 'pad  ', 2026)`,
        "SET SESSION sql_mode = ''",
        "INSERT INTO cs (id, l1, raw, e) VALUES (2, 'tab\\there \\\\ quote '' dq \" nul', X'', '')",
      ]),
    );
  }, T);

  test("an Aria table keeps its create options", async () => {
    expectExact(
      await roundTrip(fx, [
        "CREATE TABLE ar (id INT PRIMARY KEY, v TEXT) ENGINE=Aria",
        "CREATE TABLE my (id INT PRIMARY KEY, v TEXT, FULLTEXT KEY (v)) ENGINE=MyISAM",
        "INSERT INTO ar VALUES (1, 'aria')",
        "INSERT INTO my VALUES (1, 'hello world')",
      ]),
    );
  }, T);

  test("the schema's default character set and collation come back", async () => {
    const { database } = await makeDatabase(fx.owner);
    const schema = database.name;
    await rootQuery(`ALTER DATABASE \`${schema}\` CHARACTER SET latin1 COLLATE latin1_swedish_ci`);
    await exec(schema, "CREATE TABLE plain (id INT PRIMARY KEY, s VARCHAR(10))", "INSERT INTO plain VALUES (1, 'é')");
    const before = await fingerprint(schema);
    const cp = (await createCheckpoint(database.id, { trigger: "manual" })).checkpointId!;
    expect(checkpoints.byId(cp)).toMatchObject({ schemaCharset: "latin1", schemaCollation: "latin1_swedish_ci" });
    await rootQuery(`ALTER DATABASE \`${schema}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_bin`);
    const unchanged = await createCheckpoint(database.id, { trigger: "manual" });
    expect(unchanged.unchanged).toBe(false);
    await restoreCheckpoint(database.id, cp, { userId: null });
    expect(diffFingerprints(before, await fingerprint(schema))).toEqual([]);
  }, T);

  test("views on views and cross-schema functions, ordered triggers and events", async () => {
    expectExact(
      await roundTrip(fx, [
        "CREATE TABLE base (id INT PRIMARY KEY, v INT)",
        "INSERT INTO base VALUES (1, 10), (2, 20)",
        "CREATE FUNCTION f_twice(x INT) RETURNS INT DETERMINISTIC RETURN x * 2",
        "CREATE VIEW v1 AS SELECT id, v FROM base",
        "CREATE VIEW v2 AS SELECT id, f_twice(v) AS w FROM v1",
        "CREATE VIEW v5 AS SELECT zz_fid_other.f_ext(v) AS e FROM base",
        "CREATE TRIGGER t_first BEFORE INSERT ON base FOR EACH ROW SET NEW.v = NEW.v + 1",
        "CREATE TRIGGER t_second BEFORE INSERT ON base FOR EACH ROW PRECEDES t_first SET NEW.v = NEW.v * 10",
        "CREATE TRIGGER t_ext AFTER INSERT ON base FOR EACH ROW INSERT INTO zz_fid_other.log (msg) VALUES (CONCAT('base ', NEW.id))",
        "CREATE EVENT ev_off ON SCHEDULE EVERY 1 HOUR STARTS '2030-01-01 00:00:00' ON COMPLETION PRESERVE DISABLE COMMENT 'off' DO DELETE FROM base",
        "CREATE PROCEDURE p_doc()\nBEGIN\n  -- a comment that must survive\n  SELECT 1;\nEND",
      ]),
    );
  }, T);

  test("a view that is invalid when the checkpoint is taken is stated, and does not block anything", async () => {
    const r = await roundTrip(fx, [
      "CREATE TABLE gone (id INT PRIMARY KEY)",
      "CREATE VIEW v_gone AS SELECT id FROM gone",
      "DROP TABLE gone",
      "CREATE TABLE keep (id INT PRIMARY KEY)",
      "INSERT INTO keep VALUES (1)",
    ]);
    expectExact(r);
    expect(r.limitations.some((l) => l.startsWith("view v_gone could not be queried"))).toBe(true);
  }, T);

  test("an empty database and one with only code objects", async () => {
    expectExact(await roundTrip(fx, []));
    expectExact(await roundTrip(fx, ["CREATE VIEW only_v AS SELECT 1 AS one", "CREATE PROCEDURE only_p() SELECT 42"]));
  }, T);
});
