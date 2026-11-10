import {
  checksums,
  codeObjectsOf,
  exec,
  finished,
  makeDatabase,
  mariadbAvailable,
  mariadbClient,
  populateRich,
  rootQuery,
  setup,
  type Fixture,
} from "./helpers";
import { authHeaders, seedUser, type SeededUser } from "../harness/sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type {
  CheckpointDetailResponse,
  CheckpointDiffResponse,
  CheckpointListResponse,
  CheckpointStatusResponse,
  JobResponse,
} from "@lambdata/shared";
import { buildApp } from "../../src/server";
import { startJob, waitForJob } from "../../src/jobs";
import { audit } from "../../src/db/queries";
import { db } from "../../src/db/client";

describe.skipIf(!mariadbAvailable())("checkpoint routes", () => {
  let fx: Fixture;
  let app: ReturnType<typeof buildApp>;
  let viewer: SeededUser;
  let otherOwner: SeededUser;

  async function call(user: SeededUser, path: string, init: RequestInit = {}): Promise<Response> {
    const headers = await authHeaders(user, { "Content-Type": "application/json" });
    return app.request(path, { ...init, headers: { ...headers, ...(init.headers as Record<string, string>) } });
  }

  async function json<T>(res: Response, status = 200): Promise<T> {
    const body = await res.text();
    if (res.status !== status) throw new Error(`expected ${status}, got ${res.status}: ${body}`);
    return JSON.parse(body) as T;
  }

  async function runJob(res: Response) {
    const { job } = await json<JobResponse>(res, 202);
    const done = await finished(job.id);
    if (done.status !== "succeeded") throw new Error(`job failed: ${done.error}`);
    return done;
  }

  beforeAll(async () => {
    fx = await setup();
    app = buildApp();
    viewer = seedUser("viewer");
    otherOwner = seedUser("db_owner");
  }, 180_000);

  afterAll(async () => {
    await fx?.instance.stop();
  }, 120_000);

  test("create, list, detail, status, diff, edit, pin and delete", async () => {
    const { database } = await makeDatabase(fx.owner, { versioned: true });
    const base = `/api/databases/${database.id}/checkpoints`;
    await populateRich(database.name);

    const empty = await json<CheckpointListResponse>(await call(viewer, base));
    expect(empty.checkpoints).toEqual([]);
    expect(empty.policy).toEqual({ versioned: true, autoIntervalHours: 24, autoRetention: 7, checkpointOnSync: true });
    const none = await json<CheckpointStatusResponse>(await call(viewer, `${base}/status`));
    expect(none.status.state).toBe("no-checkpoint");

    expect((await call(viewer, base, { method: "POST", body: "{}" })).status).toBe(403);
    expect((await call(otherOwner, base, { method: "POST", body: "{}" })).status).toBe(403);
    const first = await runJob(await call(fx.owner, base, { method: "POST", body: JSON.stringify({ message: "First" }) }));
    expect(first.kind).toBe("checkpoint.create");
    expect(first.result).toMatchObject({ unchanged: false });
    const firstId = String(first.result!.checkpointId);

    const unchanged = await runJob(await call(fx.owner, base, { method: "POST", body: "{}" }));
    expect(unchanged.result).toEqual({ checkpointId: null, unchanged: true });

    const clean = await json<CheckpointStatusResponse>(await call(viewer, `${base}/status`));
    expect(clean.status.state).toBe("clean");
    expect(clean.status.baseCheckpointId).toBe(firstId);

    await exec(database.name, "INSERT INTO settings VALUES ('new', 'row')", "CREATE TABLE fresh (id INT PRIMARY KEY)");
    const cached = await json<CheckpointStatusResponse>(await call(viewer, `${base}/status`));
    expect(cached.status.state).toBe("clean");
    const dirty = await json<CheckpointStatusResponse>(await call(viewer, `${base}/status?refresh=1`));
    expect(dirty.status.state).toBe("dirty");
    expect(dirty.status.diff!.tables).toEqual([
      { name: "fresh", change: "added", schemaChanged: true, rowsBefore: null, rowsAfter: 0 },
      { name: "settings", change: "modified", schemaChanged: false, rowsBefore: 3, rowsAfter: 4 },
    ]);
    expect(dirty.status.diff!.rowDelta).toBe(1);

    const second = await runJob(await call(fx.owner, base, { method: "POST", body: JSON.stringify({ message: "Second" }) }));
    const secondId = String(second.result!.checkpointId);
    const list = await json<CheckpointListResponse>(await call(viewer, base));
    expect(list.checkpoints.map((c) => c.id)).toEqual([secondId, firstId]);
    expect(list.checkpoints[0]!.isBase).toBe(true);
    expect(list.checkpoints[0]!.parentId).toBe(firstId);
    expect(list.checkpoints[0]!.createdByDisplayName).toBeTruthy();
    expect(list.storage.checkpoints).toBe(2);
    expect(list.storage.storedBytes).toBeLessThan(list.checkpoints[0]!.storedBytes + list.checkpoints[1]!.storedBytes);
    expect(list.storage.logicalBytes).toBe(list.checkpoints[0]!.logicalBytes + list.checkpoints[1]!.logicalBytes);

    const detail = await json<CheckpointDetailResponse>(await call(viewer, `${base}/${secondId}`));
    expect(detail.entries.map((e) => `${e.kind}:${e.name}`)).toEqual([
      "code:code",
      "table:audit",
      "table:fresh",
      "table:matches",
      "table:players",
      "table:settings",
    ]);
    expect(detail.diffFromParent!.tables.map((t) => `${t.change}:${t.name}`)).toEqual(["added:fresh", "modified:settings"]);
    expect(detail.diffFromParent!.unchangedTables).toBe(3);
    expect(detail.diffFromParent!.codeChanged).toBe(false);

    const vsFirst = await json<CheckpointDiffResponse>(await call(viewer, `${base}/${secondId}/diff?against=${firstId}`));
    expect(vsFirst.diff.fromId).toBe(firstId);
    expect(vsFirst.diff.tables.length).toBe(2);
    await exec(database.name, "DROP TABLE fresh");
    const vsWorking = await json<CheckpointDiffResponse>(await call(viewer, `${base}/${secondId}/diff?against=working&refresh=1`));
    expect(vsWorking.diff.toId).toBe("working");
    expect(vsWorking.diff.tables).toEqual([
      { name: "fresh", change: "removed", schemaChanged: true, rowsBefore: 0, rowsAfter: null },
    ]);
    expect((await call(viewer, `${base}/nope/diff?against=parent`)).status).toBe(404);

    const patched = await json<{ checkpoint: { message: string; pinned: boolean } }>(
      await call(fx.owner, `${base}/${firstId}`, { method: "PATCH", body: JSON.stringify({ message: "Renamed", pinned: true }) }),
    );
    expect(patched.checkpoint).toMatchObject({ message: "Renamed", pinned: true });
    expect((await call(viewer, `${base}/${firstId}`, { method: "PATCH", body: JSON.stringify({ pinned: false }) })).status).toBe(403);
    expect((await call(fx.owner, `${base}/${firstId}`, { method: "PATCH", body: "{}" })).status).toBe(400);

    const policy = await json<{ policy: unknown }>(
      await call(fx.owner, `${base}/policy`, {
        method: "PUT",
        body: JSON.stringify({ autoIntervalHours: 6, autoRetention: 3, checkpointOnSync: false, versioned: false }),
      }),
    );
    expect(policy.policy).toEqual({ versioned: false, autoIntervalHours: 6, autoRetention: 3, checkpointOnSync: false });
    expect((await call(fx.owner, `${base}/policy`, { method: "PUT", body: JSON.stringify({ autoRetention: 0 }) })).status).toBe(400);
    expect((await call(fx.owner, `${base}/policy`, { method: "PUT", body: JSON.stringify({ bogus: 1 }) })).status).toBe(400);

    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const blocker = startJob({ kind: "sync.run", databaseId: database.id, userId: null }, () => gate);
    try {
      const conflict = await call(fx.owner, `${base}/${firstId}`, { method: "DELETE" });
      expect(conflict.status).toBe(409);
      expect(((await conflict.json()) as { jobId: string }).jobId).toBe(blocker.id);
      expect((await call(fx.owner, base, { method: "POST", body: "{}" })).status).toBe(409);
    } finally {
      release();
      await waitForJob(blocker.id);
    }

    expect((await call(fx.owner, `${base}/${secondId}`, { method: "DELETE" })).status).toBe(200);
    const after = await json<CheckpointListResponse>(await call(viewer, base));
    expect(after.checkpoints.map((c) => c.id)).toEqual([firstId]);
    expect(after.checkpoints[0]!.isBase).toBe(true);
    const actions = (db.query("SELECT action FROM audit_log WHERE target = ? ORDER BY id").all(database.id) as { action: string }[]).map(
      (r) => r.action,
    );
    expect(actions).toContain("checkpoint.create");
    expect(actions).toContain("checkpoint.delete");
    expect(actions).toContain("checkpoint.policy");
    void audit;
  }, 240_000);

  test("restore is owner-only and runs as a job", async () => {
    const { database } = await makeDatabase(fx.owner);
    const base = `/api/databases/${database.id}/checkpoints`;
    await populateRich(database.name);
    const sums = await checksums(database.name);
    const created = await runJob(await call(fx.owner, base, { method: "POST", body: "{}" }));
    const id = String(created.result!.checkpointId);
    await exec(database.name, "DELETE FROM players");
    expect((await call(viewer, `${base}/${id}/restore`, { method: "POST" })).status).toBe(403);
    expect((await call(otherOwner, `${base}/${id}/restore`, { method: "POST" })).status).toBe(403);
    const job = await runJob(await call(fx.owner, `${base}/${id}/restore`, { method: "POST" }));
    expect(job.kind).toBe("checkpoint.restore");
    expect(job.result!.restoredCheckpointId).toBe(id);
    expect(typeof job.result!.safetyCheckpointId).toBe("string");
    expect(await checksums(database.name)).toEqual(sums);
  }, 240_000);

  test("a download loads into an empty schema with the plain client and reproduces every checksum", async () => {
    const { database } = await makeDatabase(fx.owner);
    await populateRich(database.name);
    await exec(database.name, "CREATE TABLE `odd name ü` (id INT PRIMARY KEY, t TEXT)", "INSERT INTO `odd name ü` VALUES (1, 'x')");
    const sums = await checksums(database.name);
    const code = await codeObjectsOf(database.name);
    const base = `/api/databases/${database.id}/checkpoints`;
    const created = await runJob(await call(fx.owner, base, { method: "POST", body: JSON.stringify({ message: "line1\n-- DROP DATABASE x" }) }));
    const id = String(created.result!.checkpointId);
    const res = await call(viewer, `${base}/${id}/download`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/gzip");
    const detail = await json<CheckpointDetailResponse>(await call(viewer, `${base}/${id}`));
    expect(res.headers.get("content-disposition")).toBe(
      `attachment; filename="${database.name}-${detail.checkpoint.shortHash}.sql.gz"`,
    );
    const gz = new Uint8Array(await res.arrayBuffer());
    const gunzip = Bun.spawn(["gunzip", "-c"], { stdin: gz, stdout: "pipe", stderr: "pipe" });
    const sql = new Uint8Array(await new Response(gunzip.stdout).arrayBuffer());
    expect(await gunzip.exited).toBe(0);
    const text = new TextDecoder().decode(sql);
    expect(text).not.toContain("enable the sandbox mode");
    expect(text).not.toMatch(/^CREATE DATABASE/m);
    expect(text).not.toMatch(/^USE /m);
    expect(text).toContain("-- Message: line1 -- DROP DATABASE x");

    const target = `dl_${database.name}`.slice(0, 60);
    await rootQuery(`CREATE DATABASE \`${target}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
    try {
      const load = await mariadbClient(target, sql);
      expect(load.stderr).toBe("");
      expect(load.exit).toBe(0);
      expect(await checksums(target)).toEqual(sums);
      expect(await codeObjectsOf(target)).toEqual(code);
    } finally {
      await rootQuery(`DROP DATABASE IF EXISTS \`${target}\``);
    }
    const actions = (db.query("SELECT action FROM audit_log WHERE target = ?").all(database.id) as { action: string }[]).map(
      (r) => r.action,
    );
    expect(actions).toContain("checkpoint.download");
  }, 240_000);
});
