import {
  checksums,
  codeObjectsOf,
  exec,
  finished,
  makeDatabase,
  mariadbAvailable,
  populateRich,
  rootQuery,
  setup,
  type Fixture,
} from "./helpers";
import { authHeaders, seedUser, type SeededUser } from "../harness/sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import mysql from "mysql2/promise";
import { env } from "../../src/env";
import { checkpoints, databases, syncJobs } from "../../src/db/queries";
import { encryptSecret } from "../../src/util/crypto";
import { newId } from "../../src/util/id";
import { runDueSyncs, startSyncJob, syncSourceProblem } from "../../src/workers/sync";
import { buildApp } from "../../src/server";
import { STAGING_PREFIX } from "../../src/mariadb/schemaSwap";
import { isWriteFenced } from "../../src/mariadb/writeFence";
import { readObjectText } from "../../src/checkpoints/store";

function watchFence(databaseId: string): { seen(): boolean; stop(): void } {
  let seen = false;
  const timer = setInterval(() => {
    if (isWriteFenced(databaseId)) seen = true;
  }, 2);
  return { seen: () => seen, stop: () => clearInterval(timer) };
}

async function connectionId(conn: mysql.Connection): Promise<number> {
  const [rows] = await conn.query("SELECT CONNECTION_ID() AS id");
  return Number((rows as { id: number }[])[0]!.id);
}

async function configure(mirrorId: string, p: { database: string; user: string; password: string; port?: number; host?: string }) {
  syncJobs.upsert({
    id: newId("sj"),
    databaseId: mirrorId,
    sourceKind: "mysql",
    sourceHost: p.host ?? "127.0.0.1",
    sourcePort: p.port ?? env.mariadbPort,
    sourceUser: p.user,
    passwordEnc: await encryptSecret(p.password),
    sourceDatabase: p.database,
    intervalSeconds: 3600,
    enabled: true,
  });
}

async function sync(mirrorId: string) {
  return finished(startSyncJob(mirrorId, null).id);
}

async function stagingSchemas(): Promise<string[]> {
  const rows = await rootQuery<{ n: string }>("SELECT SCHEMA_NAME AS n FROM information_schema.SCHEMATA");
  return rows.map((r) => r.n).filter((n) => n.startsWith(STAGING_PREFIX));
}

describe.skipIf(!mariadbAvailable())("mirror sync", () => {
  let fx: Fixture;
  let app: ReturnType<typeof buildApp>;
  let owner: SeededUser;

  beforeAll(async () => {
    fx = await setup();
    app = buildApp();
    owner = seedUser("db_owner");
  }, 180_000);

  afterAll(async () => {
    await fx?.instance.stop();
  }, 120_000);

  test("loads through staging, rewrites definers and records checkpoints for versioned mirrors", async () => {
    const primary = await makeDatabase(fx.owner);
    await populateRich(primary.database.name);
    const mirror = await makeDatabase(fx.owner, { kind: "mirror", versioned: true });
    await configure(mirror.database.id, {
      database: primary.database.name,
      user: primary.credentials.user,
      password: primary.credentials.password,
    });

    const first = await sync(mirror.database.id);
    expect(first.status).toBe("succeeded");
    expect(first.result).toMatchObject({ status: "ok", tables: 4, preSyncCheckpointId: null, unchanged: false });
    expect(await checksums(mirror.database.name)).toEqual(await checksums(primary.database.name));
    expect(await codeObjectsOf(mirror.database.name)).toEqual(await codeObjectsOf(primary.database.name));
    expect(syncJobs.byDatabaseId(mirror.database.id)!.lastStatus).toBe("ok");
    const definers = await rootQuery<{ d: string }>(
      `SELECT DEFINER AS d FROM information_schema.VIEWS WHERE TABLE_SCHEMA = ?
       UNION ALL SELECT DEFINER FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = ?
       UNION ALL SELECT DEFINER FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA = ?`,
      [mirror.database.name, mirror.database.name, mirror.database.name],
    );
    expect(definers.length).toBe(4);
    for (const r of definers) expect(r.d).toBe(`${mirror.credentials.user}@%`);

    const firstCp = String(first.result!.checkpointId);
    expect(checkpoints.byId(firstCp)).toMatchObject({ trigger: "sync", message: `Synced from 127.0.0.1/${primary.database.name}` });

    const unchanged = await sync(mirror.database.id);
    expect(unchanged.result).toMatchObject({ checkpointId: null, unchanged: true, preSyncCheckpointId: null });

    const user = await mysql.createConnection({
      host: "127.0.0.1",
      port: env.mariadbPort,
      user: mirror.credentials.user,
      password: mirror.credentials.password,
      database: mirror.database.name,
    });
    try {
      await user.query("SELECT * FROM v_leaderboard");
      await user.query("CALL sp_player_summary(76561198000000008)");
      await user.query("UPDATE players SET score = score + 1 WHERE id = 76561198000000008");
      const [audit] = await user.query("SELECT COUNT(*) AS n FROM audit");
      expect(Number((audit as { n: number }[])[0]!.n)).toBe(1);
    } finally {
      await user.end();
    }
    const third = await sync(mirror.database.id);
    expect(third.status).toBe("succeeded");
    const pre = checkpoints.byId(String(third.result!.preSyncCheckpointId))!;
    expect(pre.trigger).toBe("pre-sync");
    expect(pre.parentId).toBe(firstCp);
    expect(checkpoints.byId(String(third.result!.checkpointId))!.parentId).toBe(pre.id);
    expect(await checksums(mirror.database.name)).toEqual(await checksums(primary.database.name));
    expect(await stagingSchemas()).toEqual([]);
  }, 240_000);

  test("syncing a clean versioned mirror leaves its readers connected; local changes are saved behind the fence first", async () => {
    const primary = await makeDatabase(fx.owner);
    await populateRich(primary.database.name);
    const mirror = await makeDatabase(fx.owner, { kind: "mirror", versioned: true });
    await configure(mirror.database.id, {
      database: primary.database.name,
      user: primary.credentials.user,
      password: primary.credentials.password,
    });
    expect((await sync(mirror.database.id)).status).toBe("succeeded");

    const reader = await mysql.createConnection({
      host: "127.0.0.1",
      port: env.mariadbPort,
      user: mirror.credentials.user,
      password: mirror.credentials.password,
      database: mirror.database.name,
    });
    const fence = watchFence(mirror.database.id);
    try {
      const before = await connectionId(reader);
      await reader.query("SELECT COUNT(*) FROM players");
      await exec(primary.database.name, "INSERT INTO settings VALUES ('from', 'primary')");
      const clean = await sync(mirror.database.id);
      expect(clean.status).toBe("succeeded");
      expect(clean.result).toMatchObject({ preSyncCheckpointId: null, unchanged: false });
      expect(clean.warnings.filter((w) => /connection/.test(w))).toEqual([]);
      expect(fence.seen()).toBe(false);
      expect(await connectionId(reader)).toBe(before);
      const [fromPrimary] = await reader.query("SELECT v FROM settings WHERE k = 'from'");
      expect(fromPrimary as unknown).toEqual([{ v: "primary" }]);

      await reader.query("INSERT INTO settings VALUES ('local', 'edit')");
      const dirty = await sync(mirror.database.id);
      expect(dirty.status).toBe("succeeded");
      expect(fence.seen()).toBe(true);
      const pre = checkpoints.byId(String(dirty.result!.preSyncCheckpointId))!;
      expect(pre.trigger).toBe("pre-sync");
      const settings = checkpoints.entries(pre.id).find((e) => e.name === "settings")!;
      expect(await readObjectText(mirror.database.id, settings.objectHash)).toContain("('local','edit')");
      expect(dirty.warnings).toContain("1 connection(s) to this mirror were closed while its local changes were saved");
      await expect(reader.query("SELECT 1")).rejects.toThrow();
    } finally {
      fence.stop();
      reader.destroy();
    }
    expect(await checksums(mirror.database.name)).toEqual(await checksums(primary.database.name));

    const plain = await makeDatabase(fx.owner, { kind: "mirror" });
    await configure(plain.database.id, {
      database: primary.database.name,
      user: primary.credentials.user,
      password: primary.credentials.password,
    });
    expect((await sync(plain.database.id)).status).toBe("succeeded");
    const plainReader = await mysql.createConnection({
      host: "127.0.0.1",
      port: env.mariadbPort,
      user: plain.credentials.user,
      password: plain.credentials.password,
      database: plain.database.name,
    });
    const plainFence = watchFence(plain.database.id);
    try {
      const id = await connectionId(plainReader);
      await plainReader.query("INSERT INTO settings VALUES ('local', 'edit')");
      const again = await sync(plain.database.id);
      expect(again.result).toMatchObject({ preSyncCheckpointId: null, checkpointId: null, unchanged: null });
      expect(plainFence.seen()).toBe(false);
      expect(await connectionId(plainReader)).toBe(id);
      const [local] = await plainReader.query("SELECT v FROM settings WHERE k = 'local'");
      expect(local as unknown).toEqual([]);
    } finally {
      plainFence.stop();
      await plainReader.end();
    }
    expect(checkpoints.listForDatabase(plain.database.id)).toEqual([]);
  }, 240_000);

  test("an unreachable or failing source leaves the mirror exactly as it was", async () => {
    const primary = await makeDatabase(fx.owner);
    await populateRich(primary.database.name);
    const mirror = await makeDatabase(fx.owner, { kind: "mirror" });
    await configure(mirror.database.id, {
      database: primary.database.name,
      user: primary.credentials.user,
      password: primary.credentials.password,
    });
    expect((await sync(mirror.database.id)).status).toBe("succeeded");
    await exec(mirror.database.name, "INSERT INTO settings VALUES ('keep', 'this')");
    const before = await checksums(mirror.database.name);
    const code = await codeObjectsOf(mirror.database.name);

    await configure(mirror.database.id, {
      database: primary.database.name,
      user: primary.credentials.user,
      password: "wrong-password-123",
    });
    const denied = await sync(mirror.database.id);
    expect(denied.status).toBe("failed");
    expect(denied.error).not.toContain("wrong-password-123");
    expect(syncJobs.byDatabaseId(mirror.database.id)!.lastStatus).toBe("error");
    expect(await checksums(mirror.database.name)).toEqual(before);

    await configure(mirror.database.id, {
      database: "does_not_exist",
      user: primary.credentials.user,
      password: primary.credentials.password,
    });
    const gone = await sync(mirror.database.id);
    expect(gone.status).toBe("failed");
    expect(await checksums(mirror.database.name)).toEqual(before);

    const silent = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
    try {
      await configure(mirror.database.id, {
        database: primary.database.name,
        user: primary.credentials.user,
        password: primary.credentials.password,
        port: silent.port,
      });
      const hung = await sync(mirror.database.id);
      expect(hung.status).toBe("failed");
    } finally {
      silent.stop(true);
    }
    expect(await checksums(mirror.database.name)).toEqual(before);
    expect(await codeObjectsOf(mirror.database.name)).toEqual(code);
    expect(await stagingSchemas()).toEqual([]);

    await configure(mirror.database.id, {
      database: primary.database.name,
      user: primary.credentials.user,
      password: primary.credentials.password,
    });
    syncJobs.recordRun(mirror.database.id, "error", "old");
    const db = (await import("../../src/db/client")).db;
    db.query("UPDATE sync_jobs SET last_run_at = 1 WHERE database_id = ?").run(mirror.database.id);
    const started = runDueSyncs();
    expect(started.length).toBeGreaterThanOrEqual(1);
    for (const id of started) await finished(id);
    expect(syncJobs.byDatabaseId(mirror.database.id)!.lastStatus).toBe("ok");
    expect(await checksums(mirror.database.name)).toEqual(await checksums(primary.database.name));
  }, 240_000);

  test("validates source fields and runs from the route as a job", async () => {
    expect(syncSourceProblem({ sourceKind: "mysql", sourceHost: "db", sourceUser: "u", sourceDatabase: "-x" })).toMatch(/must not start/);
    expect(syncSourceProblem({ sourceKind: "mysql", sourceHost: "db", sourceUser: "u\n", sourceDatabase: "x" })).toMatch(/control/);
    expect(syncSourceProblem({ sourceKind: "mysql", sourceHost: "--host", sourceUser: "u", sourceDatabase: "x" })).toMatch(/must not start/);
    expect(syncSourceProblem({ sourceKind: "postgres", sourceHost: "db", sourceUser: "u", sourceDatabase: "host=evil dbname=x" })).toMatch(
      /connection string/,
    );
    expect(syncSourceProblem({ sourceKind: "mysql", sourceHost: "db.example", sourceUser: "u", sourceDatabase: "shop" })).toBeNull();

    const mirror = await makeDatabase(owner, { kind: "mirror" });
    const primary = await makeDatabase(owner);
    await populateRich(primary.database.name);
    const headers = await authHeaders(owner, { "Content-Type": "application/json" });
    const put = (body: unknown) =>
      app.request(`/api/databases/${mirror.database.id}/sync`, { method: "PUT", headers, body: JSON.stringify(body) });
    const valid = {
      sourceKind: "mysql",
      sourceHost: "127.0.0.1",
      sourcePort: env.mariadbPort,
      sourceUser: primary.credentials.user,
      sourcePassword: primary.credentials.password,
      sourceDatabase: primary.database.name,
      intervalSeconds: 30,
    };
    expect((await put({ ...valid, sourceDatabase: "--all-databases" })).status).toBe(400);
    expect((await put({ ...valid, sourceUser: "a\u0000b" })).status).toBe(400);
    expect((await put({ ...valid, sourcePort: 70000 })).status).toBe(400);
    const ok = await put(valid);
    expect(ok.status).toBe(200);
    const stored = ((await ok.json()) as { sync: { intervalSeconds: number } }).sync;
    expect(stored.intervalSeconds).toBe(60);
    const run = await app.request(`/api/databases/${mirror.database.id}/sync/run`, { method: "POST", headers });
    expect(run.status).toBe(202);
    const { job } = (await run.json()) as { job: { id: string; kind: string } };
    expect(job.kind).toBe("sync.run");
    expect((await finished(job.id)).status).toBe("succeeded");
    expect(await checksums(mirror.database.name)).toEqual(await checksums(primary.database.name));
    expect(databases.byId(mirror.database.id)!.versioned).toBe(false);
    expect(checkpoints.listForDatabase(mirror.database.id)).toEqual([]);
  }, 240_000);
});
