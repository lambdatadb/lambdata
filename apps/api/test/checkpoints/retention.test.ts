import { exec, finished, makeDatabase, mariadbAvailable, setup, type Fixture } from "./helpers";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createCheckpoint, deleteCheckpoint } from "../../src/checkpoints";
import { applyRetention, collectGarbage } from "../../src/checkpoints/manage";
import {
  dueScheduledCheckpoints,
  isScheduledCheckpointDue,
  lastAutomaticCheck,
  runScheduledCheckpoints,
  startScheduledCheckpoint,
} from "../../src/checkpoints/scheduler";
import { checkpointDir, objectPath } from "../../src/checkpoints/store";
import { checkpoints, databases, snapshots } from "../../src/db/queries";
import { db } from "../../src/db/client";
import { newId } from "../../src/util/id";

function objectFiles(databaseId: string): string[] {
  const root = join(checkpointDir(databaseId), "objects");
  if (!existsSync(root)) return [];
  return readdirSync(root).flatMap((p) => readdirSync(join(root, p)));
}

async function change(schema: string, n: number): Promise<void> {
  await exec(schema, `INSERT INTO t VALUES (${n}, 'row ${n}')`);
}

describe.skipIf(!mariadbAvailable())("retention, deletion and scheduling", () => {
  let fx: Fixture;

  beforeAll(async () => {
    fx = await setup();
  }, 180_000);

  afterAll(async () => {
    await fx?.instance.stop();
  }, 120_000);

  test("deleting re-parents children, moves the base to the parent and removes unreferenced objects", async () => {
    const { database } = await makeDatabase(fx.owner);
    await exec(database.name, "CREATE TABLE t (id INT PRIMARY KEY, v VARCHAR(20))", "CREATE TABLE keep (id INT)");
    const a = (await createCheckpoint(database.id, { trigger: "manual" })).checkpointId!;
    await change(database.name, 1);
    const b = (await createCheckpoint(database.id, { trigger: "manual" })).checkpointId!;
    await change(database.name, 2);
    const c = (await createCheckpoint(database.id, { trigger: "manual" })).checkpointId!;
    const bOnly = checkpoints.entries(b).find((e) => e.name === "t")!.objectHash;
    const shared = checkpoints.entries(b).find((e) => e.name === "keep")!.objectHash;
    expect(existsSync(objectPath(database.id, bOnly))).toBe(true);

    await deleteCheckpoint(database.id, b);
    expect(checkpoints.byId(c)!.parentId).toBe(a);
    expect(existsSync(objectPath(database.id, bOnly))).toBe(false);
    expect(existsSync(objectPath(database.id, shared))).toBe(true);

    await deleteCheckpoint(database.id, c);
    expect(databases.byId(database.id)!.baseCheckpointId).toBe(a);
    await deleteCheckpoint(database.id, a);
    expect(databases.byId(database.id)!.baseCheckpointId).toBeNull();
    expect(objectFiles(database.id)).toEqual([]);
  }, 180_000);

  test("retention keeps the newest automatic checkpoints and never touches manual, pinned, legacy or base ones", async () => {
    const { database } = await makeDatabase(fx.owner);
    await exec(database.name, "CREATE TABLE t (id INT PRIMARY KEY, v VARCHAR(20))");
    checkpoints.setPolicy(database.id, { autoIntervalHours: 24, autoRetention: 2, checkpointOnSync: true });
    const manual = (await createCheckpoint(database.id, { trigger: "manual" })).checkpointId!;
    const auto: string[] = [];
    for (let i = 1; i <= 3; i++) {
      await change(database.name, i);
      auto.push((await createCheckpoint(database.id, { trigger: "scheduled" })).checkpointId!);
      if (i === 1) checkpoints.update(auto[0]!, { pinned: true });
    }
    for (let i = 4; i <= 5; i++) {
      await change(database.name, i);
      auto.push((await createCheckpoint(database.id, { trigger: i === 4 ? "pre-restore" : "sync" })).checkpointId!);
    }
    const ids = checkpoints.listForDatabase(database.id).map((c) => c.id);
    expect(ids.sort()).toEqual([manual, auto[0]!, auto[2]!, auto[3]!, auto[4]!].sort());

    databases.setBaseCheckpoint(database.id, auto[3]!);
    checkpoints.setPolicy(database.id, { autoIntervalHours: 24, autoRetention: 1, checkpointOnSync: true });
    await applyRetention(database.id);
    const left = checkpoints.listForDatabase(database.id).map((c) => c.id);
    expect(left.sort()).toEqual([manual, auto[0]!, auto[3]!, auto[4]!].sort());

    for (let i = 6; i <= 8; i++) {
      await change(database.name, i);
      await createCheckpoint(database.id, { trigger: i === 8 ? "pre-import" : "pre-restore" });
    }
    const after = checkpoints.listForDatabase(database.id);
    expect(after.filter((c) => c.trigger === "scheduled").map((c) => c.id)).toEqual([auto[0]!]);
    expect(after.filter((c) => c.trigger === "sync").map((c) => c.id)).toEqual([auto[4]!]);
    expect(after.filter((c) => ["pre-restore", "pre-import", "pre-sync"].includes(c.trigger)).length).toBe(1);
    for (const id of left) {
      for (const e of checkpoints.entries(id)) expect(existsSync(objectPath(database.id, e.objectHash))).toBe(true);
    }
  }, 180_000);

  test("garbage collection removes temp files and orphaned objects only", async () => {
    const { database } = await makeDatabase(fx.owner);
    await exec(database.name, "CREATE TABLE t (id INT PRIMARY KEY, v VARCHAR(20))");
    const id = (await createCheckpoint(database.id, { trigger: "manual" })).checkpointId!;
    const orphan = "ab".padEnd(64, "0");
    mkdirSync(join(checkpointDir(database.id), "objects", "ab"), { recursive: true });
    writeFileSync(objectPath(database.id, orphan), "x");
    mkdirSync(join(checkpointDir(database.id), "tmp"), { recursive: true });
    writeFileSync(join(checkpointDir(database.id), "tmp", "partial.gz"), "x");
    expect(await collectGarbage(database.id)).toBe(1);
    expect(existsSync(objectPath(database.id, orphan))).toBe(false);
    expect(existsSync(join(checkpointDir(database.id), "tmp"))).toBe(false);
    for (const e of checkpoints.entries(id)) expect(existsSync(objectPath(database.id, e.objectHash))).toBe(true);
  }, 120_000);

  test("every database gets a daily automatic checkpoint by default, and an unchanged one still counts as checked", async () => {
    const { database } = await makeDatabase(fx.owner);
    await exec(database.name, "CREATE TABLE t (id INT PRIMARY KEY, v VARCHAR(20))");
    const now = Date.now();
    expect(isScheduledCheckpointDue(database.id, now)).toBe(true);
    const jobId = startScheduledCheckpoint(database.id)!;
    const job = await finished(jobId);
    expect(job.status).toBe("succeeded");
    expect(job.result).toMatchObject({ unchanged: false });
    expect(isScheduledCheckpointDue(database.id, Date.now())).toBe(false);
    expect(isScheduledCheckpointDue(database.id, Date.now() + 24 * 3_600_000)).toBe(true);

    db.query("UPDATE checkpoints SET created_at = created_at - ? WHERE database_id = ?").run(25 * 3_600_000, database.id);
    db.query("DELETE FROM checkpoint_schedule WHERE database_id = ?").run(database.id);
    expect(isScheduledCheckpointDue(database.id, Date.now())).toBe(true);
    const again = await finished(startScheduledCheckpoint(database.id)!);
    expect(again.result).toEqual({ checkpointId: null, unchanged: true });
    expect(lastAutomaticCheck(database.id)).toBeGreaterThan(Date.now() - 60_000);
    expect(isScheduledCheckpointDue(database.id, Date.now())).toBe(false);

    checkpoints.setPolicy(database.id, { autoIntervalHours: 0, autoRetention: 7, checkpointOnSync: true });
    expect(isScheduledCheckpointDue(database.id, Date.now() + 1000 * 3_600_000)).toBe(false);
  }, 180_000);

  test("the scheduler waits only for that database's legacy conversion, skips empty databases and runs one at a time", async () => {
    const { database } = await makeDatabase(fx.owner);
    await exec(database.name, "CREATE TABLE t (id INT PRIMARY KEY, v VARCHAR(20))");
    const empty = (await makeDatabase(fx.owner)).database;
    const snap = newId("snap");
    snapshots.insert({ id: snap, databaseId: database.id, filePath: "/x/y.sql", sizeBytes: 1, createdAt: 1, trigger: "manual" });
    expect(await dueScheduledCheckpoints()).not.toContain(database.id);
    expect(await dueScheduledCheckpoints()).not.toContain(empty.id);
    snapshots.delete(snap);
    expect(await dueScheduledCheckpoints()).toContain(database.id);
    const started = await runScheduledCheckpoints();
    expect(started.length).toBeGreaterThanOrEqual(1);
    const jobs = await Promise.all(started.map((id) => finished(id)));
    for (let i = 1; i < jobs.length; i++) expect(jobs[i]!.startedAt!).toBeGreaterThanOrEqual(jobs[i - 1]!.finishedAt!);
    expect(checkpoints.lastCreatedAt(database.id, "scheduled")).not.toBeNull();
    expect(checkpoints.listForDatabase(empty.id)).toEqual([]);
    const second = await runScheduledCheckpoints();
    for (const id of second) await finished(id);
    expect(second.length).toBe(0);
  }, 240_000);
});
