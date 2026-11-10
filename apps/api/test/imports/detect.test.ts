import "../harness/instance";
import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { detectFormat, UnsupportedFileError } from "../../src/imports/detect";
import { DumpRejectedError, DumpRewriter } from "../../src/imports/dumpRewrite";
import { NameAllocator } from "../../src/imports/identifiers";
import { doubleLiteral, plainDecimal } from "../../src/imports/literals";
import { buildSqlite, fixtureDir } from "./helpers";

const enc = new TextEncoder();

async function detectBytes(bytes: Uint8Array) {
  const path = join(fixtureDir(), "upload.bin");
  writeFileSync(path, bytes);
  return detectFormat(bytes.subarray(0, 256 * 1024), path);
}

async function rejection(bytes: Uint8Array): Promise<string> {
  try {
    await detectBytes(bytes);
  } catch (err) {
    expect(err).toBeInstanceOf(UnsupportedFileError);
    return (err as Error).message;
  }
  throw new Error("expected the file to be rejected");
}

function rewrite(sql: string, chunkSize?: number): string {
  const r = new DumpRewriter();
  const bytes = enc.encode(sql);
  const out: Uint8Array[] = [];
  if (!chunkSize) out.push(...r.push(bytes));
  else for (let i = 0; i < bytes.length; i += chunkSize) out.push(...r.push(bytes.subarray(i, i + chunkSize)));
  out.push(...r.finish());
  return Buffer.concat(out.map((b) => Buffer.from(b))).toString("utf8");
}

describe("format detection", () => {
  test("recognises SQLite by its header, not its name", async () => {
    const path = buildSqlite((db) => db.exec("CREATE TABLE t (a)"), "not-a-db.txt");
    const bytes = new Uint8Array(await Bun.file(path).arrayBuffer());
    expect(await detectBytes(bytes)).toEqual({ format: "sqlite", compressed: false });
  });

  test("accepts MySQL and MariaDB dumps, plain and gzipped", async () => {
    const dump = enc.encode("-- MariaDB dump 10.19\n/*!40101 SET NAMES utf8mb4 */;\nCREATE TABLE `t` (`a` int);\n");
    expect(await detectBytes(dump)).toEqual({ format: "sql", compressed: false });
    expect(await detectBytes(new Uint8Array(gzipSync(dump)))).toEqual({ format: "sql", compressed: true });
    expect(await detectBytes(enc.encode("﻿INSERT INTO t VALUES (1);"))).toEqual({ format: "sql", compressed: false });
  });

  test("names what it found when it is something else", async () => {
    const access = new Uint8Array(64);
    access.set(enc.encode("Standard Jet DB"), 4);
    expect(await rejection(access)).toMatch(/^This looks like a Microsoft Access database; only SQLite/);
    expect(await rejection(enc.encode("--\n-- PostgreSQL database dump\n--\nSET statement_timeout = 0;\n"))).toMatch(/PostgreSQL dump/);
    expect(await rejection(enc.encode("PGDMP\u0001\u000e\u0000"))).toMatch(/PostgreSQL custom-format/);
    expect(await rejection(enc.encode("PRAGMA foreign_keys=OFF;\nBEGIN TRANSACTION;\nCREATE TABLE t(a);\n"))).toMatch(/SQLite text dump/);
    expect(await rejection(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3]))).toMatch(/ZIP archive/);
    expect(await rejection(enc.encode("name,steamid,points\nbob,7656,3\n"))).toMatch(/CSV/);
    expect(await rejection(new Uint8Array([0xff, 0xfe, 0x53, 0x00, 0x45, 0x00]))).toMatch(/UTF-16/);
    const random = new Uint8Array(4096);
    crypto.getRandomValues(random);
    random[10] = 0;
    expect(await rejection(random)).toMatch(/not a SQLite 3 database/);
    const sqliteGz = new Uint8Array(gzipSync(enc.encode("SQLite format 3\u0000rest")));
    expect(await rejection(sqliteGz)).toMatch(/gzip-compressed SQLite database/);
  });
});

describe("dump rewriter", () => {
  test("drops the dump's own CREATE DATABASE and USE so it loads into the target", () => {
    const out = rewrite(
      "CREATE DATABASE /*!32312 IF NOT EXISTS*/ `shop` /*!40100 DEFAULT CHARACTER SET utf8mb4 */;\n\nUSE `shop`;\nCREATE TABLE t (a int);\n/*!40000 DROP DATABASE IF EXISTS `shop`*/;\nINSERT INTO t VALUES (1);\n",
    );
    expect(out).not.toMatch(/CREATE DATABASE|USE `shop`|DROP DATABASE/);
    expect(out).toContain("CREATE TABLE t (a int);");
    expect(out).toContain("INSERT INTO t VALUES (1);");
    expect(out.split("\n").length).toBe(7);
  });

  test("refuses a dump that switches to a second database", () => {
    expect(() => rewrite("USE `a`;\nCREATE TABLE t (x int);\nUSE `b`;\n")).toThrow(DumpRejectedError);
  });

  test("rewrites DEFINER clauses but never text inside string literals", () => {
    const sql =
      "/*!50013 DEFINER=`ld_old`@`%` SQL SECURITY DEFINER */\n/*!50001 VIEW `v` AS select 1 AS `a` */;\n" +
      "INSERT INTO notes VALUES ('DEFINER=`x`@`y` stays', 'it''s \\' DEFINER=`q`@`w`');\n" +
      "CREATE DEFINER='root'@'localhost' PROCEDURE p() SELECT 1;\n/*!50017 DEFINER=root@localhost*/\n";
    const out = rewrite(sql);
    expect(out).toContain("/*!50013 DEFINER=CURRENT_USER SQL SECURITY DEFINER */");
    expect(out).toContain("CREATE DEFINER=CURRENT_USER PROCEDURE");
    expect(out).toContain("/*!50017 DEFINER=CURRENT_USER*/");
    expect(out).toContain("'DEFINER=`x`@`y` stays'");
    expect(out).toContain("DEFINER=`q`@`w`");
  });

  test("gives identical output however the stream is chunked", () => {
    const rows = Array.from({ length: 3000 }, (_, i) => `(${i},'v''al\\'ue ${i} DEFINER=\`a\`@\`b\`;USE x;')`).join(",");
    const sql = `USE \`own\`;\nDELIMITER ;;\nCREATE DEFINER=\`u\`@\`%\` TRIGGER tr BEFORE INSERT ON t FOR EACH ROW BEGIN SET NEW.a = 1; END ;;\nDELIMITER ;\nINSERT INTO t VALUES ${rows};\nINSERT INTO t VALUES ${rows};\n`.repeat(8);
    const whole = rewrite(sql);
    expect(rewrite(sql, 7)).toBe(whole);
    expect(rewrite(sql, 65_537)).toBe(whole);
    expect(whole).not.toContain("USE `own`");
    expect(whole).toContain("CREATE DEFINER=CURRENT_USER TRIGGER");
    expect(whole).toContain("DEFINER=`a`@`b`;USE x;");
  });

  test("strips replication settings that need server-wide privileges", () => {
    const out = rewrite("SET @@SESSION.SQL_LOG_BIN= 0;\nSET @@GLOBAL.GTID_PURGED=/*!80000 '+'*/ 'abc:1-5';\nSET @x = 1;\n");
    expect(out).not.toMatch(/SQL_LOG_BIN|GTID_PURGED/);
    expect(out).toContain("SET @x = 1;");
  });
});

describe("identifiers and literals", () => {
  test("renames deterministically and records why", () => {
    const a = new NameAllocator();
    const long = "x".repeat(70);
    const first = a.allocate(long, "table");
    expect(first.targetName.length).toBe(64);
    expect(new NameAllocator().allocate(long, "table").targetName).toBe(first.targetName);
    expect(a.allocate("café", "c").targetName).toBe("café");
    const clash = a.allocate("cafe", "c");
    expect(clash.targetName).toBe("cafe_2");
    expect(clash.reason).toMatch(/collides/);
    expect(a.allocate("score ", "c").targetName).toBe("score");
    expect(a.allocate("a\u0001b", "c").targetName).toBe("a_b");
  });

  test("number literals round-trip exactly", () => {
    for (const x of [0.1, 1 / 3, 1e-300, 123456789.123, -2.5e21, 5e-324, Number.MAX_VALUE]) {
      expect(Number(doubleLiteral(x))).toBe(x);
    }
    expect(doubleLiteral(-0)).toBe("-0e0");
    expect(plainDecimal(1.5)).toBe("1.5");
    expect(plainDecimal(1e-7)).toBe("0.0000001");
    expect(plainDecimal(-12.25)).toBe("-12.25");
    expect(plainDecimal(1e21)).toBe("1000000000000000000000");
  });
});
