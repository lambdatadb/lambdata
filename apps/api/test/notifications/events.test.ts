import { createTestDatabase, mariadbAvailable, rootQuery, startTestInstance, type TestInstance } from "../harness/instance";
import { authHeaders, seedUser, type SeededUser } from "../harness/sqlite";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import mysql from "mysql2/promise";
import type {
  Database,
  DatabaseCredentials,
  ImportCreateDatabaseResponse,
  ImportUploadResponse,
  Job,
  JobResponse,
  NotificationDestinationResponse,
  NotificationEventType,
  NotificationWebhookPayload,
} from "@lambdata/shared";
import { buildApp } from "../../src/server";
import { env } from "../../src/env";
import { db } from "../../src/db/client";
import { checkpoints, databases, snapshots, syncJobs, users } from "../../src/db/queries";
import { waitForJob } from "../../src/jobs";
import { getRootPassword, mariadbServerPid, mariadbState } from "../../src/mariadb/controller";
import { encryptSecret } from "../../src/util/crypto";
import { newId } from "../../src/util/id";
import { startScheduledCheckpoint } from "../../src/checkpoints/scheduler";
import { startSyncJob } from "../../src/workers/sync";
import { notifySnapshotUnconverted } from "../../src/notifications/bus";
import { handleJobFinished } from "../../src/notifications/handlers";
import { notificationsService } from "../../src/notifications/service";
import { clearNotifications, FakeDestination, installFakeNetwork, json, restoreFakeNetwork, until } from "./helpers";

describe.skipIf(!mariadbAvailable())("notification events from their real triggers", () => {
  let instance: TestInstance;
  let app: ReturnType<typeof buildApp>;
  let admin: SeededUser;
  let hook: FakeDestination;
  let side: FakeDestination;
  let adminName: string;

  async function call(method: string, path: string, body?: unknown): Promise<Response> {
    return app.request(path, {
      method,
      headers: await authHeaders(admin, { "Content-Type": "application/json" }),
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }

  async function destination(server: FakeDestination, events: NotificationEventType[], path: string, databaseIds: string[] | null = null) {
    return (
      await json<NotificationDestinationResponse>(
        await call("POST", "/api/notifications/destinations", { kind: "webhook", name: path, events, databaseIds, config: { url: server.url(path) } }),
        201,
      )
    ).destination;
  }

  function payloads(server: FakeDestination, path?: string): NotificationWebhookPayload[] {
    return server.requests.filter((r) => !path || r.path === path).map((r) => JSON.parse(r.body) as NotificationWebhookPayload);
  }

  function ofType(server: FakeDestination, type: string, path?: string): NotificationWebhookPayload[] {
    return payloads(server, path).filter((p) => p.type === type);
  }

  async function eventually(server: FakeDestination, type: string, path?: string, n = 1): Promise<NotificationWebhookPayload> {
    await until(() => ofType(server, type, path).length >= n, 20_000, type);
    return ofType(server, type, path)[n - 1]!;
  }

  async function newDatabase(displayName: string, extra: Record<string, unknown> = {}): Promise<{ database: Database; credentials: DatabaseCredentials }> {
    return json(await call("POST", "/api/databases", { displayName, ...extra }));
  }

  async function exec(schema: string, ...statements: string[]): Promise<void> {
    const conn = await mysql.createConnection({
      host: "127.0.0.1",
      port: env.mariadbPort,
      user: env.rootUser,
      password: await getRootPassword(),
      database: schema,
      multipleStatements: true,
    });
    try {
      for (const s of statements) await conn.query(s);
    } finally {
      await conn.end();
    }
  }

  async function runJob(res: Response): Promise<Job> {
    const { job } = await json<JobResponse>(res, 202);
    return (await waitForJob(job.id))!;
  }

  beforeAll(async () => {
    instance = await startTestInstance();
    installFakeNetwork();
    hook = new FakeDestination(4366);
    side = new FakeDestination(4367);
    app = buildApp();
    admin = seedUser("admin");
    adminName = users.byId(admin.id)!.displayName!;
    await notificationsService.start();
  }, 180_000);

  afterAll(async () => {
    await notificationsService.stop();
    hook?.stop();
    side?.stop();
    restoreFakeNetwork();
    await instance?.stop();
  }, 120_000);

  beforeEach(() => {
    clearNotifications();
    hook.reset();
    side.reset();
  });

  test("database created, password rotated, Data API opened and closed, database deleted", async () => {
    await destination(hook, ["database.created", "database.password_rotated", "data_api.opened", "data_api.closed", "database.deleted"], "/db");
    const { database, credentials } = await newDatabase("Orders");
    const created = await eventually(hook, "database.created");
    expect(created.title).toBe("Database created: Orders");
    expect(created.message).toBe(`${adminName} created Orders.`);
    expect(created.database).toEqual({ id: database.id, name: database.name, displayName: "Orders" });
    expect(created.actor).toEqual({ displayName: adminName });
    expect(created.group).toBe("databases");
    expect(created.severity).toBe("success");

    const rotated = await json<{ credentials: DatabaseCredentials }>(await call("POST", `/api/databases/${database.id}/rotate-password`));
    const rot = await eventually(hook, "database.password_rotated");
    expect(rot.title).toBe("Password rotated: Orders");

    expect((await call("PUT", `/api/data-access/${database.name}`, { mode: "open" })).status).toBe(200);
    const opened = await eventually(hook, "data_api.opened");
    expect(opened.title).toBe("Data API opened: Orders");
    expect(opened.database?.id).toBe(database.id);
    expect((await call("PUT", `/api/data-access/${database.name}`, { mode: "open" })).status).toBe(200);
    expect((await call("PUT", `/api/data-access/${database.name}`, { mode: "closed" })).status).toBe(200);
    await eventually(hook, "data_api.closed");
    expect(ofType(hook, "data_api.opened")).toHaveLength(1);

    expect((await call("DELETE", `/api/databases/${database.id}`)).status).toBe(200);
    const deleted = await eventually(hook, "database.deleted");
    expect(deleted.title).toBe("Database deleted: Orders");

    const everything = hook.requests.map((r) => r.body).join("\n");
    for (const secret of [credentials.password, rotated.credentials.password, credentials.user, credentials.mysqlCli]) {
      expect(everything).not.toContain(secret);
    }
  }, 120_000);

  test("checkpoint made, rolled back, rollback refused and deleted; automatic checkpoints only where chosen", async () => {
    await destination(
      hook,
      ["checkpoint.created", "checkpoint.rolled_back", "checkpoint.rollback_refused", "checkpoint.deleted", "checkpoint.failed"],
      "/cp",
    );
    await destination(side, ["checkpoint.auto_created"], "/auto");
    const { database } = await newDatabase("Ledger", { versioned: true });
    await exec(database.name, "CREATE TABLE entries (id INT PRIMARY KEY, amount INT)", "INSERT INTO entries VALUES (1, 10), (2, 20)");
    const base = `/api/databases/${database.id}/checkpoints`;
    const made = await runJob(await call("POST", base, { message: "Before the wipe" }));
    expect(made.status).toBe("succeeded");
    const cpId = String(made.result!.checkpointId);
    const cp = checkpoints.byId(cpId)!;
    const createdEvent = await eventually(hook, "checkpoint.created");
    expect(createdEvent.title).toBe(`Checkpoint made: Before the wipe (${cp.shortHash})`);
    expect(createdEvent.message).toBe(`${adminName} made a checkpoint of Ledger. It holds 1 table and 2 rows.`);
    expect(createdEvent.data).toMatchObject({ checkpointId: cpId, hash: cp.shortHash, tables: 1, rows: 2 });

    await exec(database.name, "DELETE FROM entries");
    const rolled = await runJob(await call("POST", `${base}/${cpId}/restore`, {}));
    expect(rolled.status).toBe("succeeded");
    const back = await eventually(hook, "checkpoint.rolled_back");
    expect(back.title).toBe(`Rolled back: Ledger (${cp.shortHash})`);
    const safetyId = String(rolled.result!.safetyCheckpointId);
    const safety = checkpoints.byId(safetyId)!;
    expect(back.message).toContain(`saved in checkpoint ${safety.shortHash}`);
    const auto = await eventually(side, "checkpoint.auto_created");
    expect(auto.title).toBe(`Safety checkpoint: Ledger (${safety.shortHash})`);
    expect(ofType(hook, "checkpoint.auto_created")).toHaveLength(0);

    db.query("UPDATE checkpoint_entries SET checksum = checksum + 1 WHERE checkpoint_id = ? AND name = 'entries'").run(cpId);
    await exec(database.name, "INSERT INTO entries VALUES (3, 30)");
    const refusedJob = await runJob(await call("POST", `${base}/${cpId}/restore`, {}));
    expect(refusedJob.status).toBe("failed");
    const refused = await eventually(hook, "checkpoint.rollback_refused");
    expect(refused.title).toBe("Rollback refused: Ledger");
    expect(refused.message).toContain(`checkpoint ${cp.shortHash}`);
    expect(refused.message).toContain("before changing anything");
    await Bun.sleep(300);
    expect(ofType(hook, "checkpoint.failed")).toHaveLength(0);

    const scheduled = startScheduledCheckpoint(database.id)!;
    expect((await waitForJob(scheduled))!.status).toBe("succeeded");
    const sched = await eventually(side, "checkpoint.auto_created", undefined, 2);
    expect(sched.title).toMatch(/^Scheduled checkpoint: Ledger \([0-9a-f]{7}\)$/);
    expect(sched.actor).toBeNull();

    expect((await call("DELETE", `${base}/${safetyId}`)).status).toBe(200);
    const del = await eventually(hook, "checkpoint.deleted");
    expect(del.title).toBe(`Checkpoint deleted: Ledger (${safety.shortHash})`);
  }, 240_000);

  test("selection by database: a destination that follows one database hears only about it", async () => {
    const a = (await newDatabase("Alpha", { versioned: true })).database;
    const b = (await newDatabase("Bravo", { versioned: true })).database;
    await destination(hook, ["checkpoint.created", "user.created"], "/only-a", [a.id]);
    await destination(side, ["checkpoint.created"], "/all");
    for (const d of [a, b]) await exec(d.name, "CREATE TABLE t (id INT PRIMARY KEY)", "INSERT INTO t VALUES (1)");
    await runJob(await call("POST", `/api/databases/${b.id}/checkpoints`, { message: "Bravo point" }));
    await runJob(await call("POST", `/api/databases/${a.id}/checkpoints`, { message: "Alpha point" }));
    await until(() => ofType(side, "checkpoint.created").length === 2, 20_000, "both on the all-databases destination");
    await eventually(hook, "checkpoint.created");
    await Bun.sleep(200);
    expect(ofType(hook, "checkpoint.created").map((p) => p.database?.displayName)).toEqual(["Alpha"]);
    await call("POST", "/api/users", { email: "ari@example.com", password: "long enough pw", displayName: "Ari Novak", role: "viewer" });
    const user = await eventually(hook, "user.created");
    expect(user.title).toBe("User added: Ari Novak");
    expect(user.message).toBe(`${adminName} added Ari Novak to the console as a viewer.`);
  }, 180_000);

  test("sync failed, then recovered, then finished without a recovery message", async () => {
    await destination(hook, ["sync.failed", "sync.recovered", "sync.finished"], "/sync");
    const { database: mirror } = await newDatabase("Game mirror", { kind: "mirror" });
    const source = await createTestDatabase();
    await rootQuery(`CREATE TABLE \`${source.schema}\`.scores (id INT PRIMARY KEY, points INT)`);
    await rootQuery(`INSERT INTO \`${source.schema}\`.scores VALUES (1, 100)`);
    const configure = async (password: string) =>
      syncJobs.upsert({
        id: syncJobs.byDatabaseId(mirror.id)?.id ?? newId("sj"),
        databaseId: mirror.id,
        sourceKind: "mysql",
        sourceHost: "127.0.0.1",
        sourcePort: env.mariadbPort,
        sourceUser: source.user,
        passwordEnc: await encryptSecret(password),
        sourceDatabase: source.schema,
        intervalSeconds: 3600,
        enabled: true,
      });
    await configure("definitely-wrong-password");
    expect((await waitForJob(startSyncJob(mirror.id, null).id))!.status).toBe("failed");
    const failed = await eventually(hook, "sync.failed");
    expect(failed.title).toBe("Sync failed: Game mirror");
    expect(failed.message).not.toContain("127.0.0.1");
    expect(failed.message).not.toContain(source.user);
    expect((await waitForJob(startSyncJob(mirror.id, null).id))!.status).toBe("failed");
    await eventually(hook, "sync.failed", undefined, 2);
    await configure(source.password);
    expect((await waitForJob(startSyncJob(mirror.id, admin.id).id))!.status).toBe("succeeded");
    const recovered = await eventually(hook, "sync.recovered");
    expect(recovered.title).toBe("Sync recovered: Game mirror");
    expect(recovered.message).toContain("after 2 failed syncs");
    const finished = await eventually(hook, "sync.finished");
    expect(finished.title).toBe("Sync finished: Game mirror");
    expect(finished.message).toContain("copied 1 table");
    expect((await waitForJob(startSyncJob(mirror.id, null).id))!.status).toBe("succeeded");
    await eventually(hook, "sync.finished", undefined, 2);
    await Bun.sleep(200);
    expect(ofType(hook, "sync.recovered")).toHaveLength(1);
    expect(hook.requests.map((r) => r.body).join("\n")).not.toContain(source.password);
  }, 240_000);

  test("an upload imported through the routes reports import.finished, and a broken dump import.failed", async () => {
    await destination(hook, ["import.finished", "import.failed", "database.created"], "/imports");
    const upload = async (text: string, name: string): Promise<string> => {
      const res = await app.request("/api/imports/uploads", {
        method: "POST",
        headers: await authHeaders(admin, { "X-File-Name": encodeURIComponent(name), "Content-Type": "application/octet-stream" }),
        body: new TextEncoder().encode(text),
      });
      return (await json<ImportUploadResponse>(res, 201)).upload.id;
    };
    const good = await upload(
      "CREATE TABLE `bans` (`steamid` bigint NOT NULL PRIMARY KEY, `reason` text);\nINSERT INTO `bans` VALUES (1,'aimbot'),(2,NULL);\n",
      "ban-export-riley.sql",
    );
    const created = await json<ImportCreateDatabaseResponse>(
      await call("POST", `/api/imports/uploads/${good}/create-database`, { displayName: "Ban list" }),
      202,
    );
    expect((await waitForJob(created.job.id))!.status).toBe("succeeded");
    const fin = await eventually(hook, "import.finished");
    expect(fin.title).toBe("Import finished: Ban list");
    expect(fin.message).toBe(`${adminName} filled Ban list from a SQL dump: 1 table.`);
    expect(fin.data).toMatchObject({ mode: "create", format: "sql", tables: 1, outcome: "done", codeFailures: 0 });
    expect(fin.database?.id).toBe(created.database.id);
    const dbCreated = await eventually(hook, "database.created");
    expect(dbCreated.message).toBe(`${adminName} created Ban list from an uploaded file.`);

    const broken = await upload("CREATE TABLE `ok` (`id` int);\nTHIS IS NOT SQL AT ALL;\n", "broken.sql");
    const replaced = await runJob(await call("POST", `/api/databases/${created.database.id}/imports`, { uploadId: broken }));
    expect(replaced.status).toBe("failed");
    const failed = await eventually(hook, "import.failed");
    expect(failed.title).toBe("Import failed: Ban list");
    expect(failed.message).toBe(`An import into Ban list that ${adminName} started did not finish. Open the console to see why.`);
    const everything = hook.requests.map((r) => r.body).join("\n");
    for (const leak of ["ban-export-riley", "broken.sql", "NOT SQL", created.credentials!.password, created.database.mysqlUser]) {
      expect(everything).not.toContain(leak);
    }
  }, 180_000);

  test("finished jobs map to import and failure events", async () => {
    await destination(hook, ["import.finished", "import.failed", "checkpoint.failed"], "/jobs");
    const { database } = await newDatabase("Imports");
    const base: Job = {
      id: newId("job"),
      kind: "import.sqlite",
      databaseId: database.id,
      status: "succeeded",
      stage: null,
      progress: null,
      error: null,
      warnings: [],
      result: { importId: "imp_missing", tableCount: 3, rowCount: 1200, outcome: "done-with-errors", codeFailures: [{ kind: "VIEW", name: "v", error: "x" }] },
      createdByUserId: admin.id,
      createdAt: Date.now(),
      startedAt: Date.now(),
      finishedAt: Date.now(),
    };
    handleJobFinished(base);
    const fin = await eventually(hook, "import.finished");
    expect(fin.title).toBe("Import finished with errors: Imports");
    expect(fin.message).toBe(`${adminName} filled Imports from a SQLite file: 3 tables, 1,200 rows. 1 view, trigger, routine or event from the file could not be created.`);
    handleJobFinished({ ...base, id: newId("job"), kind: "import.sql", status: "failed", error: "boom /var/lib/secret/path", result: null });
    const failed = await eventually(hook, "import.failed");
    expect(failed.title).toBe("Import failed: Imports");
    expect(JSON.stringify(failed)).not.toContain("/var/lib");
    handleJobFinished({ ...base, id: newId("job"), kind: "checkpoint.create", status: "failed", createdByUserId: null, result: null });
    const cpFailed = await eventually(hook, "checkpoint.failed");
    expect(cpFailed.title).toBe("Checkpoint failed: Imports");
    expect(cpFailed.message).toContain("A scheduled checkpoint of Imports");
    handleJobFinished({ ...base, id: newId("job"), kind: "checkpoint.restore", status: "failed", errorCode: "restore.code-unrestorable", result: null });
    handleJobFinished({ ...base, id: newId("job"), kind: "checkpoint.restore", status: "failed", result: null });
    const rbFailed = await eventually(hook, "checkpoint.failed", undefined, 2);
    expect(rbFailed.title).toBe("Rollback failed: Imports");
    await Bun.sleep(200);
    expect(ofType(hook, "checkpoint.failed")).toHaveLength(2);
  }, 120_000);

  test("an unconvertible snapshot is reported once, not on every retry", async () => {
    await destination(hook, ["snapshot.unconverted"], "/snap");
    const { database } = await newDatabase("Archive");
    const snapshotId = newId("snap");
    snapshots.insert({ id: snapshotId, databaseId: database.id, filePath: "/nowhere/x.sql", sizeBytes: 10, createdAt: Date.UTC(2025, 2, 12), trigger: "manual" });
    checkpoints.recordConversionFailure(snapshotId, database.id, "stored copy does not match", Date.now());
    notifySnapshotUnconverted(snapshotId, database.id);
    const first = await eventually(hook, "snapshot.unconverted");
    expect(first.title).toBe("Snapshot not converted: Archive");
    expect(first.message).toContain("2025-03-12");
    expect(first.message).not.toContain("/nowhere");
    checkpoints.recordConversionFailure(snapshotId, database.id, "stored copy does not match", Date.now());
    notifySnapshotUnconverted(snapshotId, database.id);
    await Bun.sleep(300);
    expect(ofType(hook, "snapshot.unconverted")).toHaveLength(1);
    snapshots.delete(snapshotId);
    checkpoints.clearConversionFailure(snapshotId);
  }, 60_000);

  test("MariaDB down and back", async () => {
    await destination(hook, ["mariadb.down", "mariadb.recovered"], "/health");
    const pid = mariadbServerPid()!;
    process.kill(pid, "SIGKILL");
    const down = await eventually(hook, "mariadb.down");
    expect(down.title).toBe("MariaDB is down");
    expect(down.severity).toBe("error");
    const back = await eventually(hook, "mariadb.recovered");
    expect(back.title).toBe("MariaDB is back");
    await until(() => mariadbState() === "running", 60_000, "running");
    await Bun.sleep(2500);
    expect(ofType(hook, "mariadb.down")).toHaveLength(1);
    expect(ofType(hook, "mariadb.recovered")).toHaveLength(1);
    expect(databases.list().length).toBeGreaterThan(0);
  }, 120_000);
});
