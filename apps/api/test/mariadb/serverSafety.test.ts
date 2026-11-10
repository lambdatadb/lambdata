import { createTestDatabase, mariadbAvailable, rootQuery, startTestInstance, type TestInstance } from "../harness/instance";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Hono } from "hono";
import mysql from "mysql2/promise";
import { env } from "../../src/env";
import {
  getMariaDbBinariesSync,
  getRootPassword,
  healthCheck,
  localConnectHost,
  mariadbServerPid,
  secureFileDir,
  serverArgs,
  startMariaDb,
  stopMariaDb,
} from "../../src/mariadb/controller";
import { localAdminTarget, runSql } from "../../src/mariadb/process";
import { readUpgradeMarker, upgradeDataDirIfNeeded } from "../../src/mariadb/upgrade";
import { healthRoute } from "../../src/routes/health";

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(check: () => Promise<boolean> | boolean, timeoutMs: number, label: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await Bun.sleep(100);
  }
  throw new Error(`timed out waiting for ${label}`);
}

async function serverVersion(): Promise<string> {
  const [row] = await rootQuery<{ v: string }>("SELECT VERSION() AS v");
  return row!.v;
}

describe.skipIf(!mariadbAvailable())("mariadb server safety", () => {
  let instance: TestInstance | null = null;

  beforeAll(async () => {
    instance = await startTestInstance();
  }, 120_000);

  afterAll(async () => {
    await instance?.stop();
  }, 60_000);

  test("mariadbd accepts large rows and cannot read or write files outside an empty folder", async () => {
    const [vars] = await rootQuery<{ p: number; li: number; s: string }>(
      "SELECT @@GLOBAL.max_allowed_packet AS p, @@GLOBAL.local_infile AS li, @@GLOBAL.secure_file_priv AS s",
    );
    expect(Number(vars!.p)).toBe(1024 * 1024 * 1024);
    expect(Number(vars!.li)).toBe(0);
    expect(realpathSync(String(vars!.s).replace(/\/$/, ""))).toBe(realpathSync(secureFileDir()));
    const [file] = await rootQuery<{ f: unknown }>("SELECT LOAD_FILE(?) AS f", [env.masterKeyPath]);
    expect(file!.f).toBeNull();
    await expect(rootQuery("SELECT 1 INTO OUTFILE ?", [join(env.dataDir, "leak.txt")])).rejects.toThrow(/secure-file-priv/);
    expect(existsSync(join(env.dataDir, "leak.txt"))).toBe(false);

    const db = await createTestDatabase();
    await rootQuery(`CREATE TABLE \`${db.schema}\`.blobs (id INT PRIMARY KEY, b LONGBLOB)`);
    const hex = "ab".repeat(20 * 1024 * 1024);
    await runSql(await localAdminTarget(), db.schema, `INSERT INTO blobs VALUES (1, x'${hex}');\n`);
    const [len] = await rootQuery<{ n: number }>(`SELECT LENGTH(b) AS n FROM \`${db.schema}\`.blobs`);
    expect(Number(len!.n)).toBe(20 * 1024 * 1024);
  }, 120_000);

  test("a data directory last used by an older server is upgraded, and a current one is left alone", async () => {
    const version = await serverVersion();
    for (const name of ["mariadb_upgrade_info", "mysql_upgrade_info"]) rmSync(join(env.mariadbDataDir, name), { force: true });
    writeFileSync(join(env.mariadbDataDir, "mariadb_upgrade_info"), "10.11.6-MariaDB");
    const p = {
      bin: getMariaDbBinariesSync().upgrade,
      datadir: env.mariadbDataDir,
      serverVersion: version,
      host: localConnectHost(),
      port: env.mariadbPort,
      user: env.rootUser,
      password: await getRootPassword(),
    };
    const first = await upgradeDataDirIfNeeded(p);
    expect(first.ran).toBe(true);
    expect(first.from).toBe("10.11.6");
    expect(readUpgradeMarker(env.mariadbDataDir)).toContain(/^(\d+\.\d+\.\d+)/.exec(version)![1]!);
    expect(first.summary).not.toContain(p.password);
    const second = await upgradeDataDirIfNeeded(p);
    expect(second.ran).toBe(false);
    expect(second.summary).toBe("data directory is current");

    writeFileSync(join(env.mariadbDataDir, "mariadb_upgrade_info"), "99.1.0-MariaDB");
    const newer = await upgradeDataDirIfNeeded(p);
    expect(newer.ran).toBe(false);
    expect(newer.summary).toContain("newer than this server");
    expect(readFileSync(join(env.mariadbDataDir, "mariadb_upgrade_info"), "utf8")).toBe("99.1.0-MariaDB");
    writeFileSync(join(env.mariadbDataDir, "mariadb_upgrade_info"), version);
  }, 300_000);

  test("a server left running by a killed LambData process is stopped and replaced at the next start", async () => {
    await stopMariaDb();
    const orphan = Bun.spawn(serverArgs(getMariaDbBinariesSync()), { stdout: "ignore", stderr: "ignore" });
    try {
      const password = await getRootPassword();
      await waitFor(
        async () => {
          try {
            const c = await mysql.createConnection({ host: "127.0.0.1", port: env.mariadbPort, user: env.rootUser, password });
            await c.end();
            return true;
          } catch {
            return false;
          }
        },
        60_000,
        "the orphaned server",
      );
      await startMariaDb();
      expect(isAlive(orphan.pid)).toBe(false);
      expect(mariadbServerPid()).not.toBe(orphan.pid);
      expect((await healthCheck()).ok).toBe(true);
    } finally {
      if (isAlive(orphan.pid)) orphan.kill("SIGKILL");
      await orphan.exited;
    }
  }, 180_000);

  test("/api/health follows MariaDB, and a failed start keeps retrying until it works", async () => {
    const app = new Hono().route("/api/health", healthRoute);
    expect((await app.request("/api/health")).status).toBe(200);
    await stopMariaDb();
    expect((await app.request("/api/health")).status).toBe(200);
    let blocker: { stop(closeActiveConnections?: boolean): void } | null = null;
    blocker = Bun.listen({ hostname: env.mariadbBind, port: env.mariadbPort, socket: { data() {} } });
    try {
      await expect(startMariaDb()).rejects.toThrow();
      const down = await app.request("/api/health");
      expect(down.status).toBe(503);
      expect(await down.json()).toEqual({ ok: false, mariadb: "restarting" });
      const h = await healthCheck();
      expect(h.error).toContain("failed to start");
    } finally {
      blocker.stop(true);
    }
    await waitFor(async () => (await app.request("/api/health")).status === 200, 60_000, "a retried start");
    expect(await rootQuery<{ v: number }>("SELECT 1 AS v")).toEqual([{ v: 1 }]);
  }, 120_000);
});
