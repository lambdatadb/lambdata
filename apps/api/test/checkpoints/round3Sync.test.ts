import { exec, makeDatabase, mariadbAvailable, rootQuery, select, setup, type Fixture } from "./helpers";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import mysql from "mysql2/promise";
import { checkpoints, syncJobs } from "../../src/db/queries";
import { checkpointSwap } from "../../src/checkpoints/fencedSwap";
import { readObjectText } from "../../src/checkpoints/store";
import { env } from "../../src/env";
import { waitForJob } from "../../src/jobs";
import { getRootPassword } from "../../src/mariadb/controller";
import { encryptSecret } from "../../src/util/crypto";
import { newId } from "../../src/util/id";
import { startSyncJob } from "../../src/workers/sync";

async function configure(mirrorId: string, p: { database: string; user: string; password: string }) {
  syncJobs.upsert({
    id: newId("sj"),
    databaseId: mirrorId,
    sourceKind: "mysql",
    sourceHost: "127.0.0.1",
    sourcePort: env.mariadbPort,
    sourceUser: p.user,
    passwordEnc: await encryptSecret(p.password),
    sourceDatabase: p.database,
    intervalSeconds: 3600,
    enabled: true,
  });
}

async function sync(id: string) {
  return (await waitForJob(startSyncJob(id, null).id))!;
}

describe.skipIf(!mariadbAvailable())("versioned mirror checks, round 3", () => {
  let fx: Fixture;

  beforeAll(async () => {
    fx = await setup();
  }, 180_000);

  afterAll(async () => {
    await fx?.instance.stop();
  }, 120_000);

  async function pair(sourceSetup: string[]) {
    const source = await makeDatabase(fx.owner);
    await exec(source.database.name, ...sourceSetup);
    const mirror = await makeDatabase(fx.owner, { kind: "mirror", versioned: true });
    await configure(mirror.database.id, { database: source.database.name, user: source.credentials.user, password: source.credentials.password });
    const first = await sync(mirror.database.id);
    if (first.status !== "succeeded") throw new Error(`first sync failed: ${first.error}`);
    return { source, mirror };
  }

  test("a local change to only the AUTO_INCREMENT counter is saved before the sync", async () => {
    const { source, mirror } = await pair([
      "CREATE TABLE items (id INT AUTO_INCREMENT PRIMARY KEY, v VARCHAR(20))",
      "INSERT INTO items (v) VALUES ('a'), ('b')",
    ]);
    await exec(source.database.name, "INSERT INTO items (v) VALUES ('c')");
    await exec(mirror.database.name, "INSERT INTO items (v) VALUES ('tmp')", "DELETE FROM items WHERE v = 'tmp'", "ALTER TABLE items AUTO_INCREMENT = 5000");
    const job = await sync(mirror.database.id);
    expect(job.status).toBe("succeeded");
    const pre = (job.result as { preSyncCheckpointId: string | null }).preSyncCheckpointId;
    expect(pre).not.toBeNull();
    expect(checkpoints.entries(pre!).find((e) => e.name === "items")!.autoIncrement).toBe(5000);
  }, 240_000);

  test("a write that lands while the check is scanning later tables ends up in a checkpoint", async () => {
    const { source, mirror } = await pair([
      "CREATE TABLE a_small (id INT AUTO_INCREMENT PRIMARY KEY, v VARCHAR(20))",
      "INSERT INTO a_small (v) VALUES ('seed')",
      "CREATE TABLE m_big (id INT PRIMARY KEY, pad VARCHAR(200))",
      "INSERT INTO m_big SELECT seq, REPEAT('x', 190) FROM seq_1_to_600000",
    ]);
    await exec(source.database.name, "INSERT INTO a_small (v) VALUES ('from source')");
    const own = await mysql.createConnection({
      host: "127.0.0.1",
      port: env.mariadbPort,
      user: mirror.credentials.user,
      password: mirror.credentials.password,
      database: mirror.database.name,
    });
    own.on("error", () => {});
    const watcher = await mysql.createConnection({ host: "127.0.0.1", port: env.mariadbPort, user: env.rootUser, password: await getRootPassword() });
    const jobRef = startSyncJob(mirror.database.id, null);
    let wrote = false;
    const started = Date.now();
    while (Date.now() - started < 120_000) {
      const [rows] = (await watcher.query("SELECT ID FROM information_schema.PROCESSLIST WHERE INFO LIKE ? AND INFO NOT LIKE '%PROCESSLIST%'", [
        `CHECKSUM TABLE \`${mirror.database.name}\`.\`m_big\`%`,
      ])) as [unknown[], unknown];
      if (rows.length > 0) {
        await own.query("INSERT INTO a_small (v) VALUES ('app-during-check')");
        wrote = true;
        break;
      }
      await Bun.sleep(3);
    }
    const job = (await waitForJob(jobRef.id))!;
    await own.end().catch(() => {});
    await watcher.end();
    expect(wrote).toBe(true);
    expect(job.status).toBe("succeeded");
    expect(job.warnings.some((w) => w.startsWith("The mirror was written to while it was being checked (a_small)"))).toBe(true);
    const pre = (job.result as { preSyncCheckpointId: string | null }).preSyncCheckpointId;
    expect(pre).not.toBeNull();
    const entry = checkpoints.entries(pre!).find((e) => e.name === "a_small")!;
    expect(await readObjectText(mirror.database.id, entry.objectHash)).toContain("app-during-check");
    expect(await select(mirror.database.name, "SELECT COUNT(*) AS n FROM a_small WHERE v = 'from source'")).toEqual([{ n: "1" }]);
  }, 300_000);

  test("a clean mirror is synced without closing its connections", async () => {
    const { source, mirror } = await pair(["CREATE TABLE t (id INT PRIMARY KEY)", "INSERT INTO t VALUES (1)"]);
    await exec(source.database.name, "INSERT INTO t VALUES (2)");
    const reader = await mysql.createConnection({
      host: "127.0.0.1",
      port: env.mariadbPort,
      user: mirror.credentials.user,
      password: mirror.credentials.password,
      database: mirror.database.name,
    });
    const job = await sync(mirror.database.id);
    expect(job.status).toBe("succeeded");
    expect((job.result as { preSyncCheckpointId: string | null }).preSyncCheckpointId).toBeNull();
    await reader.query("SELECT 1");
    await reader.end();
    expect(await rootQuery(`SELECT COUNT(*) AS n FROM \`${mirror.database.name}\`.t`)).toEqual([{ n: 2 }]);
  }, 240_000);

  test("a mirror that is not versioned, or has checkpoint on sync off, swaps without the local-change check", async () => {
    const realRun = checkpointSwap.run;
    const checked: boolean[] = [];
    checkpointSwap.run = (opts) => {
      checked.push(opts.expectLive !== undefined);
      return realRun(opts);
    };
    try {
      const source = await makeDatabase(fx.owner);
      await exec(source.database.name, "CREATE TABLE t (id INT PRIMARY KEY)", "INSERT INTO t VALUES (1)");
      const plain = await makeDatabase(fx.owner, { kind: "mirror" });
      await configure(plain.database.id, { database: source.database.name, user: source.credentials.user, password: source.credentials.password });
      expect((await sync(plain.database.id)).status).toBe("succeeded");
      expect((await sync(plain.database.id)).status).toBe("succeeded");
      expect(checked).toEqual([false, false]);
      const { mirror } = await pair(["CREATE TABLE t (id INT PRIMARY KEY)", "INSERT INTO t VALUES (1)"]);
      checked.length = 0;
      checkpoints.setPolicy(mirror.database.id, { ...checkpoints.policy(mirror.database.id), checkpointOnSync: false });
      await exec(mirror.database.name, "INSERT INTO t VALUES (99)");
      const off = await sync(mirror.database.id);
      expect(off.status).toBe("succeeded");
      expect((off.result as { preSyncCheckpointId: string | null }).preSyncCheckpointId).toBeNull();
      expect(checked).toEqual([false]);
    } finally {
      checkpointSwap.run = realRun;
    }
  }, 240_000);
});
