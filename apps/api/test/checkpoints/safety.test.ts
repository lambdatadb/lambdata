import {
  checksums,
  codeObjectsOf,
  exec,
  makeDatabase,
  mariadbAvailable,
  populateRich,
  rootQuery,
  select,
  setup,
  type Fixture,
} from "./helpers";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import mysql from "mysql2/promise";
import { createCheckpoint, deleteCheckpoint, getWorkingCopyStatus, restoreCheckpoint } from "../../src/checkpoints";
import { checkpointDownloadStream } from "../../src/checkpoints/download";
import { convertLegacySnapshots, legacyCheckpointId } from "../../src/checkpoints/startup";
import { objectPath } from "../../src/checkpoints/store";
import { checkpoints, databases, jobs as jobStore, snapshots } from "../../src/db/queries";
import { db } from "../../src/db/client";
import { env } from "../../src/env";
import { getMariaDbBinariesSync, getRootPassword } from "../../src/mariadb/controller";
import { STAGING_PREFIX, TRASH_PREFIX } from "../../src/mariadb/schemaSwap";
import { isWriteFenced } from "../../src/mariadb/writeFence";
import { newId } from "../../src/util/id";
import { waitForJob } from "../../src/jobs";
import { buildApp } from "../../src/server";
import { authHeaders } from "../harness/sqlite";
import type { CheckpointRestoreJobResult, Job } from "@lambdata/shared";

function writeNow(schema: string, sql: string, password: string): void {
  const proc = Bun.spawnSync(
    [
      getMariaDbBinariesSync().client,
      "--no-defaults",
      "--protocol=TCP",
      "--host=127.0.0.1",
      `--port=${env.mariadbPort}`,
      `--user=${env.rootUser}`,
      "--skip-ssl",
      `--database=${schema}`,
      "-e",
      sql,
    ],
    { env: { PATH: process.env.PATH ?? "", MYSQL_PWD: password } },
  );
  if (proc.exitCode !== 0) throw new Error(new TextDecoder().decode(proc.stderr));
}

async function managedSchemas(): Promise<string[]> {
  const rows = await rootQuery<{ n: string }>("SELECT SCHEMA_NAME AS n FROM information_schema.SCHEMATA");
  return rows.map((r) => r.n).filter((n) => n.startsWith(STAGING_PREFIX) || n.startsWith(TRASH_PREFIX));
}

async function gunzipOk(bytes: Uint8Array): Promise<{ ok: boolean; text: string }> {
  const proc = Bun.spawn(["gunzip", "-c"], { stdin: bytes, stdout: "pipe", stderr: "pipe" });
  const text = await new Response(proc.stdout).text();
  return { ok: (await proc.exited) === 0, text };
}

describe.skipIf(!mariadbAvailable())("rollback safety", () => {
  let fx: Fixture;

  beforeAll(async () => {
    fx = await setup();
  }, 180_000);

  afterAll(async () => {
    await fx?.instance.stop();
  }, 120_000);

  test("restoring the oldest automatic checkpoint keeps it, and safety checkpoints never evict daily ones", async () => {
    const { database } = await makeDatabase(fx.owner);
    const schema = database.name;
    checkpoints.setPolicy(database.id, { autoIntervalHours: 24, autoRetention: 3, checkpointOnSync: true });
    await exec(schema, "CREATE TABLE t (id INT PRIMARY KEY, v VARCHAR(20))");
    const daily: string[] = [];
    for (let day = 1; day <= 3; day++) {
      await exec(schema, `INSERT INTO t VALUES (${day}, 'day ${day}')`);
      daily.push((await createCheckpoint(database.id, { trigger: "scheduled" })).checkpointId!);
    }
    await exec(schema, "INSERT INTO t VALUES (99, 'bad edit')", "DELETE FROM t WHERE id = 1");
    await restoreCheckpoint(database.id, daily[0]!, { userId: null });
    expect((await select<{ id: number }>(schema, "SELECT id FROM t ORDER BY id")).map((r) => Number(r.id))).toEqual([1]);
    for (let attempt = 1; attempt <= 4; attempt++) {
      await exec(schema, `INSERT INTO t VALUES (${100 + attempt}, 'x')`);
      await restoreCheckpoint(database.id, daily[2]!, { userId: null });
    }
    expect(daily.filter((id) => checkpoints.exists(id)).length).toBe(3);
    const safety = checkpoints.listForDatabase(database.id).filter((c) => c.trigger === "pre-restore");
    expect(safety.length).toBe(3);
    expect(safety[0]!.message).toBe(`Before rolling back to ${checkpoints.byId(daily[2]!)!.shortHash}`);
  }, 240_000);

  test("an application write made while the restore loads ends up in the safety checkpoint", async () => {
    const { database } = await makeDatabase(fx.owner);
    const schema = database.name;
    await exec(schema, "CREATE TABLE orders (id INT PRIMARY KEY, item VARCHAR(20))", "INSERT INTO orders VALUES (1, 'old')");
    const target = (await createCheckpoint(database.id, { trigger: "manual" })).checkpointId!;
    await exec(schema, "INSERT INTO orders VALUES (2, 'kept by safety')");
    const password = await getRootPassword();
    const result = await restoreCheckpoint(database.id, target, {
      userId: null,
      hooks: {
        stage(label) {
          if (label.startsWith("Loading")) writeNow(schema, "INSERT INTO orders VALUES (3, 'paid order')", password);
        },
      },
    });
    expect((await select<{ id: number }>(schema, "SELECT id FROM orders ORDER BY id")).map((r) => Number(r.id))).toEqual([1]);
    await restoreCheckpoint(database.id, result.safetyCheckpointId!, { userId: null });
    expect((await select<{ id: number }>(schema, "SELECT id FROM orders ORDER BY id")).map((r) => Number(r.id))).toEqual([1, 2, 3]);
  }, 240_000);

  test("the database's own account is closed to writes for the safety checkpoint and the swap, and reopened after", async () => {
    const { database, credentials } = await makeDatabase(fx.owner);
    const schema = database.name;
    await exec(schema, "CREATE TABLE t (id INT PRIMARY KEY)", "INSERT INTO t VALUES (1)");
    const target = (await createCheckpoint(database.id, { trigger: "manual" })).checkpointId!;
    await exec(schema, "INSERT INTO t VALUES (2)");
    const app = await mysql.createConnection({
      host: "127.0.0.1",
      port: env.mariadbPort,
      user: credentials.user,
      password: credentials.password,
      database: schema,
    });
    app.on("error", () => {});
    let fencedDuringSafety = false;
    let refusedDuringSafety: string | null = null;
    await restoreCheckpoint(database.id, target, {
      userId: null,
      hooks: {
        stage(label) {
          if (!label.startsWith("Saving a safety")) return;
          fencedDuringSafety = isWriteFenced(database.id);
          const proc = Bun.spawnSync(
            [getMariaDbBinariesSync().client, "--no-defaults", "--protocol=TCP", "--host=127.0.0.1", `--port=${env.mariadbPort}`, `--user=${credentials.user}`, "--skip-ssl", `--database=${schema}`, "-e", "INSERT INTO t VALUES (3)"],
            { env: { PATH: process.env.PATH ?? "", MYSQL_PWD: credentials.password } },
          );
          refusedDuringSafety = proc.exitCode === 0 ? null : new TextDecoder().decode(proc.stderr);
        },
      },
    });
    expect(fencedDuringSafety).toBe(true);
    expect(refusedDuringSafety).toMatch(/locked|denied/i);
    await expect(app.query("SELECT 1")).rejects.toThrow();
    expect(isWriteFenced(database.id)).toBe(false);
    const again = await mysql.createConnection({
      host: "127.0.0.1",
      port: env.mariadbPort,
      user: credentials.user,
      password: credentials.password,
      database: schema,
    });
    await again.query("INSERT INTO t VALUES (4)");
    await again.end();
    expect((await select<{ id: number }>(schema, "SELECT id FROM t ORDER BY id")).map((r) => Number(r.id))).toEqual([1, 4]);
  }, 240_000);

  test("statistics describe the dumped data even when a write lands as the dump starts", async () => {
    const { database } = await makeDatabase(fx.owner);
    const schema = database.name;
    await exec(schema, "CREATE TABLE t (id INT PRIMARY KEY, v VARCHAR(20))", "INSERT INTO t VALUES (1, 'one'), (2, 'two')");
    const password = await getRootPassword();
    const cp = (
      await createCheckpoint(database.id, {
        trigger: "manual",
        hooks: {
          stage(label) {
            if (label.startsWith("Dumping")) writeNow(schema, "INSERT INTO t VALUES (3, 'app write')", password);
          },
        },
      })
    ).checkpointId!;
    expect(checkpoints.entries(cp).find((e) => e.name === "t")!.rowCount).toBe(3);
    expect((await getWorkingCopyStatus(database.id, { refresh: true })).state).toBe("clean");
    await exec(schema, "DELETE FROM t WHERE id = 3");
    expect((await getWorkingCopyStatus(database.id, { refresh: true })).state).toBe("dirty");
    const warnings: string[] = [];
    await restoreCheckpoint(database.id, cp, { userId: null, hooks: { warn: (m) => warnings.push(m) } });
    expect(warnings).toEqual([]);
    expect((await select<{ id: number }>(schema, "SELECT id FROM t ORDER BY id")).length).toBe(3);
  }, 240_000);

  test("a view on a dropped table does not block the rollback that brings the table back", async () => {
    const { database } = await makeDatabase(fx.owner);
    const schema = database.name;
    await exec(
      schema,
      "CREATE TABLE orders (id INT PRIMARY KEY, total INT)",
      "INSERT INTO orders VALUES (1, 10), (2, 20)",
      "CREATE VIEW v_revenue AS SELECT SUM(total) AS revenue FROM orders",
    );
    const good = (await createCheckpoint(database.id, { trigger: "scheduled" })).checkpointId!;
    await exec(schema, "DROP TABLE orders");
    expect((await getWorkingCopyStatus(database.id, { refresh: true })).state).toBe("dirty");
    await restoreCheckpoint(database.id, good, { userId: null });
    expect(await select(schema, "SELECT revenue FROM v_revenue")).toEqual([{ revenue: "30" }]);
  }, 240_000);

  test("when the loaded copy does not match the checkpoint, nothing is changed and the job says why", async () => {
    const { database } = await makeDatabase(fx.owner);
    const schema = database.name;
    await populateRich(schema);
    const cp = (await createCheckpoint(database.id, { trigger: "manual" })).checkpointId!;
    await exec(schema, "INSERT INTO settings VALUES ('live', 'data')", "DROP VIEW v_leaderboard");
    const live = await checksums(schema);
    const liveCode = await codeObjectsOf(schema);
    db.query("UPDATE checkpoint_entries SET checksum = checksum + 1 WHERE checkpoint_id = ? AND name = 'players'").run(cp);
    db.query("UPDATE checkpoint_entries SET row_count = 99 WHERE checkpoint_id = ? AND name = 'settings'").run(cp);
    const before = checkpoints.listForDatabase(database.id).length;
    let error: Error | null = null;
    try {
      await restoreCheckpoint(database.id, cp, { userId: null });
    } catch (err) {
      error = err as Error;
    }
    expect(error?.name).toBe("RestoreVerificationError");
    expect(error!.message).toMatch(/^Rolling back to [0-9a-f]{7} was stopped before anything changed/);
    expect(error!.message).toContain("the contents of table players differ from what the checkpoint recorded");
    expect(error!.message).toContain("table settings has 3 row(s) after loading, the checkpoint recorded 99");
    expect(await checksums(schema)).toEqual(live);
    expect(await codeObjectsOf(schema)).toEqual(liveCode);
    expect(await managedSchemas()).toEqual([]);
    expect(checkpoints.listForDatabase(database.id).length).toBe(before);
    expect(databases.byId(database.id)!.baseCheckpointId).toBe(cp);
  }, 240_000);

  test("a code object that can no longer be created refuses the rollback before anything changes", async () => {
    const { database } = await makeDatabase(fx.owner);
    const schema = database.name;
    await rootQuery("CREATE DATABASE IF NOT EXISTS zz_safety_rates");
    await rootQuery("CREATE TABLE IF NOT EXISTS zz_safety_rates.rates (id INT PRIMARY KEY, r INT)");
    await exec(
      schema,
      "CREATE TABLE orders (id INT PRIMARY KEY, total INT)",
      "INSERT INTO orders VALUES (1, 10)",
      "CREATE VIEW a_rates AS SELECT r FROM zz_safety_rates.rates",
      "CREATE VIEW b_orders AS SELECT id, total FROM orders",
      "CREATE TRIGGER orders_audit BEFORE INSERT ON orders FOR EACH ROW SET NEW.total = NEW.total + 0",
    );
    const cp = (await createCheckpoint(database.id, { trigger: "manual" })).checkpointId!;
    await rootQuery("DROP TABLE zz_safety_rates.rates");
    await exec(schema, "DROP VIEW a_rates", "INSERT INTO orders VALUES (2, 20)");
    const live = await checksums(schema);
    const liveCode = await codeObjectsOf(schema);
    let error: Error | null = null;
    try {
      await restoreCheckpoint(database.id, cp, { userId: null });
    } catch (err) {
      error = err as Error;
    }
    expect(error?.message).toContain("these could not be re-created: view a_rates");
    expect(await checksums(schema)).toEqual(live);
    expect(await codeObjectsOf(schema)).toEqual(liveCode);
    expect(await managedSchemas()).toEqual([]);
  }, 240_000);

  test("a rollback refused over a view reading another database names it, and can be forced", async () => {
    const app = buildApp();
    const { database } = await makeDatabase(fx.owner);
    const schema = database.name;
    await rootQuery("CREATE DATABASE IF NOT EXISTS zz_force_rates");
    await rootQuery("CREATE TABLE IF NOT EXISTS zz_force_rates.rates (id INT PRIMARY KEY, r INT)");
    await exec(
      schema,
      "CREATE TABLE orders (id INT PRIMARY KEY, total INT)",
      "INSERT INTO orders VALUES (1, 10)",
      "CREATE VIEW a_rates AS SELECT r FROM zz_force_rates.rates",
      "CREATE VIEW b_orders AS SELECT id, total FROM orders",
      "CREATE TRIGGER orders_audit BEFORE INSERT ON orders FOR EACH ROW SET NEW.total = NEW.total + 0",
      "CREATE PROCEDURE p_count() SELECT COUNT(*) FROM orders",
    );
    const cp = (await createCheckpoint(database.id, { trigger: "manual" })).checkpointId!;
    const wanted = await checksums(schema);
    await exec(schema, "DROP VIEW a_rates", "INSERT INTO orders VALUES (2, 20)");
    const live = await checksums(schema);
    const liveCode = await codeObjectsOf(schema);
    const restore = async (body?: unknown): Promise<Job> => {
      const res = await app.request(`/api/databases/${database.id}/checkpoints/${cp}/restore`, {
        method: "POST",
        headers: await authHeaders(fx.owner, { "Content-Type": "application/json" }),
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      expect(res.status).toBe(202);
      const { job } = (await res.json()) as { job: Job };
      return (await waitForJob(job.id))!;
    };

    const refused = await restore();
    expect(refused.status).toBe("failed");
    expect(refused.errorCode).toBe("restore.code-unrestorable");
    expect(refused.errorDetails?.checkpointId).toBe(cp);
    expect(refused.errorDetails?.codeFailures?.map((f) => `${f.kind}:${f.name}`)).toEqual(["VIEW:a_rates"]);
    expect(refused.errorDetails!.codeFailures![0]!.error).toBe("reads `zz_force_rates`.`rates`, which is outside this database");
    expect(refused.error).toContain(
      "these could not be re-created: view a_rates (it reads `zz_force_rates`.`rates` outside this database, which LambData does not re-create automatically)",
    );
    expect(refused.error).toContain("You can roll back anyway");
    expect(jobStore.byId(refused.id)).toMatchObject({ errorCode: "restore.code-unrestorable", errorDetails: refused.errorDetails });
    expect(await checksums(schema)).toEqual(live);
    expect(await codeObjectsOf(schema)).toEqual(liveCode);

    const forced = await restore({ allowCodeFailures: true });
    expect(forced.status).toBe("succeeded");
    expect(forced.errorCode ?? null).toBeNull();
    const result = forced.result as unknown as CheckpointRestoreJobResult;
    expect(result.outcome).toBe("done-with-errors");
    expect(result.codeFailures?.map((f) => `${f.kind}:${f.name}:${f.error}`)).toEqual(["VIEW:a_rates:reads `zz_force_rates`.`rates`, which is outside this database"]);
    const safety = checkpoints.byId(result.safetyCheckpointId!)!;
    expect(safety.trigger).toBe("pre-restore");
    const note = forced.warnings.find((w) => w.startsWith("Rolled back anyway"))!;
    expect(note).toContain("are now missing from the live database: view a_rates");
    expect(note).toContain(`Their previous definitions are in checkpoint ${safety.shortHash}`);
    expect(await checksums(schema)).toEqual(wanted);
    expect(await codeObjectsOf(schema)).toEqual(["procedure:p_count", "trigger:orders_audit", "view:b_orders"]);
    expect(await select(schema, "SELECT id, total FROM b_orders")).toEqual([{ id: 1, total: 10 }]);
    const audits = (db.query("SELECT action, details FROM audit_log WHERE target = ? ORDER BY id").all(database.id) as {
      action: string;
      details: string;
    }[]).filter((a) => a.action === "checkpoint.restore");
    expect(audits.length).toBe(1);
    expect(JSON.parse(audits[0]!.details)).toMatchObject({ checkpointId: cp, forced: true, objects: ["view a_rates"], outcome: "done-with-errors" });
  }, 240_000);

  test("allowing code failures never overrides a table that does not match its checkpoint", async () => {
    const { database } = await makeDatabase(fx.owner);
    const schema = database.name;
    await populateRich(schema);
    const cp = (await createCheckpoint(database.id, { trigger: "manual" })).checkpointId!;
    await exec(schema, "INSERT INTO settings VALUES ('live', 'data')");
    const live = await checksums(schema);
    db.query("UPDATE checkpoint_entries SET checksum = checksum + 1 WHERE checkpoint_id = ? AND name = 'players'").run(cp);
    let error: Error | null = null;
    try {
      await restoreCheckpoint(database.id, cp, { userId: null, allowCodeFailures: true });
    } catch (err) {
      error = err as Error;
    }
    expect(error?.name).toBe("RestoreVerificationError");
    expect(error!.message).toContain("the contents of table players differ from what the checkpoint recorded");
    expect(await checksums(schema)).toEqual(live);
    expect(await managedSchemas()).toEqual([]);
  }, 240_000);

  test("a table defaulting to a sequence that no longer exists refuses with a way forward", async () => {
    const { database } = await makeDatabase(fx.owner);
    const schema = database.name;
    await exec(schema, "CREATE SEQUENCE s", "CREATE TABLE u (id INT NOT NULL DEFAULT NEXTVAL(s) PRIMARY KEY, v INT)", "INSERT INTO u (v) VALUES (1)");
    const cp = (await createCheckpoint(database.id, { trigger: "manual" })).checkpointId!;
    await exec(schema, "DROP TABLE u", "DROP SEQUENCE s", "CREATE TABLE other (id INT PRIMARY KEY)");
    await expect(restoreCheckpoint(database.id, cp, { userId: null })).rejects.toThrow(/CREATE SEQUENCE s/);
    expect(Object.keys(await checksums(schema))).toEqual(["other"]);
    await exec(schema, "CREATE SEQUENCE s");
    await restoreCheckpoint(database.id, cp, { userId: null });
    expect(await select(schema, "SELECT v FROM u")).toEqual([{ v: 1 }]);
  }, 240_000);

  test("a manual checkpoint can be verified by loading it, and the verification is recorded", async () => {
    const { database } = await makeDatabase(fx.owner);
    await populateRich(database.name);
    const r = await createCheckpoint(database.id, { trigger: "manual", verify: true });
    expect(r.verified).toBe(true);
    expect(checkpoints.byId(r.checkpointId!)!.verifiedAt).toBeGreaterThan(Date.now() - 60_000);
    expect(await managedSchemas()).toEqual([]);
  }, 240_000);

  test("deleting a checkpoint during its download does not cut the file short", async () => {
    const { database } = await makeDatabase(fx.owner);
    await populateRich(database.name);
    const cp = (await createCheckpoint(database.id, { trigger: "manual" })).checkpointId!;
    const entries = checkpoints.entries(cp);
    const stream = checkpointDownloadStream(database.name, checkpoints.byId(cp)!, entries);
    const reader = stream.getReader();
    const first = await reader.read();
    await deleteCheckpoint(database.id, cp);
    const parts: Uint8Array[] = [first.value!];
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      parts.push(value!);
    }
    const out = await gunzipOk(Buffer.concat(parts));
    expect(out.ok).toBe(true);
    for (const name of ["players", "matches", "settings", "audit"]) expect(out.text).toContain(`INSERT INTO \`${name}\``.slice(0, 13));
    expect(out.text).toContain("-- End of LambData checkpoint");
    await Bun.sleep(50);
    for (const e of entries) expect(await Bun.file(objectPath(database.id, e.objectHash)).exists()).toBe(false);
  }, 240_000);

  test("rolling back to an imported snapshot keeps the live database's events", async () => {
    const { database } = await makeDatabase(fx.owner);
    const schema = database.name;
    await exec(
      schema,
      "CREATE TABLE junk (id INT)",
      "CREATE EVENT ev_keep ON SCHEDULE EVERY 1 DAY STARTS '2030-01-01 00:00:00' DISABLE DO DELETE FROM junk",
    );
    const original = [
      "/*!40101 SET NAMES utf8mb4 */;",
      "CREATE DATABASE /*!32312 IF NOT EXISTS*/ `old_name` /*!40100 DEFAULT CHARACTER SET utf8mb4 */;",
      "USE `old_name`;",
      "CREATE TABLE `notes` (`id` int NOT NULL, PRIMARY KEY (`id`)) ENGINE=InnoDB;",
      "INSERT INTO `notes` VALUES (1);",
      "",
    ].join("\n");
    mkdirSync(env.snapshotsDir, { recursive: true });
    const createdAt = Date.UTC(2026, 0, 2, 3, 4, 5);
    const file = join(env.snapshotsDir, `${database.id}_${createdAt}.sql`);
    writeFileSync(file, original);
    const id = newId("snap");
    snapshots.insert({ id, databaseId: database.id, filePath: file, sizeBytes: original.length, createdAt, trigger: "manual" });
    await convertLegacySnapshots();
    await restoreCheckpoint(database.id, legacyCheckpointId(id), { userId: null });
    expect(Object.keys(await checksums(schema))).toEqual(["notes"]);
    expect(await codeObjectsOf(schema)).toEqual(["event:ev_keep"]);
  }, 240_000);
});
