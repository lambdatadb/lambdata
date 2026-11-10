import { mariadbAvailable, startTestInstance, testTmpRoot } from "../harness/instance";
import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import mysql from "mysql2/promise";
import { env } from "../../src/env";
import { getRootPassword, healthCheck, socketPathFor } from "../../src/mariadb/controller";

const LIMIT = process.platform === "linux" ? 107 : 103;

describe("socket path", () => {
  test("stays inside a short data dir", () => {
    expect(socketPathFor("/data/mariadb")).toBe("/data/mariadb/mariadb.sock");
  });

  test("falls back to a short temp path derived from a long data dir", () => {
    const long = `/srv/${"very-long-directory-name/".repeat(6)}mariadb`;
    const other = `/srv/${"very-long-directory-name/".repeat(6)}mariadb2`;
    const path = socketPathFor(long);
    expect(path.startsWith(long)).toBe(false);
    expect(Buffer.byteLength(path)).toBeLessThanOrEqual(LIMIT);
    expect(path).toMatch(/lambdata-[0-9a-f]{16}\.sock$/);
    expect(socketPathFor(long)).toBe(path);
    expect(socketPathFor(other)).not.toBe(path);
  });

  test("uses the data dir right up to the limit", () => {
    const base = "/d/";
    const fill = "x".repeat(LIMIT - base.length - "/mariadb.sock".length);
    expect(socketPathFor(`${base}${fill}`)).toBe(`${base}${fill}/mariadb.sock`);
    expect(socketPathFor(`${base}${fill}y`).startsWith(base)).toBe(false);
  });
});

describe.skipIf(!mariadbAvailable())("socket path with a real server", () => {
  test("MariaDB starts from a data dir whose socket path would be too long", async () => {
    const dataDir = join(testTmpRoot(), "socket-".padEnd(110, "x"));
    expect(Buffer.byteLength(join(dataDir, "mariadb", "mariadb.sock"))).toBeGreaterThan(LIMIT);
    const instance = await startTestInstance({ dataDir });
    try {
      expect((await healthCheck()).ok).toBe(true);
      const socketPath = socketPathFor(env.mariadbDataDir);
      expect(socketPath.startsWith(dataDir)).toBe(false);
      expect(existsSync(socketPath)).toBe(true);
      const conn = await mysql.createConnection({ socketPath, user: env.rootUser, password: await getRootPassword() });
      const [rows] = await conn.query("SELECT 1 AS v");
      expect(rows as unknown).toEqual([{ v: 1 }]);
      await conn.end();
    } finally {
      await instance.stop();
    }
    expect(existsSync(dataDir)).toBe(false);
  }, 120_000);
});
