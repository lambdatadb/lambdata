import { exec, makeDatabase, mariadbAvailable, rootQuery, select, setup, type Fixture } from "./helpers";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import mysql from "mysql2/promise";
import { createCheckpoint, restoreCheckpoint } from "../../src/checkpoints";
import { checkpointSwap } from "../../src/checkpoints/fencedSwap";
import { verifyCheckpointStore } from "../../src/checkpoints/manage";
import { checkpoints, databases, jobs } from "../../src/db/queries";
import { env } from "../../src/env";
import { getJob, recoverInterruptedJobs, startJob, SWAP_DONE_KEY, waitForJob } from "../../src/jobs";
import { getMariaDbBinariesSync, getRootPassword, mariadbState } from "../../src/mariadb/controller";
import { recoverInterruptedSwaps, type SwapOptions } from "../../src/mariadb/schemaSwap";
import { isWriteFenced } from "../../src/mariadb/writeFence";
import { findProcesses } from "../../src/util/processes";

const T = 240_000;
const realRun = checkpointSwap.run;

function clientWrite(user: string, password: string, schema: string, sql: string): { exit: number; err: string } {
  const p = Bun.spawnSync(
    [getMariaDbBinariesSync().client, "--no-defaults", "--protocol=TCP", "--host=127.0.0.1", `--port=${env.mariadbPort}`, `--user=${user}`, "--skip-ssl", `--database=${schema}`, "-e", sql],
    { env: { PATH: process.env.PATH ?? "", MYSQL_PWD: password } },
  );
  return { exit: p.exitCode ?? -1, err: new TextDecoder().decode(p.stderr).trim() };
}

async function lockedHosts(user: string): Promise<string[] | null> {
  try {
    const rows = await rootQuery<{ h: string; l: string | null }>("SELECT Host AS h, JSON_VALUE(Priv, '$.account_locked') AS l FROM mysql.global_priv WHERE User = ?", [user]);
    return rows.filter((r) => r.l === "1" || r.l === "true").map((r) => r.h);
  } catch {
    return null;
  }
}

async function mariadbAnswers(): Promise<boolean> {
  if (mariadbState() !== "running") return false;
  try {
    await rootQuery("SELECT 1");
    return true;
  } catch {
    return false;
  }
}

async function until(check: () => Promise<boolean> | boolean, ms: number): Promise<boolean> {
  const started = Date.now();
  while (Date.now() - started < ms) {
    if (await check()) return true;
    await Bun.sleep(200);
  }
  return check();
}

function beforeEachSwap(fn: (opts: SwapOptions, attempt: number) => Promise<void> | void): void {
  let attempt = 0;
  checkpointSwap.run = async (opts) => {
    await fn(opts, attempt++);
    return realRun(opts);
  };
}

describe.skipIf(!mariadbAvailable())("fenced rollbacks, round 3", () => {
  let fx: Fixture;

  beforeAll(async () => {
    fx = await setup();
    await rootQuery("CREATE USER IF NOT EXISTS 'ld_test_extra'@'%' IDENTIFIED BY 'Extra-pass-1234'");
  }, 180_000);

  afterAll(async () => {
    checkpointSwap.run = realRun;
    await rootQuery("DROP USER IF EXISTS 'ld_test_extra'@'%'").catch(() => {});
    await fx?.instance.stop();
  }, 120_000);

  async function orders() {
    const { database, credentials } = await makeDatabase(fx.owner);
    const s = database.name;
    await exec(s, "CREATE TABLE orders (id INT PRIMARY KEY, note VARCHAR(40))", "INSERT INTO orders VALUES (1, 'old')");
    const target = (await createCheckpoint(database.id, { trigger: "manual" })).checkpointId!;
    await exec(s, "INSERT INTO orders VALUES (2, 'kept by safety')");
    await rootQuery(`GRANT ALL PRIVILEGES ON \`${s}\`.* TO 'ld_test_extra'@'%'`);
    return { database, credentials, s, target };
  }

  const ids = async (s: string) => (await select<{ id: number }>(s, "SELECT id FROM orders ORDER BY id")).map((r) => Number(r.id));

  for (const how of ["kill-connection", "kill-mariadbd"] as const) {
    test(`a rollback whose safety capture is cut off by ${how} ends and reopens the database`, async () => {
      const { database, credentials } = await makeDatabase(fx.owner);
      const s = database.name;
      await exec(s, "CREATE TABLE z (id INT PRIMARY KEY, pad VARCHAR(200))", "INSERT INTO z SELECT seq, REPEAT('p', 150) FROM seq_1_to_400000");
      const target = (await createCheckpoint(database.id, { trigger: "manual" })).checkpointId!;
      await exec(s, "INSERT INTO z VALUES (0, 'after')");
      let safetyStage = false;
      const job = startJob({ kind: "checkpoint.restore", databaseId: database.id, userId: null }, (ctx) =>
        restoreCheckpoint(database.id, target, {
          userId: null,
          hooks: {
            jobId: ctx.jobId,
            stage: (l: string) => {
              ctx.stage(l);
              if (l.startsWith("Saving a safety")) safetyStage = true;
            },
            progress: (f) => ctx.progress(f),
            warn: (m) => ctx.warn(m),
          },
        }),
      );
      const w = await mysql.createConnection({ host: "127.0.0.1", port: env.mariadbPort, user: env.rootUser, password: await getRootPassword() });
      let acted = false;
      const started = Date.now();
      while (Date.now() - started < 90_000 && !acted) {
        if (safetyStage) {
          const [rows] = (await w.query("SELECT ID FROM information_schema.PROCESSLIST WHERE INFO LIKE ? AND INFO NOT LIKE '%PROCESSLIST%'", [
            `SELECT % FROM \`${s}\`.\`z\`%`,
          ])) as [{ ID: number }[], unknown];
          if (rows.length > 0) {
            if (how === "kill-connection") await w.query(`KILL CONNECTION ${Number(rows[0]!.ID)}`);
            else {
              const pids = findProcesses(`datadir=${env.mariadbDataDir}`);
              expect(pids.length).toBeGreaterThan(0);
              for (const pid of pids) process.kill(pid, "SIGKILL");
            }
            acted = true;
          }
        }
        await Bun.sleep(2);
      }
      await w.end().catch(() => {});
      expect(acted).toBe(true);
      expect(await until(() => getJob(job.id)?.status === "failed", 90_000)).toBe(true);
      expect(await until(mariadbAnswers, 120_000)).toBe(true);
      expect(getJob(job.id)!.error).toMatch(/connection to MariaDB was lost|MariaDB restarted|Connection lost|closed state|ECONNRESET/i);
      expect(isWriteFenced(database.id)).toBe(false);
      expect(await until(async () => (await lockedHosts(credentials.user))?.length === 0, 60_000)).toBe(true);
      const own = await mysql.createConnection({ host: "127.0.0.1", port: env.mariadbPort, user: credentials.user, password: credentials.password, database: s });
      await own.query("INSERT INTO z VALUES (-1, 'usable again')");
      await own.end();
      expect((await createCheckpoint(database.id, { trigger: "manual" })).checkpointId).not.toBeNull();
    }, 300_000);
  }

  test("a write by another account after the safety checkpoint makes the swap take it again", async () => {
    const { database, s, target } = await orders();
    beforeEachSwap((opts, attempt) => {
      if (opts.live === s && attempt === 0) clientWrite("ld_test_extra", "Extra-pass-1234", s, "INSERT INTO orders VALUES (3, 'paid')");
    });
    const warnings: string[] = [];
    let result;
    try {
      result = await restoreCheckpoint(database.id, target, { userId: null, hooks: { warn: (m) => warnings.push(m) } });
    } finally {
      checkpointSwap.run = realRun;
    }
    expect(await ids(s)).toEqual([1]);
    expect(warnings.some((w) => w.startsWith("The database changed after its safety checkpoint was taken (orders)"))).toBe(true);
    expect(result.safetyCheckpointId).not.toBeNull();
    expect(checkpoints.listForDatabase(database.id).filter((c) => c.trigger === "pre-restore").length).toBe(1);
    await restoreCheckpoint(database.id, result.safetyCheckpointId!, { userId: null });
    expect(await ids(s)).toEqual([1, 2, 3]);
    expect((await verifyCheckpointStore(database.id)).missing).toEqual([]);
  }, T);

  test("a writer that never stops makes the rollback fail with nothing changed", async () => {
    const { database, s, target } = await orders();
    const before = checkpoints.listForDatabase(database.id).map((c) => c.id);
    const base = databases.byId(database.id)!.baseCheckpointId;
    let next = 10;
    beforeEachSwap((opts) => {
      if (opts.live === s) clientWrite("ld_test_extra", "Extra-pass-1234", s, `INSERT INTO orders VALUES (${next++}, 'more')`);
    });
    let error: Error | null = null;
    try {
      await restoreCheckpoint(database.id, target, { userId: null });
    } catch (err) {
      error = err as Error;
    } finally {
      checkpointSwap.run = realRun;
    }
    expect(error?.message).toMatch(/^Rolling back to [0-9a-f]{7} was not done: orders kept changing while their safety checkpoint was taken/);
    expect(error!.message).toContain("Something other than its own account is writing to them (another MariaDB account, or a scheduled event). Nothing was changed.");
    expect(await ids(s)).toEqual([1, 2, 10, 11, 12, 13]);
    expect(checkpoints.listForDatabase(database.id).map((c) => c.id)).toEqual(before);
    expect(databases.byId(database.id)!.baseCheckpointId).toBe(base);
  }, T);

  test("a rollback says how many of the database's own connections it closed", async () => {
    const { database, credentials, s, target } = await orders();
    const app = await mysql.createConnection({ host: "127.0.0.1", port: env.mariadbPort, user: credentials.user, password: credentials.password, database: s });
    app.on("error", () => {});
    const warnings: string[] = [];
    await restoreCheckpoint(database.id, target, { userId: null, hooks: { warn: (m) => warnings.push(m) } });
    await app.end().catch(() => {});
    expect(warnings).toContain("1 connection(s) of this database's own account were closed while the safety checkpoint was taken and the tables were swapped");
  }, T);

  test("a blocked swap removes the safety checkpoint it had just taken", async () => {
    const { database, s, target } = await orders();
    const before = checkpoints.listForDatabase(database.id).map((c) => c.id);
    const base = databases.byId(database.id)!.baseCheckpointId;
    const holder = await mysql.createConnection({ host: "127.0.0.1", port: env.mariadbPort, user: "ld_test_extra", password: "Extra-pass-1234", database: s });
    await holder.query("START TRANSACTION");
    await holder.query("SELECT * FROM orders");
    let error: Error | null = null;
    try {
      await restoreCheckpoint(database.id, target, { userId: null });
    } catch (err) {
      error = err as Error;
    } finally {
      await holder.query("ROLLBACK").catch(() => {});
      await holder.end().catch(() => {});
    }
    expect(error?.name).toBe("SwapBlockedError");
    expect(error!.message).toContain("nothing was changed");
    expect(checkpoints.listForDatabase(database.id).map((c) => c.id)).toEqual(before);
    expect(databases.byId(database.id)!.baseCheckpointId).toBe(base);
    expect(await ids(s)).toEqual([1, 2]);
  }, T);

  test("a rollback completed by recovery after a crash ends as succeeded and points the base at its checkpoint", async () => {
    const { database, s, target } = await orders();
    checkpointSwap.run = (opts) =>
      realRun({
        ...opts,
        onPhase: async (p) => {
          await opts.onPhase?.(p);
          if (p === "renamed") throw new Error("simulated stop right after the rename");
        },
      });
    const job = startJob({ kind: "checkpoint.restore", databaseId: database.id, userId: null }, (ctx) =>
      restoreCheckpoint(database.id, target, { userId: null, hooks: ctx }),
    );
    let finished;
    try {
      finished = await waitForJob(job.id);
    } finally {
      checkpointSwap.run = realRun;
    }
    expect(finished!.status).toBe("failed");
    await recoverInterruptedSwaps();
    const after = jobs.byId(job.id)!;
    expect(after.status).toBe("succeeded");
    expect(after.warnings.some((w) => w.startsWith("This rollback was interrupted by a restart after the new tables were moved in, and LambData completed it"))).toBe(true);
    expect(after.result).toMatchObject({ restoredCheckpointId: target, completedAfterRestart: true });
    expect(typeof (after.result as { safetyCheckpointId: unknown }).safetyCheckpointId).toBe("string");
    expect(databases.byId(database.id)!.baseCheckpointId).toBe(target);
    expect(await ids(s)).toEqual([1]);
  }, T);

  test("a rollback whose swap finished just before LambData stopped reads as succeeded after the restart", async () => {
    const { database, s, target } = await orders();
    let release!: () => void;
    const hold = new Promise<void>((r) => (release = r));
    let swapped = false;
    checkpointSwap.run = async (opts) => {
      await realRun(opts);
      swapped = true;
      await hold;
      throw new Error("simulated stop after the swap");
    };
    const job = startJob({ kind: "checkpoint.restore", databaseId: database.id, userId: null }, (ctx) =>
      restoreCheckpoint(database.id, target, { userId: null, hooks: ctx }),
    );
    try {
      expect(await until(() => swapped, 120_000)).toBe(true);
      expect(jobs.byId(job.id)!.status).toBe("running");
      expect(recoverInterruptedJobs().completed).toBe(1);
      const after = jobs.byId(job.id)!;
      expect(after.status).toBe("succeeded");
      expect(after.error).toBeNull();
      expect(after.warnings.some((w) => w.startsWith("LambData stopped after this rollback had moved the new tables in, before the job could record that it had finished; the rollback is complete. The state before it is saved in checkpoint "))).toBe(true);
      expect(after.result).toMatchObject({ restoredCheckpointId: target, outcome: "done", completedAfterRestart: true });
      expect(after.result).not.toHaveProperty(SWAP_DONE_KEY);
      expect(databases.byId(database.id)!.baseCheckpointId).toBe(target);
      expect(await ids(s)).toEqual([1]);
    } finally {
      release();
      checkpointSwap.run = realRun;
      await waitForJob(job.id);
    }
  }, T);
});
