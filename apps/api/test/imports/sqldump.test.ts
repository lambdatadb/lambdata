import { createTestDatabase, mariadbAvailable, rootQuery, startTestInstance, type TestInstance } from "../harness/instance";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { loadSqlDumpIntoSchema } from "../../src/imports/sqlLoad";
import { fixtureDir, mariaQuery } from "./helpers";

const available = mariadbAvailable();
const T = 120_000;

function dumpFile(sql: string, gzip = false): string {
  const path = join(fixtureDir(), gzip ? "dump.sql.gz" : "dump.sql");
  writeFileSync(path, gzip ? gzipSync(sql) : sql);
  return path;
}

async function load(sql: string, schema: string, gzip = false) {
  const path = dumpFile(sql, gzip);
  const warnings: string[] = [];
  return loadSqlDumpIntoSchema({
    path,
    compressed: gzip,
    sizeBytes: Bun.file(path).size,
    schema,
    reporter: { stage() {}, progress() {}, warn: (m) => warnings.push(m) },
  });
}

async function importAccounts(): Promise<number> {
  const rows = await rootQuery<{ n: number }>("SELECT COUNT(*) AS n FROM mysql.user WHERE User LIKE 'ld\\_imp\\_%'");
  return Number(rows[0]?.n ?? 0);
}

describe.skipIf(!available)("SQL dump loading", () => {
  let instance: TestInstance;
  let victim: string;

  beforeAll(async () => {
    instance = await startTestInstance();
    victim = (await createTestDatabase()).schema;
    await mariaQuery(victim, "CREATE TABLE t (id BIGINT PRIMARY KEY, secret VARCHAR(20))");
    await mariaQuery(victim, "INSERT INTO t VALUES (76561198000000001, 'keep-me')");
  }, T);

  afterAll(async () => {
    await instance?.stop();
  }, T);

  test("loads a dump with its own CREATE DATABASE/USE, big integers and binary data into the target only", async () => {
    const { schema } = await createTestDatabase();
    const sql = [
      "/*M!999999\\- enable the sandbox mode */ ",
      "-- MariaDB dump 10.19",
      "/*!40101 SET NAMES utf8mb4 */;",
      "SET @@SESSION.SQL_LOG_BIN= 0;",
      "CREATE DATABASE /*!32312 IF NOT EXISTS*/ `original_shop` /*!40100 DEFAULT CHARACTER SET utf8mb4 */;",
      "USE `original_shop`;",
      "CREATE TABLE `players` (`steamid` bigint NOT NULL, `name` varchar(32) NOT NULL, `blob` varbinary(8), PRIMARY KEY (`steamid`));",
      "LOCK TABLES `players` WRITE;",
      "INSERT INTO `players` VALUES (76561198000000001,'it\\'s me',0x00FF),(76561198000000002,'ünïcode','');",
      "UNLOCK TABLES;",
      "",
    ].join("\n");
    await load(sql, schema, true);
    const rows = await mariaQuery<{ s: string; name: string; b: string }>(
      schema,
      "SELECT CAST(steamid AS CHAR) AS s, name, HEX(`blob`) AS b FROM players ORDER BY steamid",
    );
    expect(rows).toEqual([
      { s: "76561198000000001", name: "it's me", b: "00FF" },
      { s: "76561198000000002", name: "ünïcode", b: "" },
    ]);
    expect(await rootQuery("SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = 'original_shop'")).toEqual([]);
    expect(await importAccounts()).toBe(0);
  }, T);

  const marker = () => join(fixtureDir(), "pwned");

  const hostile: [string, (file: string) => string, RegExp | "neutralised"][] = [
    ["drops another database", () => "CREATE TABLE ok (id INT);\nDROP DATABASE `VICTIM`;\nCREATE TABLE after_drop (id INT);\n", "neutralised"],
    ["drops its own target database by name", () => "CREATE TABLE ok (id INT);\nDROP DATABASE `TARGET`;\nCREATE TABLE after_drop (id INT);\n", "neutralised"],
    ["drops another database after naming its own", () => "USE `own_name`;\nDROP DATABASE `VICTIM`;\n", /second database/],
    ["drops a table in another database", () => "DROP TABLE `VICTIM`.`t`;\n", /outside its own database/],
    ["writes into another database", () => "INSERT INTO `VICTIM`.`t` VALUES (1, 'x');\n", /outside its own database/],
    ["copies another database out", () => "CREATE TABLE stolen AS SELECT * FROM `VICTIM`.`t`;\n", /outside its own database/],
    ["renames a table out of another database", () => "RENAME TABLE `VICTIM`.`t` TO stolen;\n", /outside its own database/],
    ["grants itself everything", () => "GRANT ALL PRIVILEGES ON *.* TO 'attacker'@'%' IDENTIFIED BY 'pw';\n", /outside its own database/],
    ["creates a user", () => "CREATE USER 'attacker'@'%' IDENTIFIED BY 'pw';\n", /outside its own database/],
    ["changes a global setting", () => "SET GLOBAL max_connections = 1;\n", /outside its own database/],
    ["creates two databases", () => "CREATE DATABASE evil_one;\nCREATE DATABASE evil_two;\n", /second database/],
    ["switches to a second database", () => "USE `own_name`;\nCREATE TABLE a (x INT);\nUSE `VICTIM`;\nDROP TABLE t;\n", /second database/],
    ["reads a server file", () => "CREATE TABLE f (l TEXT);\nLOAD DATA INFILE '/etc/hosts' INTO TABLE f;\n", /outside its own database|denied/i],
    ["reads a client file", () => "CREATE TABLE f (l TEXT);\nLOAD DATA LOCAL INFILE '/etc/hosts' INTO TABLE f;\n", /local infile|not allowed/i],
    ["writes a server file", () => "SELECT 1 INTO OUTFILE '/tmp/ld-import-outfile-test';\n", /outside its own database|denied/i],
    ["runs a shell command with \\!", (f) => `SELECT 1;\n\\! touch ${f}\n`, /syntax|error/i],
    ["runs a shell command with system", (f) => `SELECT 1;\nsystem touch ${f}\n`, /syntax|error/i],
    ["reads a local file with source", () => "SELECT 1;\nsource /etc/hosts\n", /syntax|error/i],
    ["sets a trigger definer to root", () => "CREATE TABLE z (a INT);\nCREATE DEFINER=`root`@`localhost` TRIGGER tz BEFORE INSERT ON z FOR EACH ROW SET NEW.a = (SELECT COUNT(*) FROM `VICTIM`.`t`);\nINSERT INTO z VALUES (1);\n", /outside its own database/],
  ];

  for (const [label, build, expected] of hostile) {
    test(`a hostile dump that ${label} ${expected === "neutralised" ? "is neutralised" : "fails"} and touches nothing outside its database`, async () => {
      const { schema } = await createTestDatabase();
      const file = marker();
      const usersBefore = await rootQuery<{ n: number }>("SELECT COUNT(*) AS n FROM mysql.user");
      const sql = build(file).replaceAll("VICTIM", victim).replaceAll("TARGET", schema);
      let error: unknown = null;
      try {
        await load(sql, schema);
      } catch (err) {
        error = err;
      }
      if (expected === "neutralised") {
        expect(error).toBeNull();
        const tables = await rootQuery<{ TABLE_NAME: string }>(
          "SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME",
          [schema],
        );
        expect(tables.map((t) => t.TABLE_NAME)).toEqual(["after_drop", "ok"]);
      } else {
        expect(error).toBeInstanceOf(Error);
        expect(String((error as Error).message)).toMatch(expected);
        expect(String((error as Error).message)).not.toContain("ld_imp_");
      }
      expect(await mariaQuery(victim, "SELECT CAST(id AS CHAR) AS id, secret FROM t")).toEqual([{ id: "76561198000000001", secret: "keep-me" }]);
      expect(await rootQuery("SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE SCHEMA_NAME LIKE 'evil%'")).toEqual([]);
      expect(await rootQuery("SELECT User FROM mysql.user WHERE User = 'attacker'")).toEqual([]);
      const usersAfter = await rootQuery<{ n: number }>("SELECT COUNT(*) AS n FROM mysql.user");
      expect(Number(usersAfter[0]!.n)).toBe(Number(usersBefore[0]!.n));
      expect(await importAccounts()).toBe(0);
      expect(existsSync(file)).toBe(false);
      expect(existsSync("/tmp/ld-import-outfile-test")).toBe(false);
      const vars = await rootQuery<{ v: number }>("SELECT @@GLOBAL.max_connections AS v");
      expect(Number(vars[0]!.v)).toBeGreaterThan(1);
    }, T);
  }
});
