import { createTestDatabase, mariadbAvailable, rootQuery, startTestInstance, type TestInstance } from "../harness/instance";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import mysql from "mysql2/promise";
import type { DatabasePortResponse } from "@lambdata/shared";
import { authHeaders, seedUser, useTempMetadata, type SeededUser, type TempMetadata } from "../harness/sqlite";
import { peerEnv } from "../network/helpers";
import { env } from "../../src/env";
import { audit, settings } from "../../src/db/queries";
import { buildApp } from "../../src/server";
import { getPool, mariadbState, rebindMariaDb } from "../../src/mariadb/controller";
import { OUTSIDE_CONNECTIONS_KEY } from "../../src/connections/bind";
import { auditLogPath } from "../../src/connections/auditPlugin";
import { LogTail, captureMode } from "../../src/connections/capture";
import { parseAuditLine, parseErrorLogLine, type RawRejection } from "../../src/connections/parse";
import { startJob, waitForJob } from "../../src/jobs/runner";
import { logFilePath, mariadbLogLimits, rotateMariaDbLogIfNeeded } from "../../src/mariadb/controller";

const WRONG = "Not_the_password_42";

async function bindAddress(): Promise<string> {
  const [row] = await rootQuery<{ b: string }>("SELECT @@global.bind_address AS b");
  return String(row?.b);
}

async function failSignIn(user: string, password: string): Promise<string> {
  try {
    const conn = await mysql.createConnection({ host: "127.0.0.1", port: env.mariadbPort, user, password, connectTimeout: 3000 });
    await conn.end();
    return "connected";
  } catch (err) {
    return String((err as { errno?: number }).errno ?? err);
  }
}

async function collect(tail: LogTail, parse: (l: string) => RawRejection | null, user: string, count: number): Promise<RawRejection[]> {
  const found: RawRejection[] = [];
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    for (const line of tail.readLines()) {
      const r = parse(line);
      if (r && r.user === user) found.push(r);
    }
    if (found.length >= count) break;
    await Bun.sleep(100);
  }
  return found;
}

describe.skipIf(!mariadbAvailable())("database port switch against a real MariaDB", () => {
  let instance: TestInstance | null = null;
  let md: TempMetadata;
  let app: ReturnType<typeof buildApp>;
  let admin: SeededUser;
  let viewer: SeededUser;

  beforeAll(async () => {
    instance = await startTestInstance();
    md = useTempMetadata();
    app = buildApp();
    admin = seedUser("admin");
    viewer = seedUser("viewer");
  }, 120_000);

  afterAll(async () => {
    delete process.env.LAMBDATA_CONNECTION_AUDIT;
    if (mariadbState() === "running" && env.mariadbBind !== "127.0.0.1") await rebindMariaDb("127.0.0.1");
    md?.cleanup();
    await instance?.stop();
  }, 120_000);

  async function put(user: SeededUser, outsideConnections: boolean): Promise<Response> {
    return app.request(
      "/api/network/database-port",
      {
        method: "PUT",
        headers: await authHeaders(user, { "Content-Type": "application/json" }),
        body: JSON.stringify({ outsideConnections }),
      },
      peerEnv("127.0.0.1"),
    );
  }

  test("the audit plugin is used where MariaDB ships it, and it captures failed sign-ins without passwords", async () => {
    const [plugin] = await rootQuery<{ v: string | null }>(
      "SELECT PLUGIN_STATUS AS v FROM information_schema.PLUGINS WHERE PLUGIN_NAME = 'SERVER_AUDIT'",
    );
    if (!plugin) {
      expect(captureMode()).toBe("errorlog");
      return;
    }
    expect(plugin.v).toBe("ACTIVE");
    expect(captureMode()).toBe("audit");
    const db = await createTestDatabase();
    const tail = new LogTail(auditLogPath());
    tail.start();
    expect(await failSignIn(db.user, WRONG)).toBe("1045");
    await rootQuery("ALTER USER ?@'%' ACCOUNT LOCK", [db.user]);
    expect(await failSignIn(db.user, db.password)).toBe("4151");
    await rootQuery("ALTER USER ?@'%' ACCOUNT UNLOCK", [db.user]);
    const found = await collect(tail, (l) => parseAuditLine(l), db.user, 2);
    expect(found.map((r) => [r.address, r.code])).toEqual([
      ["127.0.0.1", 1045],
      ["127.0.0.1", 4151],
    ]);
    expect(readFileSync(auditLogPath(), "utf8")).not.toContain(WRONG);
    expect(readFileSync(auditLogPath(), "utf8")).not.toContain(db.password);
  }, 60_000);

  test("turning the switch on restarts MariaDB on every address and records it", async () => {
    const res = await put(admin, true);
    expect(res.status).toBe(200);
    const body = (await res.json()) as DatabasePortResponse;
    expect(body.databasePort).toMatchObject({ bind: "0.0.0.0", outsideConnections: true, source: "setting", lockedByEnv: false });
    expect(await bindAddress()).toBe("0.0.0.0");
    expect(settings.get(OUTSIDE_CONNECTIONS_KEY)).toBe("1");
    const entry = audit.list(5).find((e) => e.action === "network.database_port.update");
    expect(JSON.parse(String(entry?.details))).toEqual({ outsideConnections: true });
  }, 60_000);

  test("a bind address that cannot work is rolled back and MariaDB keeps running", async () => {
    const outcome = await rebindMariaDb("203.0.113.7");
    expect(outcome.ok).toBe(false);
    expect(outcome).toMatchObject({ restored: true, bind: "0.0.0.0" });
    expect(outcome.ok ? "" : outcome.error).toContain("Bind on TCP/IP port");
    expect(mariadbState()).toBe("running");
    expect(env.mariadbBind).toBe("0.0.0.0");
    expect(await bindAddress()).toBe("0.0.0.0");
    await getPool().query("SELECT 1");
  }, 90_000);

  test("the change is refused while a job is running", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const job = startJob({ kind: "sync.run", databaseId: null, userId: null }, async () => {
      await gate;
    });
    try {
      const res = await put(admin, false);
      expect(res.status).toBe(409);
      expect(((await res.json()) as { error: string }).error).toContain("running");
      expect(await bindAddress()).toBe("0.0.0.0");
    } finally {
      release();
      await waitForJob(job.id);
    }
  }, 30_000);

  test("viewers cannot change it and the variable locks it", async () => {
    expect((await put(viewer, false)).status).toBe(403);
    const before = env.mariadbBindFromEnv;
    env.mariadbBindFromEnv = "0.0.0.0";
    try {
      const res = await put(admin, false);
      expect(res.status).toBe(409);
      expect(((await res.json()) as { error: string }).error).toContain("LAMBDATA_MARIADB_BIND");
    } finally {
      env.mariadbBindFromEnv = before;
    }
  });

  test("without the plugin the error log is read instead", async () => {
    process.env.LAMBDATA_CONNECTION_AUDIT = "0";
    const res = await put(admin, false);
    expect(res.status).toBe(200);
    expect(await bindAddress()).toBe("127.0.0.1");
    expect(captureMode()).toBe("errorlog");
    const db = await createTestDatabase();
    const tail = new LogTail(logFilePath());
    tail.start();
    expect(await failSignIn(db.user, WRONG)).toBe("1045");
    const found = await collect(tail, (l) => parseErrorLogLine(l), db.user, 1);
    expect(found.map((r) => [r.address, r.code])).toEqual([["127.0.0.1", 1045]]);
    expect(readFileSync(logFilePath(), "utf8")).not.toContain(WRONG);
  }, 60_000);

  test("the error log is moved aside past its size limit while MariaDB runs, and no refusal is lost or counted twice", async () => {
    const limitBefore = mariadbLogLimits.maxBytes;
    const [logError] = await rootQuery<{ v: string }>("SELECT @@global.log_error AS v");
    expect(logError?.v).toBe(logFilePath());
    const db = await createTestDatabase();
    const tail = new LogTail(logFilePath());
    tail.start();
    try {
      for (let i = 0; i < 3; i++) expect(await failSignIn(db.user, WRONG)).toBe("1045");
      expect(await rotateMariaDbLogIfNeeded()).toBe(false);
      mariadbLogLimits.maxBytes = 1;
      expect(await rotateMariaDbLogIfNeeded()).toBe(true);
      expect(existsSync(`${logFilePath()}.1`)).toBe(true);
      for (let i = 0; i < 2; i++) expect(await failSignIn(db.user, WRONG)).toBe("1045");
      const found = await collect(tail, (l) => parseErrorLogLine(l), db.user, 5);
      await Bun.sleep(300);
      for (const line of tail.readLines()) if (parseErrorLogLine(line)?.user === db.user) found.push(parseErrorLogLine(line)!);
      expect(found.length).toBe(5);
      expect(readFileSync(logFilePath(), "utf8").split(db.user).length - 1).toBe(2);
    } finally {
      mariadbLogLimits.maxBytes = limitBefore;
    }
  }, 60_000);

  test("a start that fails after the log was moved aside is still diagnosed", async () => {
    const limitBefore = mariadbLogLimits.maxBytes;
    mariadbLogLimits.maxBytes = 1;
    try {
      const outcome = await rebindMariaDb("203.0.113.7");
      expect(outcome).toMatchObject({ ok: false, restored: true });
      expect(outcome.ok ? "" : outcome.error).toContain("Bind on TCP/IP port");
      expect(mariadbState()).toBe("running");
      await getPool().query("SELECT 1");
    } finally {
      mariadbLogLimits.maxBytes = limitBefore;
    }
  }, 90_000);
});
