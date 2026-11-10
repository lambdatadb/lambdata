import { exec, makeDatabase, mariadbAvailable, rootQuery, select, setup, type Fixture } from "./helpers";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import mysql from "mysql2/promise";
import { createCheckpoint, deleteCheckpoint, getWorkingCopyStatus, restoreCheckpoint } from "../../src/checkpoints";
import { checkpointDownloadStream } from "../../src/checkpoints/download";
import { applyRetention, collectGarbage, verifyCheckpointStore } from "../../src/checkpoints/manage";
import { hasObject, storeBytes } from "../../src/checkpoints/store";
import { captureLimits, captureSchemaTables, runningCaptures } from "../../src/checkpoints/tables";
import { checkpoints, jobs } from "../../src/db/queries";
import { db } from "../../src/db/client";
import { importRuns } from "../../src/db/queries/imports";
import { env } from "../../src/env";
import { startJob, waitForJob, INTERRUPTED_MESSAGE } from "../../src/jobs";
import { undoInterruptedImports } from "../../src/imports/service";
import { getRootPassword } from "../../src/mariadb/controller";
import { roundTrip, type RoundTrip } from "./fidelity";

const T = 240_000;

function expectExact(r: RoundTrip) {
  expect(r.captureError).toBeNull();
  expect(r.restoreError).toBeNull();
  expect(r.diffs).toEqual([]);
  expect(r.status).toBe("clean");
}

async function watcher() {
  return mysql.createConnection({ host: "127.0.0.1", port: env.mariadbPort, user: env.rootUser, password: await getRootPassword() });
}

async function killWhenSeen(pattern: string, timeoutMs = 60_000): Promise<boolean> {
  const w = await watcher();
  const started = Date.now();
  try {
    while (Date.now() - started < timeoutMs) {
      const [rows] = (await w.query("SELECT ID FROM information_schema.PROCESSLIST WHERE INFO LIKE ? AND INFO NOT LIKE '%PROCESSLIST%'", [pattern])) as [
        { ID: number }[],
        unknown,
      ];
      if (rows.length > 0) {
        await w.query(`KILL CONNECTION ${Number(rows[0]!.ID)}`);
        return true;
      }
      await Bun.sleep(1);
    }
    return false;
  } finally {
    await w.end();
  }
}

function deadline<T>(p: Promise<T>, ms: number): Promise<T | "HUNG"> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([p, new Promise<"HUNG">((r) => (timer = setTimeout(() => r("HUNG"), ms)))]).finally(() => clearTimeout(timer));
}

async function storeIsWhole(databaseId: string): Promise<void> {
  const check = await verifyCheckpointStore(databaseId);
  expect({ missing: check.missing, corrupt: check.corrupt }).toEqual({ missing: [], corrupt: [] });
}

describe.skipIf(!mariadbAvailable())("checkpoint fixes, round 3", () => {
  let fx: Fixture;

  beforeAll(async () => {
    fx = await setup();
  }, 180_000);

  afterAll(async () => {
    await fx?.instance.stop();
  }, 120_000);

  test("a capture whose connection is killed fails promptly and the database stays usable", async () => {
    const { database } = await makeDatabase(fx.owner);
    const s = database.name;
    await exec(s, "CREATE TABLE z (id INT PRIMARY KEY, pad VARCHAR(200))", "INSERT INTO z SELECT seq, REPEAT('p', 150) FROM seq_1_to_400000");
    const killer = killWhenSeen(`SELECT % FROM \`${s}\`.\`z\`%`);
    const outcome = await deadline(
      createCheckpoint(database.id, { trigger: "manual" }).then(
        () => "succeeded",
        (err: Error) => `failed: ${err.message}`,
      ),
      30_000,
    );
    expect(await killer).toBe(true);
    expect(outcome).toMatch(/^failed: .*connection to MariaDB was lost while the checkpoint was reading table z/);
    expect(runningCaptures()).toBe(0);
    expect(checkpoints.listForDatabase(database.id)).toEqual([]);
    const again = await createCheckpoint(database.id, { trigger: "manual" });
    expect(again.checkpointId).not.toBeNull();
    await storeIsWhole(database.id);
  }, T);

  test("a capture that makes no progress is stopped", async () => {
    const { database } = await makeDatabase(fx.owner);
    await exec(database.name, "CREATE TABLE t (id INT PRIMARY KEY, pad VARCHAR(1000))", "INSERT INTO t SELECT seq, REPEAT('p', 900) FROM seq_1_to_2000");
    const previous = captureLimits.inactivityMs;
    captureLimits.inactivityMs = 400;
    try {
      const stuck = new Promise<void>(() => {});
      const outcome = await deadline(
        captureSchemaTables(database.name, {
          open: async () => ({ write: () => stuck, finish: async () => null, abort: async () => {} }),
        }).then(
          () => "succeeded",
          (err: Error) => `failed: ${err.message}`,
        ),
        20_000,
      );
      expect(outcome).toMatch(/^failed: reading table t made no progress for 0 seconds/);
    } finally {
      captureLimits.inactivityMs = previous;
    }
  }, T);

  test("a failed capture during an open download never removes an object a later checkpoint reuses", async () => {
    const { database } = await makeDatabase(fx.owner);
    const s = database.name;
    await exec(s, "CREATE TABLE a_small (id INT PRIMARY KEY, v VARCHAR(20))", "INSERT INTO a_small VALUES (1, 'one')");
    await exec(s, "CREATE TABLE m_big (id INT PRIMARY KEY, pad VARCHAR(200))", "INSERT INTO m_big SELECT seq, REPEAT('p', 150) FROM seq_1_to_400000");
    const c1 = (await createCheckpoint(database.id, { trigger: "manual", message: "c1" })).checkpointId!;
    const reader = checkpointDownloadStream(s, checkpoints.byId(c1)!, checkpoints.entries(c1)).getReader();
    await reader.read();
    await exec(s, "UPDATE a_small SET v = 'two' WHERE id = 1");
    const killer = killWhenSeen(`SELECT % FROM \`${s}\`.\`m_big\`%`);
    await expect(createCheckpoint(database.id, { trigger: "manual", message: "fails" })).rejects.toThrow();
    expect(await killer).toBe(true);
    const c2 = (await createCheckpoint(database.id, { trigger: "manual", message: "c2" })).checkpointId!;
    const reused = checkpoints.entries(c2).find((e) => e.name === "a_small")!;
    for (;;) {
      const { done } = await reader.read();
      if (done) break;
    }
    await Bun.sleep(300);
    expect(hasObject(database.id, reused.objectHash)).toBe(true);
    await storeIsWhole(database.id);
    await restoreCheckpoint(database.id, c2, { userId: null });
    expect(await select(s, "SELECT v FROM a_small")).toEqual([{ v: "two" }]);
  }, T);

  test("retention, deletion, downloads and failures in any order leave the object store whole", async () => {
    const { database } = await makeDatabase(fx.owner);
    const s = database.name;
    checkpoints.setPolicy(database.id, { autoIntervalHours: 24, autoRetention: 2, checkpointOnSync: true });
    await exec(s, "CREATE TABLE t (id INT PRIMARY KEY, v INT)", "CREATE TABLE u (id INT PRIMARY KEY, w VARCHAR(10))", "INSERT INTO u VALUES (1, 'fixed')");
    let seed = 4242;
    const rnd = (n: number) => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed % n;
    };
    const triggers = ["scheduled", "manual", "pre-restore", "pre-import", "pre-sync", "sync"] as const;
    let open: ReadableStreamDefaultReader<Uint8Array> | null = null;
    for (let i = 0; i < 40; i++) {
      const op = rnd(8);
      if (op < 3) {
        await exec(s, `INSERT INTO t VALUES (${i}, ${rnd(3)}) ON DUPLICATE KEY UPDATE v = v + 1`);
        if (rnd(3) === 0) await exec(s, "UPDATE u SET w = IF(w = 'fixed', 'changed', 'fixed')");
        await createCheckpoint(database.id, { trigger: triggers[rnd(triggers.length)]! });
      } else if (op === 3) {
        const list = checkpoints.listForDatabase(database.id);
        if (list.length > 1) await deleteCheckpoint(database.id, list[rnd(list.length)]!.id);
      } else if (op === 4) {
        const list = checkpoints.listForDatabase(database.id);
        if (list.length > 0) await restoreCheckpoint(database.id, list[rnd(list.length)]!.id, { userId: null });
      } else if (op === 5) {
        await applyRetention(database.id);
        await collectGarbage(database.id);
      } else if (op === 6) {
        if (open) {
          for (;;) if ((await open.read()).done) break;
          open = null;
        } else {
          const list = checkpoints.listForDatabase(database.id);
          if (list.length > 0) {
            const c = list[rnd(list.length)]!;
            open = checkpointDownloadStream(s, c, checkpoints.entries(c.id)).getReader();
            await open.read();
          }
        }
      } else {
        await exec(s, `INSERT INTO t VALUES (${1000 + i}, 1)`);
        const killer = killWhenSeen(`SELECT % FROM \`${s}\`.\`u\`%`, 5_000);
        await createCheckpoint(database.id, { trigger: "manual" }).catch(() => null);
        await killer;
      }
      await Bun.sleep(open ? 0 : 50);
      await storeIsWhole(database.id);
    }
    if (open) for (;;) if ((await open.read()).done) break;
    await Bun.sleep(100);
    await storeIsWhole(database.id);
  }, 600_000);

  test("ENUM and SET values come back as the same member, including invalid and collation-equal ones", async () => {
    const cases: string[][] = [
      ["SET SESSION sql_mode = ''", "CREATE TABLE t (id INT PRIMARY KEY, e ENUM('', 'a'))", "INSERT INTO t VALUES (1, 'zzz'), (2, ''), (3, 'a')"],
      ["SET SESSION sql_mode = ''", "CREATE TABLE t (id INT PRIMARY KEY, e ENUM('x','X') COLLATE utf8mb4_general_ci)", "INSERT INTO t VALUES (1, 1), (2, 2)"],
      ["SET SESSION sql_mode = ''", "CREATE TABLE t (id INT PRIMARY KEY, s SET('p','P') COLLATE utf8mb4_general_ci)", "INSERT INTO t VALUES (1, 1), (2, 2), (3, 3)"],
      [
        "SET SESSION sql_mode = ''",
        "CREATE TABLE t (id INT PRIMARY KEY, e ENUM('x','X','y') COLLATE utf8mb4_general_ci, s SET('p','P') COLLATE utf8mb4_general_ci)",
        "INSERT INTO t VALUES (1, 1, 1), (2, 2, 2), (3, 3, 3)",
      ],
      [
        "SET SESSION sql_mode = ''",
        `CREATE TABLE t (id INT PRIMARY KEY, e ENUM('', 'a', 'it''s', 'back\\\\slash', '0', '1', 'ünï ë', 'comma,inside', 'x  y'),
           e2 ENUM('x','X') COLLATE utf8mb4_bin, e3 ENUM('a','b') CHARACTER SET latin1, s SET('a','b','c d','é','1'), s2 SET('x','y') NOT NULL)`,
        `INSERT INTO t VALUES (1, '', 'x', 'a', '', ''), (2, 'a', 'X', 'b', 'a,b', 'x,y'), (3, 'it''s', NULL, NULL, 'c d,é', 'y'),
          (4, 'back\\\\slash', 'x', 'a', 'a,b,c d,é,1', ''), (5, '0', 'X', 'b', '1', 'x'), (6, '1', 'x', NULL, NULL, 'x,y'),
          (7, 'ünï ë', 'X', 'a', 'é', 'x'), (8, 'comma,inside', 'x', 'b', '', 'y'), (9, 'x  y', 'X', 'a', 'a', 'x'),
          (10, 'not-a-member', 'zz', 'q', 'zz', 'zz'), (11, 3, 2, 2, 31, 3), (12, NULL, NULL, NULL, 7, 0)`,
      ],
      ["CREATE TABLE t (id INT PRIMARY KEY, e ENUM('a','ü','€') CHARACTER SET ucs2, s SET('ä','b') CHARACTER SET latin1)", "INSERT INTO t VALUES (1, 'ü', 'ä,b'), (2, '€', ''), (3, NULL, NULL)"],
    ];
    for (const c of cases) expectExact(await roundTrip(fx, c));
    const emoji = await roundTrip(fx, [
      "SET SESSION sql_mode = ''",
      `CREATE TABLE t (id INT PRIMARY KEY, e ENUM('', 'a', 'it''s', 'back\\\\slash', 'ünï 😀', 'q?', '😀''x') DEFAULT 'ünï 😀',
         s SET('a', '😀b', 'c') NOT NULL DEFAULT 'a,😀b', u ENUM('x', '😀') CHARACTER SET utf16)`,
      "INSERT INTO t VALUES (1, 5, 3, 2), (2, 7, 2, 1), (3, 'zzz', 0, NULL)",
      "INSERT INTO t (id) VALUES (4)",
    ]);
    expectExact(emoji);
    expect(emoji.limitations).toEqual([]);
  }, T);

  test("a table whose name contains a newline is rolled back", async () => {
    expectExact(await roundTrip(fx, ["CREATE TABLE `line\nbreak` (id INT PRIMARY KEY, v VARCHAR(5))", "INSERT INTO `line\nbreak` VALUES (1, 'a')", "CREATE TABLE ok (id INT)"]));
  }, T);

  test("ascii columns holding high bytes come back byte for byte", async () => {
    for (const bytes of ["0xC3A9", "0x80FF", "0x41C3"]) {
      expectExact(
        await roundTrip(fx, [
          "SET SESSION sql_mode = ''",
          "CREATE TABLE t (id INT PRIMARY KEY, v VARCHAR(10) CHARACTER SET ascii, w VARCHAR(10) CHARACTER SET ascii)",
          "SET NAMES binary",
          `INSERT INTO t VALUES (1, ${bytes}, 'plain')`,
          "SET NAMES utf8mb4",
        ]),
      );
    }
  }, T);

  test("objects written before ENUM values were stored as numbers still load", async () => {
    const { database } = await makeDatabase(fx.owner);
    const s = database.name;
    await exec(s, "CREATE TABLE t (id INT PRIMARY KEY, e ENUM('a','b','c'), st SET('x','y'))", "INSERT INTO t VALUES (1, 'b', 'x,y'), (2, 'c', '')");
    const cp = (await createCheckpoint(database.id, { trigger: "manual" })).checkpointId!;
    const entry = checkpoints.entries(cp).find((e) => e.name === "t")!;
    const [ddl] = await rootQuery<Record<string, string>>(`SHOW CREATE TABLE \`${s}\`.t`);
    const old = [
      "-- LambData table v2 t",
      "DROP TABLE IF EXISTS `t`;",
      `${ddl!["Create Table"]};`,
      "INSERT INTO `t` (`id`, `e`, `st`) VALUES (1,'b','x,y'),(2,'c','');",
      "",
    ].join("\n");
    const stored = await storeBytes(database.id, old);
    db.query("UPDATE checkpoint_entries SET object_hash = ? WHERE checkpoint_id = ? AND name = 't'").run(stored.hash, cp);
    expect(stored.hash).not.toBe(entry.objectHash);
    await exec(s, "UPDATE t SET e = 'a'");
    await restoreCheckpoint(database.id, cp, { userId: null });
    expect(await select(s, "SELECT id, e, st FROM t ORDER BY id")).toEqual([
      { id: 1, e: "b", st: "x,y" },
      { id: 2, e: "c", st: "" },
    ]);
  }, T);

  test("a table dropped while the checkpoint is being taken is skipped and stated", async () => {
    const { database } = await makeDatabase(fx.owner);
    const s = database.name;
    await exec(
      s,
      "CREATE TABLE a_small (id INT PRIMARY KEY)",
      "INSERT INTO a_small VALUES (1)",
      "CREATE TABLE m_big (id INT PRIMARY KEY, pad VARCHAR(200))",
      "INSERT INTO m_big SELECT seq, REPEAT('p', 150) FROM seq_1_to_300000",
      "CREATE TABLE z_tmp (id INT PRIMARY KEY)",
    );
    const w = await watcher();
    const dropper = (async () => {
      const started = Date.now();
      while (Date.now() - started < 60_000) {
        const [rows] = (await w.query("SELECT ID FROM information_schema.PROCESSLIST WHERE INFO LIKE ? AND INFO NOT LIKE '%PROCESSLIST%'", [
          `SELECT % FROM \`${s}\`.\`m_big\`%`,
        ])) as [unknown[], unknown];
        if (rows.length > 0) {
          await w.query(`DROP TABLE \`${s}\`.z_tmp`);
          return true;
        }
        await Bun.sleep(1);
      }
      return false;
    })();
    const r = await createCheckpoint(database.id, { trigger: "manual" });
    expect(await dropper).toBe(true);
    await w.end();
    expect(r.limitations).toEqual(["table z_tmp disappeared while the checkpoint was being taken"]);
    expect(checkpoints.entries(r.checkpointId!).map((e) => e.name).sort()).toEqual(["a_small", "m_big"]);
    expect((await getWorkingCopyStatus(database.id, { refresh: true })).state).toBe("clean");
  }, T);

  test("a change to only the AUTO_INCREMENT counter makes the working copy dirty", async () => {
    const { database } = await makeDatabase(fx.owner);
    const s = database.name;
    await exec(s, "CREATE TABLE items (id INT AUTO_INCREMENT PRIMARY KEY, v VARCHAR(20))", "INSERT INTO items (v) VALUES ('a'), ('b')");
    await createCheckpoint(database.id, { trigger: "manual" });
    expect((await getWorkingCopyStatus(database.id, { refresh: true })).state).toBe("clean");
    await exec(s, "INSERT INTO items (v) VALUES ('tmp')", "DELETE FROM items WHERE v = 'tmp'");
    const status = await getWorkingCopyStatus(database.id, { refresh: true });
    expect(status.state).toBe("dirty");
    expect(status.diff!.tables.map((t) => t.name)).toEqual(["items"]);
  }, T);

  test("transaction-precise system versioning is stated with the right reason", async () => {
    const r = await roundTrip(fx, [
      `CREATE TABLE tv (id INT PRIMARY KEY, v INT, rs BIGINT UNSIGNED GENERATED ALWAYS AS ROW START, re BIGINT UNSIGNED GENERATED ALWAYS AS ROW END,
         PERIOD FOR SYSTEM_TIME (rs, re)) ENGINE=InnoDB WITH SYSTEM VERSIONING`,
      "INSERT INTO tv (id, v) VALUES (1, 1)",
      "UPDATE tv SET v = 2",
    ]);
    expect(r.captureError).toBeNull();
    expect(r.limitations).toEqual([
      "the history of system-versioned table tv is not included: it is versioned by transaction id (its row start and end columns are BIGINT), and such a table cannot be reloaded with its history, so only its current rows are kept",
    ]);
  }, T);

  test("an import that created a database and was cut short by a restart is undone at startup", async () => {
    const { database } = await makeDatabase(fx.owner);
    await exec(database.name, "CREATE TABLE players (id INT PRIMARY KEY)", "INSERT INTO players SELECT seq FROM seq_1_to_500");
    const job = startJob({ kind: "import.sqlite", databaseId: database.id, userId: null }, async () => ({ ok: true }));
    await waitForJob(job.id);
    db.query("UPDATE jobs SET status = 'failed', error = ?, result = NULL WHERE id = ?").run(INTERRUPTED_MESSAGE, job.id);
    importRuns.start({ jobId: job.id, databaseId: database.id, mode: "create", schemaName: database.name, startedAt: Date.now() });
    const out = await undoInterruptedImports();
    expect(out.reset).toContain(database.name);
    expect(await rootQuery("SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = ?", [database.name])).toEqual([]);
    const after = jobs.byId(job.id)!;
    expect(after.status).toBe("failed");
    expect(after.error).toMatch(/interrupted by a restart\. The partly imported data was removed/);
    expect(importRuns.list().some((r) => r.jobId === job.id)).toBe(false);
  }, T);
});
