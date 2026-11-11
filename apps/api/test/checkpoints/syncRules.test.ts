import { exec, makeDatabase, mariadbAvailable, select, setup, type Fixture } from "./helpers";
import { authHeaders } from "../harness/sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import mysql from "mysql2/promise";
import type { CheckpointListResponse, CheckpointPolicyResponse, JobResponse, SyncJobResult } from "@lambdata/shared";
import { buildApp } from "../../src/server";
import { createCheckpoint, getWorkingCopyStatus } from "../../src/checkpoints";
import { collectLiveStats } from "../../src/checkpoints/capture";
import { checkpointSwap } from "../../src/checkpoints/fencedSwap";
import { dueScheduledCheckpoints, isScheduledCheckpointDue, syncTakesAutomaticSlot } from "../../src/checkpoints/scheduler";
import { readObjectText } from "../../src/checkpoints/store";
import { baselineTables, sameTables } from "../../src/checkpoints/syncBaseline";
import { db } from "../../src/db/client";
import { checkpoints, syncBaselines, syncJobs } from "../../src/db/queries";
import { env } from "../../src/env";
import { waitForJob } from "../../src/jobs";
import { encryptSecret } from "../../src/util/crypto";
import { newId } from "../../src/util/id";
import { startSyncJob } from "../../src/workers/sync";

const HOUR = 60 * 60 * 1000;
const T = 300_000;
const realRun = checkpointSwap.run;

type Made = Awaited<ReturnType<typeof makeDatabase>>;

const SOURCE = [
  "CREATE TABLE parent (id INT AUTO_INCREMENT PRIMARY KEY, label VARCHAR(20), KEY by_label (label))",
  "CREATE TABLE child (id INT AUTO_INCREMENT PRIMARY KEY, parent_id INT, CONSTRAINT fk_parent FOREIGN KEY (parent_id) REFERENCES parent (id))",
  "INSERT INTO parent (label) VALUES ('a'), ('b')",
  "INSERT INTO child (parent_id) VALUES (1), (2)",
  "CREATE VIEW v_labels AS SELECT id, label FROM parent",
  "CREATE PROCEDURE p_count() SELECT COUNT(*) FROM parent",
  "CREATE TRIGGER child_touch BEFORE INSERT ON child FOR EACH ROW SET NEW.parent_id = COALESCE(NEW.parent_id, 1)",
];

function advance(databaseId: string, ms: number): void {
  db.query("UPDATE checkpoints SET created_at = created_at - ? WHERE database_id = ?").run(ms, databaseId);
  db.query("UPDATE checkpoint_schedule SET last_checked_at = last_checked_at - ? WHERE database_id = ?").run(ms, databaseId);
  db.query("UPDATE sync_jobs SET last_run_at = last_run_at - ? WHERE database_id = ? AND last_run_at IS NOT NULL").run(ms, databaseId);
}

function triggersOf(databaseId: string): string[] {
  return checkpoints.listForDatabase(databaseId).map((c) => c.trigger);
}

function count(databaseId: string, trigger: string): number {
  return triggersOf(databaseId).filter((t) => t === trigger).length;
}

describe.skipIf(!mariadbAvailable())("sync checkpoint rules", () => {
  let fx: Fixture;
  let app: ReturnType<typeof buildApp>;

  beforeAll(async () => {
    fx = await setup();
    app = buildApp();
  }, 180_000);

  afterAll(async () => {
    checkpointSwap.run = realRun;
    await fx?.instance.stop();
  }, 120_000);

  async function mirrorOf(opts: { versioned?: boolean; sourceSql?: string[] } = {}) {
    const source = await makeDatabase(fx.owner);
    await exec(source.database.name, ...(opts.sourceSql ?? SOURCE));
    const mirror = await makeDatabase(fx.owner, { kind: "mirror", versioned: opts.versioned ?? true });
    syncJobs.upsert({
      id: newId("sj"),
      databaseId: mirror.database.id,
      sourceKind: "mysql",
      sourceHost: "127.0.0.1",
      sourcePort: env.mariadbPort,
      sourceUser: source.credentials.user,
      passwordEnc: await encryptSecret(source.credentials.password),
      sourceDatabase: source.database.name,
      intervalSeconds: 3600,
      enabled: true,
    });
    return { source, mirror };
  }

  async function sync(id: string, opts: { manual?: boolean; checkpoint?: boolean; userId?: string | null } = {}) {
    const job = (await waitForJob(startSyncJob(id, opts.userId ?? null, opts).id))!;
    if (job.status !== "succeeded") throw new Error(`sync failed: ${job.error}`);
    return { job, result: job.result as unknown as SyncJobResult };
  }

  async function own(m: Made) {
    const c = await mysql.createConnection({
      host: "127.0.0.1",
      port: env.mariadbPort,
      user: m.credentials.user,
      password: m.credentials.password,
      database: m.database.name,
    });
    c.on("error", () => {});
    return c;
  }

  function setPolicy(id: string, patch: Partial<ReturnType<typeof checkpoints.policy>>) {
    checkpoints.setPolicy(id, { ...checkpoints.policy(id), ...patch });
  }

  test("hourly syncs over two simulated days record one automatic checkpoint a day and never take the fenced path", async () => {
    const { source, mirror } = await mirrorOf();
    const id = mirror.database.id;
    const first = await sync(id);
    expect(first.result).toMatchObject({ checkpointKind: "automatic", checkpointSkipped: null, manual: false, preSyncCheckpointId: null });
    const baseline = syncBaselines.get(id)!;
    expect(baseline.codeHash).not.toBeNull();
    expect(baseline.codeHash!.startsWith("unverified:")).toBe(false);
    const reader = await own(mirror);
    for (let hour = 1; hour <= 47; hour++) {
      advance(id, HOUR);
      await exec(source.database.name, `INSERT INTO parent (label) VALUES ('h${hour}')`);
      const { job, result } = await sync(id);
      const expectedKind = hour === 24 ? "automatic" : null;
      expect({ hour, kind: result.checkpointKind, pre: result.preSyncCheckpointId }).toEqual({ hour, kind: expectedKind, pre: null });
      if (hour !== 24) {
        expect(result.checkpointSkipped).toBe("not-due");
        expect(result.nextAutomaticDueAt).toBeGreaterThan(Date.now());
        expect(job.stage).toMatch(/^No checkpoint this time: the automatic checkpoint for this period \([0-9a-f]{7}\) already exists; the next one is due after \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC$/);
      }
      expect(job.warnings.filter((w) => /connection\(s\)/.test(w))).toEqual([]);
    }
    await reader.query("SELECT 1");
    await reader.end();
    expect(count(id, "sync")).toBe(2);
    expect(count(id, "pre-sync")).toBe(0);
    expect(await select(mirror.database.name, "SELECT COUNT(*) AS n FROM parent")).toEqual([{ n: "49" }]);
  }, 900_000);

  test("a local write between syncs is saved in a pre-sync checkpoint, and the status says it no longer matches the last sync", async () => {
    const { source, mirror } = await mirrorOf();
    const id = mirror.database.id;
    await sync(id);
    advance(id, HOUR);
    await exec(source.database.name, "INSERT INTO parent (label) VALUES ('second')");
    expect((await sync(id)).result.checkpointSkipped).toBe("not-due");
    const synced = await getWorkingCopyStatus(id, { refresh: true });
    expect(synced).toMatchObject({ state: "dirty", matchesLastSync: true });
    const c = await own(mirror);
    await c.query("INSERT INTO parent (label) VALUES ('local-edit')");
    await c.end();
    expect(await getWorkingCopyStatus(id, { refresh: true })).toMatchObject({ state: "dirty", matchesLastSync: false });
    advance(id, HOUR);
    const { result } = await sync(id);
    expect(result.preSyncCheckpointId).not.toBeNull();
    const entry = checkpoints.entries(result.preSyncCheckpointId!).find((e) => e.name === "parent")!;
    expect(await readObjectText(id, entry.objectHash)).toContain("local-edit");
  }, T);

  test("the baseline is what the staging copy held, so a write right after the swap is not absorbed into it", async () => {
    const { source, mirror } = await mirrorOf();
    const id = mirror.database.id;
    await sync(id);
    advance(id, HOUR);
    await exec(source.database.name, "INSERT INTO parent (label) VALUES ('next')", "ALTER TABLE parent AUTO_INCREMENT = 900");
    let rightAfter: ReturnType<typeof baselineTables> | null = null;
    checkpointSwap.run = async (opts) => {
      const out = await realRun(opts);
      rightAfter = baselineTables((await collectLiveStats(mirror.database.name, false)).tables);
      const c = await own(mirror);
      await c.query("INSERT INTO child (parent_id) VALUES (2)");
      await c.end();
      return out;
    };
    try {
      await sync(id);
    } finally {
      checkpointSwap.run = realRun;
    }
    const stored = syncBaselines.get(id)!;
    expect(rightAfter).not.toBeNull();
    expect(sameTables(rightAfter!, stored.tables)).toBe(true);
    expect(stored.tables.find((t) => t.name === "parent")!.autoIncrement).toBe(900);
    expect(stored.tables.every((t) => t.schemaHash !== null)).toBe(true);
    expect((await getWorkingCopyStatus(id, { refresh: true })).matchesLastSync).toBe(false);
    advance(id, HOUR);
    await exec(source.database.name, "INSERT INTO parent (label) VALUES ('after')");
    const { result } = await sync(id);
    expect(result.preSyncCheckpointId).not.toBeNull();
    expect(checkpoints.entries(result.preSyncCheckpointId!).find((e) => e.name === "child")!.rowCount).toBe(3);
  }, T);

  test("manual syncs add an additional checkpoint only when asked, and never take the automatic slot", async () => {
    const { source, mirror } = await mirrorOf();
    const id = mirror.database.id;
    const extra = await sync(id, { manual: true, checkpoint: true, userId: fx.owner.id });
    expect(extra.result).toMatchObject({ manual: true, checkpointKind: "additional", checkpointSkipped: null });
    const cp = checkpoints.byId(extra.result.checkpointId!)!;
    expect(cp).toMatchObject({ trigger: "manual", createdByUserId: fx.owner.id, message: `After manual sync from 127.0.0.1/${source.database.name}` });
    expect(extra.job.stage).toBe(`Synced and saved additional checkpoint ${cp.shortHash}`);
    expect(isScheduledCheckpointDue(id, Date.now())).toBe(true);
    expect((await sync(id, { manual: true, checkpoint: true, userId: fx.owner.id })).result).toMatchObject({ checkpointKind: null, checkpointSkipped: "unchanged" });
    await exec(source.database.name, "INSERT INTO parent (label) VALUES ('m2')");
    expect((await sync(id, { manual: true, checkpoint: false, userId: fx.owner.id })).result).toMatchObject({ checkpointKind: null, checkpointSkipped: "declined" });
    setPolicy(id, { manualSyncCheckpoint: "never" });
    await exec(source.database.name, "INSERT INTO parent (label) VALUES ('m3')");
    expect((await sync(id, { manual: true, userId: fx.owner.id })).result.checkpointSkipped).toBe("declined");
    expect(isScheduledCheckpointDue(id, Date.now())).toBe(true);
    expect(count(id, "sync")).toBe(0);
    const automatic = await sync(id);
    expect(automatic.result.checkpointKind).toBe("automatic");
    expect(count(id, "manual")).toBe(1);
  }, T);

  test("the run route takes an empty body, and policy always adds a checkpoint without being asked", async () => {
    const { source, mirror } = await mirrorOf();
    const id = mirror.database.id;
    const headers = await authHeaders(fx.owner, { "Content-Type": "application/json" });
    const put = await app.request(`/api/databases/${id}/checkpoints/policy`, { method: "PUT", headers, body: JSON.stringify({ manualSyncCheckpoint: "always" }) });
    expect(put.status).toBe(200);
    const policy = (await put.json()) as CheckpointPolicyResponse;
    expect(policy.policy.manualSyncCheckpoint).toBe("always");
    expect(policy.schedule).toEqual({ lastAutomaticAt: null, nextDueAt: expect.any(Number) });
    const bad = await app.request(`/api/databases/${id}/checkpoints/policy`, { method: "PUT", headers, body: JSON.stringify({ manualSyncCheckpoint: "sometimes" }) });
    expect(bad.status).toBe(400);
    const run = await app.request(`/api/databases/${id}/sync/run`, { method: "POST", headers });
    expect(run.status).toBe(202);
    const job = (await waitForJob(((await run.json()) as JobResponse).job.id))!;
    expect(job.result).toMatchObject({ manual: true, checkpointKind: "additional" });
    await exec(source.database.name, "INSERT INTO parent (label) VALUES ('r2')");
    const declined = await app.request(`/api/databases/${id}/sync/run`, { method: "POST", headers, body: JSON.stringify({ checkpoint: false }) });
    const second = (await waitForJob(((await declined.json()) as JobResponse).job.id))!;
    expect(second.result).toMatchObject({ manual: true, checkpointSkipped: "declined" });
    const list = (await (await app.request(`/api/databases/${id}/checkpoints`, { headers })).json()) as CheckpointListResponse;
    expect(list.policy.manualSyncCheckpoint).toBe("always");
    expect(list.schedule?.lastAutomaticAt).toBeNull();
  }, T);

  test("interval 0 records no automatic checkpoints; with checkpoint after sync off the scheduler takes the slot", async () => {
    const off = await mirrorOf();
    setPolicy(off.mirror.database.id, { autoIntervalHours: 0 });
    const r = await sync(off.mirror.database.id);
    expect(r.result).toMatchObject({ checkpointKind: null, checkpointSkipped: "automatic-off", nextAutomaticDueAt: null });
    expect(r.job.stage).toBe("Synced; automatic checkpoints are off for this mirror");
    expect(triggersOf(off.mirror.database.id)).toEqual([]);
    const later = await mirrorOf();
    const id = later.mirror.database.id;
    setPolicy(id, { checkpointOnSync: false });
    expect((await sync(id)).result).toMatchObject({ checkpointKind: null, checkpointSkipped: "after-sync-off" });
    expect(syncBaselines.get(id)).toBeNull();
    expect(syncTakesAutomaticSlot(id)).toBe(false);
    expect(await dueScheduledCheckpoints()).toContain(id);
  }, T);

  test("the scheduler defers to a healthy sync and takes over when it is disabled, failing or overdue", async () => {
    const { mirror } = await mirrorOf();
    const id = mirror.database.id;
    setPolicy(id, { autoIntervalHours: 1 });
    await sync(id);
    advance(id, 2 * HOUR - 1);
    db.query("UPDATE sync_jobs SET last_run_at = ? WHERE database_id = ?").run(Date.now() - 30 * 60 * 1000, id);
    expect(isScheduledCheckpointDue(id, Date.now())).toBe(true);
    expect(syncTakesAutomaticSlot(id)).toBe(true);
    expect(await dueScheduledCheckpoints()).not.toContain(id);
    const job = syncJobs.byDatabaseId(id)!;
    db.query("UPDATE sync_jobs SET enabled = 0 WHERE database_id = ?").run(id);
    expect(await dueScheduledCheckpoints()).toContain(id);
    db.query("UPDATE sync_jobs SET enabled = 1, last_status = 'error' WHERE database_id = ?").run(id);
    expect(await dueScheduledCheckpoints()).toContain(id);
    db.query("UPDATE sync_jobs SET last_status = 'ok', last_run_at = ? WHERE database_id = ?").run(Date.now() - 2 * job.intervalSeconds * 1000 - 60_000, id);
    expect(await dueScheduledCheckpoints()).toContain(id);
  }, T);

  test("scheduled and sync checkpoints share one retention count and additional ones survive it", async () => {
    const { database } = await makeDatabase(fx.owner);
    const s = database.name;
    setPolicy(database.id, { autoRetention: 2 });
    await exec(s, "CREATE TABLE t (id INT PRIMARY KEY)");
    const made: string[] = [];
    for (const [i, trigger] of (["scheduled", "sync", "manual", "scheduled", "sync"] as const).entries()) {
      await exec(s, `INSERT INTO t VALUES (${i})`);
      made.push((await createCheckpoint(database.id, { trigger, userId: trigger === "manual" ? fx.owner.id : null })).checkpointId!);
      await Bun.sleep(5);
    }
    const left = checkpoints.listForDatabase(database.id).map((c) => c.id);
    const [a, b, extra, c, d] = made as [string, string, string, string, string];
    expect(left).toContain(extra);
    expect(left.filter((x) => [a, b, c, d].includes(x))).toEqual([d, c]);
  }, T);

  test("a mirror with sync checkpoints from the old behaviour keeps them and follows the new rules from the next sync", async () => {
    const { source, mirror } = await mirrorOf();
    const id = mirror.database.id;
    await sync(id);
    for (let i = 0; i < 2; i++) {
      advance(id, HOUR);
      await exec(source.database.name, `INSERT INTO parent (label) VALUES ('old${i}')`);
      await sync(id, { manual: true, checkpoint: false });
      await createCheckpoint(id, { trigger: "sync", message: "Synced from an older version" });
    }
    syncBaselines.remove(id);
    const before = checkpoints.listForDatabase(id).map((c) => c.id);
    expect(before.length).toBe(3);
    advance(id, HOUR);
    await exec(source.database.name, "INSERT INTO parent (label) VALUES ('new')");
    const first = await sync(id);
    expect(first.result).toMatchObject({ checkpointSkipped: "not-due", preSyncCheckpointId: null });
    advance(id, HOUR);
    await exec(source.database.name, "INSERT INTO parent (label) VALUES ('newer')");
    const second = await sync(id);
    expect(second.result).toMatchObject({ checkpointSkipped: "not-due", preSyncCheckpointId: null });
    for (const old of before) expect(checkpoints.exists(old)).toBe(true);
    expect(count(id, "sync")).toBe(3);
  }, T);
});
