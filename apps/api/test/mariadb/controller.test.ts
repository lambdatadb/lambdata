import { mariadbAvailable, rootQuery, startTestInstance, testTmpRoot, type TestInstance } from "../harness/instance";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { closeSync, mkdirSync, openSync, realpathSync } from "node:fs";
import { join } from "node:path";
import mysql from "mysql2/promise";
import { env } from "../../src/env";
import { findProcesses } from "../../src/util/processes";
import {
  getMariaDbBinariesSync,
  healthCheck,
  mariadbServerPid,
  mariadbState,
  startMariaDb,
  stopMariaDb,
} from "../../src/mariadb/controller";

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

function serverProcessesForDataDir(): string[] {
  return findProcesses(`--datadir=${env.mariadbDataDir}`).map(String);
}

function openLogDescriptors(): number | null {
  if (!Bun.which("lsof")) return null;
  const out = Bun.spawnSync(["lsof", "-p", String(process.pid), "-Fn"]).stdout.toString();
  const log = realpathSync(join(env.logsDir, "mariadb.log"));
  return out.split("\n").filter((l) => l === `n${log}`).length;
}

describe.skipIf(!mariadbAvailable())("mariadb controller supervision", () => {
  let instance: TestInstance | null = null;

  beforeAll(async () => {
    instance = await startTestInstance();
  }, 120_000);

  afterAll(async () => {
    await instance?.stop();
  }, 60_000);

  test("restarts mariadbd after it is killed and the pool works again", async () => {
    const pid = mariadbServerPid();
    expect(pid).not.toBeNull();
    const before = await healthCheck();
    expect(before.ok).toBe(true);
    process.kill(pid!, "SIGKILL");
    await waitFor(() => mariadbState() === "restarting", 5_000, "restarting state");
    const during = await healthCheck();
    expect(during.ok).toBe(false);
    expect(during.error).toContain("exited unexpectedly");
    await waitFor(async () => (await healthCheck()).ok, 60_000, "healthy after restart");
    const after = await healthCheck();
    expect(after.restarts).toBe(before.restarts + 1);
    expect(mariadbServerPid()).not.toBe(pid);
    expect(isAlive(pid!)).toBe(false);
    const rows = await rootQuery<{ v: number }>("SELECT 1 AS v");
    expect(rows).toEqual([{ v: 1 }]);
  }, 90_000);

  test("surfaces repeated restart failures and recovers once the cause is gone", async () => {
    const pid = mariadbServerPid()!;
    process.kill(pid, "SIGKILL");
    await waitFor(() => !isAlive(pid), 5_000, "mariadbd to die");
    let blocker: { stop(closeActiveConnections?: boolean): void } | null = null;
    await waitFor(
      () => {
        try {
          blocker = Bun.listen({ hostname: env.mariadbBind, port: env.mariadbPort, socket: { data() {} } });
          return true;
        } catch {
          return false;
        }
      },
      5_000,
      "port to be free",
    );
    try {
      await waitFor(
        async () => (await healthCheck()).error?.includes("restart attempt(s) failed") ?? false,
        30_000,
        "a failed restart to be reported",
      );
      const h = await healthCheck();
      expect(h.ok).toBe(false);
      expect(h.state).toBe("restarting");
      expect(h.error).toMatch(/Address already in use|Bind on TCP\/IP port|exited during startup/);
    } finally {
      (blocker as { stop(closeActiveConnections?: boolean): void } | null)?.stop(true);
    }
    await waitFor(async () => (await healthCheck()).ok, 60_000, "recovery after the port is released");
    expect(await rootQuery<{ v: number }>("SELECT 1 AS v")).toEqual([{ v: 1 }]);
  }, 120_000);

  test("does not restart after an intentional stop", async () => {
    const pid = mariadbServerPid()!;
    await stopMariaDb();
    expect(isAlive(pid)).toBe(false);
    await Bun.sleep(2_500);
    expect(mariadbServerPid()).toBeNull();
    expect(mariadbState()).toBe("stopped");
    expect(serverProcessesForDataDir()).toEqual([]);
    const h = await healthCheck();
    expect(h.ok).toBe(false);
    await startMariaDb();
    expect((await healthCheck()).ok).toBe(true);
  }, 60_000);

  test("refuses to adopt a different server that already listens on its port", async () => {
    await stopMariaDb();
    const binaries = getMariaDbBinariesSync();
    const foreignDir = join(testTmpRoot(), "foreign", "mariadb");
    mkdirSync(foreignDir, { recursive: true });
    const install = Bun.spawnSync([
      binaries.installDb,
      "--no-defaults",
      `--datadir=${foreignDir}`,
      "--auth-root-authentication-method=normal",
      "--skip-test-db",
    ]);
    expect(install.exitCode).toBe(0);
    const foreign = Bun.spawn(
      [
        binaries.server,
        "--no-defaults",
        `--datadir=${foreignDir}`,
        `--port=${env.mariadbPort}`,
        "--bind-address=127.0.0.1",
        `--socket=${join(foreignDir, "f.sock")}`,
        "--skip-name-resolve",
      ],
      { stdout: "ignore", stderr: "ignore" },
    );
    const foreignRoot = () =>
      mysql.createConnection({ host: "127.0.0.1", port: env.mariadbPort, user: "root", password: "" });
    try {
      await waitFor(
        async () => {
          try {
            await (await foreignRoot()).end();
            return true;
          } catch {
            return false;
          }
        },
        30_000,
        "foreign server",
      );
      await expect(startMariaDb()).rejects.toThrow(/another MariaDB|Address already in use/);
      const conn = await foreignRoot();
      const [rows] = await conn.query("SELECT COUNT(*) AS n FROM mysql.user WHERE User = ?", [env.rootUser]);
      await conn.end();
      expect(Number((rows as { n: number }[])[0]!.n)).toBe(0);
      expect(mariadbServerPid()).toBeNull();
    } finally {
      foreign.kill("SIGKILL");
      await foreign.exited;
    }
    await startMariaDb();
    expect((await healthCheck()).ok).toBe(true);
  }, 120_000);

  test("does not leak the log file descriptor across restarts", async () => {
    const initial = openLogDescriptors();
    if (initial === null) return;
    expect(initial).toBe(0);
    const probe = openSync(join(env.logsDir, "mariadb.log"), "a");
    expect(openLogDescriptors()).toBe(1);
    closeSync(probe);
    for (let i = 0; i < 2; i++) {
      await stopMariaDb();
      await startMariaDb();
    }
    expect(openLogDescriptors()).toBe(0);
  }, 90_000);
});
