import { exec, makeDatabase, mariadbAvailable, setup, type Fixture } from "./helpers";
import { authHeaders, seedUser, type SeededUser } from "../harness/sqlite";
import { useFakeTailscale } from "../network/helpers";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CheckpointListResponse, DashboardVitals } from "@lambdata/shared";
import { buildApp } from "../../src/server";
import { env } from "../../src/env";
import { checkpoints, databases, settings, snapshots, syncJobs } from "../../src/db/queries";
import { db } from "../../src/db/client";
import { provisionDatabase } from "../../src/databases/provision";
import {
  convertedDir,
  convertLegacySnapshots,
  legacyCheckpointId,
  removeExpiredOriginals,
  CONVERTED_KEEP_MS,
} from "../../src/checkpoints/startup";
import { dueScheduledCheckpoints, runScheduledCheckpoints } from "../../src/checkpoints/scheduler";
import { runDueSyncs } from "../../src/workers/sync";
import { encryptSecret } from "../../src/util/crypto";
import { newId } from "../../src/util/id";
import { diskProbe, setCheckpointCeilings } from "../../src/util/disk";
import { announceSetupToken, expireSetupToken } from "../../src/auth/setupToken";

const REMOTE = { server: { requestIP: () => ({ address: "203.0.113.9", family: "IPv4", port: 40100 }) } };

describe.skipIf(!mariadbAvailable())("upgrade and day-to-day operations", () => {
  let fx: Fixture;
  let app: ReturnType<typeof buildApp>;
  let owner: SeededUser;

  async function call(user: SeededUser, path: string, init: RequestInit = {}, server?: object): Promise<Response> {
    const headers = await authHeaders(user, { "Content-Type": "application/json" });
    return app.request(path, { ...init, headers: { ...headers, ...(init.headers as Record<string, string>) } }, server);
  }

  beforeAll(async () => {
    fx = await setup();
    app = buildApp();
    owner = seedUser("db_owner");
  }, 180_000);

  afterAll(async () => {
    await fx?.instance.stop();
  }, 120_000);

  test("one snapshot that cannot be converted affects only itself, is shown in history and health, and is retried", async () => {
    const stuck = await makeDatabase(fx.owner);
    const healthy = await makeDatabase(fx.owner);
    await exec(healthy.database.name, "CREATE TABLE t (id INT PRIMARY KEY)");
    await exec(stuck.database.name, "CREATE TABLE t (id INT PRIMARY KEY)");
    mkdirSync(env.snapshotsDir, { recursive: true });
    const createdAt = 1_700_000_000_000;
    const file = join(env.snapshotsDir, `${stuck.database.id}_${createdAt}.sql`);
    writeFileSync(file, "CREATE TABLE x (id INT);\n");
    chmodSync(file, 0o000);
    const id = newId("snap");
    snapshots.insert({ id, databaseId: stuck.database.id, filePath: file, sizeBytes: 25, createdAt, trigger: "scheduled" });
    try {
      const conversion = await convertLegacySnapshots();
      expect(conversion.failed).toBeGreaterThanOrEqual(1);
      const due = await dueScheduledCheckpoints();
      expect(due).toContain(healthy.database.id);
      expect(due).toContain(stuck.database.id);

      const list = (await (await call(fx.owner, `/api/databases/${stuck.database.id}/checkpoints`)).json()) as CheckpointListResponse;
      expect(list.unconverted?.length).toBe(1);
      expect(list.unconverted![0]).toMatchObject({ snapshotId: id, createdAt, trigger: "scheduled", attempts: 1 });
      expect(list.unconverted![0]!.reason).toMatch(/permission|denied|EACCES/i);
      const health = (await (await call(fx.owner, "/api/health/detail")).json()) as { checkpoints: { unconvertedSnapshots: number; lastConversionError: string | null } };
      expect(health.checkpoints.unconvertedSnapshots).toBeGreaterThanOrEqual(1);
      expect(health.checkpoints.lastConversionError).not.toBeNull();
    } finally {
      chmodSync(file, 0o600);
    }
    await convertLegacySnapshots();
    expect(snapshots.byId(id)).toBeNull();
    expect(checkpoints.byId(legacyCheckpointId(id))).not.toBeNull();
    expect(checkpoints.conversionFailures(stuck.database.id)).toEqual([]);
    expect(existsSync(file)).toBe(false);
    expect(existsSync(join(convertedDir(), `${stuck.database.id}_${createdAt}.sql`))).toBe(true);
  }, 240_000);

  test("converted originals are kept for 30 days, and never removed in the boot that moved them", async () => {
    const { database } = await makeDatabase(fx.owner);
    const createdAt = Date.UTC(2026, 1, 3, 4, 5, 6);
    mkdirSync(env.snapshotsDir, { recursive: true });
    const name = `${database.id}_${createdAt}.sql`;
    writeFileSync(join(env.snapshotsDir, name), "CREATE TABLE kept (id INT);\n");
    snapshots.insert({ id: newId("snap"), databaseId: database.id, filePath: join(env.snapshotsDir, name), sizeBytes: 28, createdAt, trigger: "manual" });
    await convertLegacySnapshots();
    const kept = join(convertedDir(), name);
    expect(existsSync(kept)).toBe(true);
    const old = new Date(Date.now() - CONVERTED_KEEP_MS - 60_000);
    utimesSync(kept, old, old);
    expect(await removeExpiredOriginals()).toBe(0);
    expect(existsSync(kept)).toBe(true);
    const otherName = `${database.id}_${createdAt + 1}.sql`;
    const other = join(convertedDir(), otherName);
    writeFileSync(other, "-- an original converted at an earlier boot\n");
    utimesSync(other, old, old);
    const fresh = join(convertedDir(), `${database.id}_${createdAt + 2}.sql`);
    writeFileSync(fresh, "-- converted yesterday\n");
    expect(await removeExpiredOriginals()).toBe(1);
    expect(existsSync(other)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
  }, 120_000);

  test("below the disk floor the scheduler and syncs skip the round and say so at most once an hour", async () => {
    const { database } = await makeDatabase(fx.owner);
    await exec(database.name, "CREATE TABLE t (id INT PRIMARY KEY)");
    const mirror = await makeDatabase(fx.owner, { kind: "mirror" });
    syncJobs.upsert({
      id: newId("sj"),
      databaseId: mirror.database.id,
      sourceKind: "mysql",
      sourceHost: "127.0.0.1",
      sourcePort: env.mariadbPort,
      sourceUser: "nobody",
      passwordEnc: await encryptSecret("x"),
      sourceDatabase: database.name,
      intervalSeconds: 60,
      enabled: true,
    });
    const real = diskProbe.space;
    const warnings: string[] = [];
    const warn = console.warn;
    diskProbe.space = () => ({ freeBytes: 1024, totalBytes: 100 * 1024 * 1024 * 1024 });
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map(String).join(" "));
    };
    try {
      expect(await runScheduledCheckpoints()).toEqual([]);
      expect(await runScheduledCheckpoints()).toEqual([]);
      expect(runDueSyncs()).toEqual([]);
      expect(runDueSyncs()).toEqual([]);
    } finally {
      diskProbe.space = real;
      console.warn = warn;
    }
    expect(warnings.filter((w) => w.startsWith("[checkpoints] skipping this round")).length).toBe(1);
    expect(warnings.filter((w) => w.startsWith("[sync] skipping this round")).length).toBe(1);
  }, 120_000);

  test("non-admins cannot set automatic checkpoint policies beyond the server's limits", async () => {
    const { database } = await provisionDatabase({ displayName: `limits ${Date.now()}`, ownerUserId: owner.id });
    setCheckpointCeilings({ maxAutoRetention: 5, minIntervalHours: 6 });
    try {
      const path = `/api/databases/${database.id}/checkpoints/policy`;
      const tooMany = await call(owner, path, { method: "PUT", body: JSON.stringify({ autoRetention: 9 }) });
      expect(tooMany.status).toBe(400);
      const tooOften = await call(owner, path, { method: "PUT", body: JSON.stringify({ autoIntervalHours: 1 }) });
      expect(tooOften.status).toBe(400);
      expect((await call(owner, path, { method: "PUT", body: JSON.stringify({ autoRetention: 5 }) })).status).toBe(200);
      expect((await call(fx.owner, path, { method: "PUT", body: JSON.stringify({ autoRetention: 50 }) })).status).toBe(200);
      expect(checkpoints.policy(database.id).autoRetention).toBe(50);
    } finally {
      setCheckpointCeilings({ maxAutoRetention: null, minIntervalHours: null });
    }
  }, 120_000);

  test("30-day vitals only use a real earlier sample as the baseline", async () => {
    const { database } = await makeDatabase(fx.owner);
    db.query(
      "INSERT INTO metrics(database_id, collected_at, size_bytes, table_count, connection_count, row_count) VALUES(?, ?, ?, ?, ?, ?)",
    ).run(database.id, Date.now() - 60_000, 100, 1, 0, 0);
    const vitals = async () =>
      ((await (await call(fx.owner, "/api/dashboard/vitals?range=30d")).json()) as DashboardVitals).series.find(
        (s) => s.databaseId === database.id,
      )!;
    const fresh = await vitals();
    expect(fresh.samples.length).toBe(1);
    expect(fresh.samples[0]!.collectedAt).toBeGreaterThan(Date.now() - 5 * 60_000);
    db.query(
      "INSERT INTO metrics(database_id, collected_at, size_bytes, table_count, connection_count, row_count) VALUES(?, ?, ?, ?, ?, ?)",
    ).run(database.id, Date.now() - 40 * 86_400_000, 50, 1, 0, 0);
    const withHistory = await vitals();
    expect(withHistory.samples.length).toBe(2);
    expect(withHistory.samples[0]!.sizeBytes).toBe(50);
  }, 120_000);

  test("rotating the password of a tailnet-only database returns the tailnet address", async () => {
    const fake = useFakeTailscale();
    try {
      const { database, credentials } = await provisionDatabase({
        displayName: `tailnet ${Date.now()}`,
        ownerUserId: fx.owner.id,
        tailnetOnly: true,
      });
      expect(credentials.host).toBe("100.88.0.1");
      const res = await call(fx.owner, `/api/databases/${database.id}/rotate-password`, { method: "POST", body: "{}" });
      expect(res.status).toBe(200);
      expect(((await res.json()) as { credentials: { host: string } }).credentials.host).toBe("100.88.0.1");
      expect(databases.byId(database.id)!.tailscaleExposed).toBe(true);
    } finally {
      fake.restore();
    }
  }, 120_000);

  test("before setup, a remote folder check is accepted with the setup token", async () => {
    settings.set("setup_complete", "0");
    try {
      const token = announceSetupToken(() => {});
      const body = (extra: object) => JSON.stringify({ path: env.dataDir, ...extra });
      const send = (extra: object) =>
        app.request("/api/system/validate-path", { method: "POST", headers: { "Content-Type": "application/json" }, body: body(extra) }, REMOTE);
      expect((await send({})).status).toBe(403);
      expect((await send({ setupToken: "AAAA-BBBB-CCCC-DDDD-EEEE" })).status).toBe(403);
      const ok = await send({ setupToken: token });
      expect(ok.status).toBe(200);
      expect(((await ok.json()) as { resolvedPath: string }).resolvedPath).toBeString();
    } finally {
      expireSetupToken();
      settings.set("setup_complete", "1");
    }
  }, 60_000);
});
