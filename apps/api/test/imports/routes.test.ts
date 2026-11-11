import { mariadbAvailable, rootQuery, startTestInstance, type TestInstance } from "../harness/instance";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { gzipSync } from "node:zlib";
import mysql from "mysql2/promise";
import type { Database } from "bun:sqlite";
import type {
  ImportCreateDatabaseResponse,
  ImportJobResult,
  ImportListResponse,
  ImportPlanResponse,
  ImportUploadResponse,
  Job,
  SqliteImportPlan,
} from "@lambdata/shared";
import { authHeaders, seedUser, type SeededUser } from "../harness/sqlite";
import { buildSqlite, canonicalRows, mariaQuery, planFor } from "./helpers";

const available = mariadbAvailable();
const T = 180_000;

function ins(db: Database, sql: string, ...rows: unknown[][]): void {
  const stmt = db.query(sql);
  for (const r of rows) stmt.run(...(r as never[]));
}

function gmodFixture(rows: number, salt = ""): string {
  return buildSqlite((db) => {
    db.exec("CREATE TABLE playerpdata ( infoid TEXT NOT NULL UNIQUE, value TEXT )");
    db.exec("CREATE TABLE cookies ( key TEXT NOT NULL PRIMARY KEY, value TEXT )");
    db.exec("CREATE TABLE darkrp_player (uid BIGINT NOT NULL PRIMARY KEY, rpname VARCHAR(45), salary INTEGER NOT NULL DEFAULT 45, wallet INTEGER NOT NULL)");
    db.exec("CREATE TABLE pointshop_items (steamid, item, equipped, bought_at)");
    db.exec("BEGIN");
    for (let i = 0; i < rows; i++) {
      const sid = 76561197960265728n + BigInt(i * 7919);
      ins(db, "INSERT INTO playerpdata VALUES (?, ?)", [`${sid}[money${salt}]`, `${i * 3}`], [`${sid}[Money${salt}]`, "case"]);
      ins(db, "INSERT INTO darkrp_player VALUES (?, ?, ?, ?)", [sid, `Player ${i}${salt}`, 45n, BigInt(i) * 1000n]);
      ins(db, "INSERT INTO pointshop_items VALUES (?, ?, ?, ?)", [sid, `hat_${i % 17}`, i % 2 === 0 ? 1n : 0n, 1700000000n + BigInt(i)]);
    }
    ins(db, "INSERT INTO cookies VALUES (?, ?)", ["lastrun", "1"], ["LastRun", "2"], ["lastrun ", "3"]);
    db.exec("COMMIT");
  }, "sv.db");
}

describe.skipIf(!available)("import HTTP routes", () => {
  let instance: TestInstance;
  let owner: SeededUser;
  let other: SeededUser;
  let viewer: SeededUser;
  let admin: SeededUser;
  let app: { request: (path: string, init?: RequestInit) => Response | Promise<Response> };
  let jobs: typeof import("../../src/jobs");
  let env: typeof import("../../src/env");
  let service: typeof import("../../src/imports/service");
  let run: typeof import("../../src/imports/run");
  let codeObjects: typeof import("../../src/mariadb/codeObjects");
  let controller: typeof import("../../src/mariadb/controller");

  async function upload(user: SeededUser, bytes: Uint8Array | ReadableStream<Uint8Array>, name: string): Promise<Response> {
    return app.request("/api/imports/uploads", {
      method: "POST",
      headers: await authHeaders(user, { "X-File-Name": encodeURIComponent(name), "Content-Type": "application/octet-stream" }),
      body: bytes,
      duplex: "half",
    } as RequestInit);
  }

  async function uploadFile(user: SeededUser, path: string, name: string): Promise<string> {
    const res = await upload(user, new Uint8Array(await Bun.file(path).arrayBuffer()), name);
    expect(res.status).toBe(201);
    return ((await res.json()) as ImportUploadResponse).upload.id;
  }

  async function call(user: SeededUser, method: string, path: string, body?: unknown): Promise<Response> {
    return app.request(path, {
      method,
      headers: await authHeaders(user, { "Content-Type": "application/json" }),
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }

  async function finished(job: Job): Promise<Job> {
    const done = await jobs.waitForJob(job.id);
    if (!done) throw new Error("job vanished");
    return done;
  }

  beforeAll(async () => {
    instance = await startTestInstance();
    const server = await import("../../src/server");
    jobs = await import("../../src/jobs");
    env = await import("../../src/env");
    service = await import("../../src/imports/service");
    run = await import("../../src/imports/run");
    codeObjects = await import("../../src/mariadb/codeObjects");
    controller = await import("../../src/mariadb/controller");
    app = server.buildApp();
    owner = seedUser("db_owner");
    other = seedUser("db_owner");
    viewer = seedUser("viewer");
    admin = seedUser("admin");
  }, T);

  afterAll(async () => {
    await instance?.stop();
  }, T);

  test("viewers cannot upload, unknown formats get 415 naming what they are", async () => {
    expect((await upload(viewer, new TextEncoder().encode("CREATE TABLE t (a int);"), "x.sql")).status).toBe(403);
    const access = new Uint8Array(2048);
    access.set(new TextEncoder().encode("Standard Jet DB"), 4);
    const res = await upload(owner, access, "players.db");
    expect(res.status).toBe(415);
    expect(((await res.json()) as { error: string }).error).toBe(
      "This looks like a Microsoft Access database; only SQLite databases and MySQL/MariaDB dump files (.sql or .sql.gz) can be imported",
    );
    const missingName = await app.request("/api/imports/uploads", { method: "POST", headers: await authHeaders(owner), body: "x" });
    expect(missingName.status).toBe(400);
  }, T);

  test("the size limit is enforced while streaming and leaves no partial file", async () => {
    process.env.LAMBDATA_IMPORT_MAX_BYTES = "200000";
    try {
      const before = readdirSync(env.env.importsDir).length;
      let sent = 0;
      const stream = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (sent >= 1_000_000) return controller.close();
          const chunk = new Uint8Array(65536).fill(0x41);
          if (sent === 0) chunk.set(new TextEncoder().encode("INSERT INTO t VALUES ('"));
          sent += chunk.byteLength;
          controller.enqueue(chunk);
        },
      });
      const res = await upload(owner, stream, "big.sql");
      expect(res.status).toBe(413);
      expect(((await res.json()) as { error: string }).error).toMatch(/larger than the 195 KB import limit/);
      expect(sent).toBeLessThan(1_000_000);
      expect(readdirSync(env.env.importsDir).length).toBe(before);
      const declared = await app.request("/api/imports/uploads", {
        method: "POST",
        headers: await authHeaders(owner, { "X-File-Name": "a.sql", "Content-Length": "999999999" }),
        body: "SET x = 1;",
      });
      expect(declared.status).toBe(413);
    } finally {
      delete process.env.LAMBDATA_IMPORT_MAX_BYTES;
    }
  }, T);

  test("a Garry's Mod sv.db goes upload, plan, create, job, and every value matches; then replace from a second file", async () => {
    const path = gmodFixture(2000);
    const uploadId = await uploadFile(owner, path, "sv.db");
    expect((await call(other, "GET", `/api/imports/uploads/${uploadId}/plan`)).status).toBe(404);
    expect((await call(admin, "GET", `/api/imports/uploads/${uploadId}/plan`)).status).toBe(200);
    const planRes = await call(owner, "GET", `/api/imports/uploads/${uploadId}/plan`);
    expect(planRes.status).toBe(200);
    const plan = ((await planRes.json()) as ImportPlanResponse).plan as SqliteImportPlan;
    expect(plan.format).toBe("sqlite");
    expect(plan.totals).toMatchObject({ tables: 4, rows: 2000 * 4 + 3 });
    expect(plan.upload.fileName).toBe("sv.db");
    const again = ((await (await call(owner, "GET", `/api/imports/uploads/${uploadId}/plan`)).json()) as ImportPlanResponse).plan;
    expect(again).toEqual(plan);

    expect((await call(viewer, "POST", `/api/imports/uploads/${uploadId}/create-database`, { displayName: "Nope" })).status).toBe(403);
    expect((await call(other, "POST", `/api/imports/uploads/${uploadId}/create-database`, { displayName: "Nope" })).status).toBe(404);
    const created = await call(owner, "POST", `/api/imports/uploads/${uploadId}/create-database`, { displayName: "Gmod Server", versioned: true });
    expect(created.status).toBe(202);
    const body = (await created.json()) as ImportCreateDatabaseResponse;
    expect(body.job.kind).toBe("import.sqlite");
    expect(body.database.versioned).toBe(true);
    const job = await finished(body.job);
    expect(job.error).toBeNull();
    expect(job.status).toBe("succeeded");
    const importCheckpointId = (job.result as { checkpointId: string }).checkpointId;
    expect(typeof importCheckpointId).toBe("string");
    expect(job.result).toMatchObject({ tableCount: 4, rowCount: 8003, safetyCheckpointId: null });
    const schema = body.database.name;

    const bp = await planFor(path);
    for (const t of bp.tables) {
      const { sqlite, maria } = await canonicalRows(path, bp, t.sourceName, schema);
      expect(maria).toEqual(sqlite);
    }
    const conn = await mysql.createConnection({
      host: "127.0.0.1",
      port: instance.mariadbPort,
      user: body.credentials!.user,
      password: body.credentials!.password,
      database: body.credentials!.schema,
      supportBigNumbers: true,
      bigNumberStrings: true,
    });
    try {
      const [rows] = await conn.query("SELECT uid, rpname FROM darkrp_player WHERE uid = 76561197960265728 + 7919");
      expect(rows as unknown).toEqual([{ uid: "76561197960273647", rpname: "Player 1" }]);
      const [cookies] = await conn.query("SELECT value FROM cookies WHERE `key` = 'LastRun'");
      expect(cookies as unknown).toEqual([{ value: "2" }]);
    } finally {
      await conn.end();
    }
    expect((await call(owner, "GET", `/api/imports/uploads/${uploadId}`)).status).toBe(404);
    const history = ((await (await call(owner, "GET", `/api/databases/${body.database.id}/imports`)).json()) as ImportListResponse).imports;
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({ mode: "create", format: "sqlite", fileName: "sv.db", tableCount: 4, rowCount: 8003 });

    const second = buildSqlite((db) => {
      db.exec("CREATE TABLE cookies ( key TEXT NOT NULL PRIMARY KEY, value TEXT )");
      ins(db, "INSERT INTO cookies VALUES (?, ?)", ["fresh", "yes"]);
    });
    const secondId = await uploadFile(owner, second, "sv-new.db");
    expect((await call(other, "POST", `/api/databases/${body.database.id}/imports`, { uploadId: secondId })).status).toBe(403);
    const replaced = await call(owner, "POST", `/api/databases/${body.database.id}/imports`, { uploadId: secondId });
    expect(replaced.status).toBe(202);
    const replaceJob = await finished(((await replaced.json()) as { job: Job }).job);
    expect(replaceJob.error).toBeNull();
    const tables = await rootQuery<{ TABLE_NAME: string }>("SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = ?", [schema]);
    expect(tables.map((t) => t.TABLE_NAME)).toEqual(["cookies"]);
    expect(await mariaQuery(schema, "SELECT `key`, value FROM cookies")).toEqual([{ key: "fresh", value: "yes" }]);
    expect(await rootQuery("SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE SCHEMA_NAME LIKE '\\_ld\\_%'")).toEqual([]);
    const after = ((await (await call(owner, "GET", `/api/databases/${body.database.id}/imports`)).json()) as ImportListResponse).imports;
    expect(after.map((r) => r.mode)).toEqual(["replace", "create"]);

    const replaceResult = replaceJob.result as { safetyCheckpointId: string | null; checkpointId: string | null };
    expect(replaceResult.safetyCheckpointId).toBe(importCheckpointId);
    expect(typeof replaceResult.checkpointId).toBe("string");
    expect(replaceResult.checkpointId).not.toBe(importCheckpointId);
    const listed = (await (await call(owner, "GET", `/api/databases/${body.database.id}/checkpoints`)).json()) as {
      checkpoints: { id: string; trigger: string; message: string; isBase: boolean }[];
    };
    expect(listed.checkpoints.map((c) => c.trigger)).toEqual(["import", "import"]);
    expect(listed.checkpoints.map((c) => c.message)).toEqual(["Imported from sv-new.db", "Imported from sv.db"]);
    expect(listed.checkpoints[0]).toMatchObject({ id: replaceResult.checkpointId, isBase: true });

    const undone = await call(owner, "POST", `/api/databases/${body.database.id}/checkpoints/${importCheckpointId}/restore`, {});
    expect(undone.status).toBe(202);
    const undoJob = await finished(((await undone.json()) as { job: Job }).job);
    expect(undoJob.error).toBeNull();
    const restored = await rootQuery<{ TABLE_NAME: string }>(
      "SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME",
      [schema],
    );
    expect(restored).toHaveLength(4);
    expect(await mariaQuery(schema, "SELECT value FROM cookies WHERE `key` = 'LastRun'")).toEqual([{ value: "2" }]);
  }, T);

  test("a .sql.gz dump creates a database; foreign DEFINERs end up as the database's own user; replace swaps it", async () => {
    const dump = [
      "/*M!999999\\- enable the sandbox mode */ ",
      "CREATE DATABASE /*!32312 IF NOT EXISTS*/ `old_name` /*!40100 DEFAULT CHARACTER SET utf8mb4 */;",
      "USE `old_name`;",
      "CREATE TABLE `bans` (`steamid` bigint NOT NULL, `reason` text, PRIMARY KEY (`steamid`));",
      "INSERT INTO `bans` VALUES (76561198000000001,'aimbot'),(76561198000000002,NULL);",
      "CREATE TABLE `audit` (`n` int);",
      "/*!50001 CREATE ALGORITHM=UNDEFINED */",
      "/*!50013 DEFINER=`ld_someone_else`@`%` SQL SECURITY DEFINER */",
      "/*!50001 VIEW `ban_count` AS select count(0) AS `n` from `bans` */;",
      "DELIMITER ;;",
      "/*!50003 CREATE*/ /*!50017 DEFINER=`root`@`localhost`*/ /*!50003 TRIGGER bans_ai AFTER INSERT ON bans FOR EACH ROW INSERT INTO audit VALUES (1) */;;",
      "DELIMITER ;",
      "",
    ].join("\n");
    const res = await upload(owner, new Uint8Array(gzipSync(dump)), "checkpoint.sql.gz");
    expect(res.status).toBe(201);
    const up = ((await res.json()) as ImportUploadResponse).upload;
    expect(up.format).toBe("sql");
    const plan = ((await (await call(owner, "GET", `/api/imports/uploads/${up.id}/plan`)).json()) as ImportPlanResponse).plan;
    expect(plan).toMatchObject({ format: "sql", compressed: true });
    expect(plan.warnings.join(" ")).toMatch(/old_name/);
    expect(plan.warnings.join(" ")).toMatch(/DEFINER/);
    const created = (await (await call(owner, "POST", `/api/imports/uploads/${up.id}/create-database`, { displayName: "From Dump" })).json()) as ImportCreateDatabaseResponse;
    const job = await finished(created.job);
    expect(job.error).toBeNull();
    expect(job.kind).toBe("import.sql");
    expect(job.result).toMatchObject({ outcome: "done", codeFailures: [] });
    const schema = created.database.name;
    const expectedDefiner = `${created.database.mysqlUser}@${created.database.connectionsFrom}`;
    const views = await rootQuery<{ DEFINER: string }>("SELECT DEFINER FROM information_schema.VIEWS WHERE TABLE_SCHEMA = ?", [schema]);
    expect(views).toEqual([{ DEFINER: expectedDefiner }]);
    const triggers = await rootQuery<{ DEFINER: string }>("SELECT DEFINER FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = ?", [schema]);
    expect(triggers).toEqual([{ DEFINER: expectedDefiner }]);
    expect(await mariaQuery(schema, "SELECT CAST(steamid AS CHAR) AS s, reason FROM bans ORDER BY steamid")).toEqual([
      { s: "76561198000000001", reason: "aimbot" },
      { s: "76561198000000002", reason: null },
    ]);
    expect(await mariaQuery(schema, "SELECT CAST(n AS CHAR) AS n FROM ban_count")).toEqual([{ n: "2" }]);
    expect(await rootQuery("SELECT User FROM mysql.user WHERE User LIKE 'ld\\_imp\\_%'")).toEqual([]);

    const replacement = "CREATE TABLE `bans` (`steamid` bigint NOT NULL PRIMARY KEY, `reason` text);\nINSERT INTO `bans` VALUES (76561198000000009,'new');\nCREATE DEFINER=`x`@`y` VIEW recent AS SELECT steamid FROM bans;\n";
    const replaceId = (((await (await upload(owner, new TextEncoder().encode(replacement), "next.sql")).json()) as ImportUploadResponse).upload).id;
    const accepted = await call(owner, "POST", `/api/databases/${created.database.id}/imports`, { uploadId: replaceId });
    expect(accepted.status).toBe(202);
    const conflict = await call(owner, "POST", `/api/databases/${created.database.id}/imports`, { uploadId: replaceId });
    expect(conflict.status).toBe(409);
    const replaceJob = await finished(((await accepted.json()) as { job: Job }).job);
    expect(replaceJob.error).toBeNull();
    expect(replaceJob.result).toMatchObject({ outcome: "done", codeFailures: [] });
    expect(await mariaQuery(schema, "SELECT CAST(steamid AS CHAR) AS s FROM bans")).toEqual([{ s: "76561198000000009" }]);
    const newViews = await rootQuery<{ TABLE_NAME: string; DEFINER: string }>("SELECT TABLE_NAME, DEFINER FROM information_schema.VIEWS WHERE TABLE_SCHEMA = ?", [schema]);
    expect(newViews).toEqual([{ TABLE_NAME: "recent", DEFINER: expectedDefiner }]);
    expect(await rootQuery("SELECT Db FROM mysql.db WHERE INSTR(Db, 'stage') > 0")).toEqual([]);
    expect(await rootQuery("SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE SCHEMA_NAME LIKE '\\_ld\\_%'")).toEqual([]);
  }, T);

  test("a replace whose view cannot be created at the swap finishes with errors and names the view", async () => {
    const created = (await (await call(owner, "POST", "/api/databases", { displayName: "Rates Target" })).json()) as ImportCreateDatabaseResponse;
    const schema = created.database.name;
    await rootQuery("CREATE DATABASE IF NOT EXISTS zz_import_rates");
    await rootQuery("CREATE TABLE IF NOT EXISTS zz_import_rates.rates (id INT PRIMARY KEY, r INT)");
    await mariaQuery(schema, "CREATE TABLE old (id INT)");
    await mariaQuery(schema, "CREATE VIEW v_rates AS SELECT r FROM zz_import_rates.rates");
    const conn = await controller.openAdminConnection();
    let outside: Awaited<ReturnType<typeof codeObjects.captureCodeRecords>>[number];
    try {
      outside = (await codeObjects.captureCodeRecords(conn, schema)).find((r) => r.name === "v_rates")!;
    } finally {
      await conn.end();
    }
    await mariaQuery(schema, "DROP VIEW v_rates");
    const dump = "CREATE TABLE `bans` (`steamid` bigint NOT NULL PRIMARY KEY, `reason` text);\nINSERT INTO `bans` VALUES (76561198000000009,'new');\nCREATE VIEW recent AS SELECT steamid FROM bans;\n";
    const uploadId = (((await (await upload(owner, new TextEncoder().encode(dump), "rates.sql")).json()) as ImportUploadResponse).upload).id;
    const realSwap = run.importSwap.run;
    run.importSwap.run = (opts) => realSwap({ ...opts, code: [...(opts.code ?? []), outside] });
    let job: Job;
    try {
      const accepted = await call(owner, "POST", `/api/databases/${created.database.id}/imports`, { uploadId });
      expect(accepted.status).toBe(202);
      job = await finished(((await accepted.json()) as { job: Job }).job);
    } finally {
      run.importSwap.run = realSwap;
    }
    expect(job.error).toBeNull();
    expect(job.status).toBe("succeeded");
    const result = job.result as unknown as ImportJobResult;
    expect(result.outcome).toBe("done-with-errors");
    expect(result.codeFailures?.map((f) => `${f.kind}:${f.name}`)).toEqual(["VIEW:v_rates"]);
    expect(result.codeFailures![0]!.error).not.toMatch(/ld_scp_|ld_imp_/);
    const note = job.warnings.find((w) => w.startsWith("The data was replaced"))!;
    expect(note).toContain(
      "1 view(s), trigger(s), routine(s) or event(s) from the file could not be created and are missing from the database: view v_rates (it reads `zz_import_rates`.`rates` outside this database, which LambData does not re-create automatically)",
    );
    expect(note).toMatch(/The previous contents are saved in checkpoint [0-9a-f]{7}\./);
    expect(await mariaQuery(schema, "SELECT CAST(steamid AS CHAR) AS s FROM bans")).toEqual([{ s: "76561198000000009" }]);
    expect(await rootQuery("SELECT TABLE_NAME FROM information_schema.VIEWS WHERE TABLE_SCHEMA = ?", [schema])).toEqual([{ TABLE_NAME: "recent" }]);
  }, T);

  test("a hostile dump fails the job, keeps the new database empty, and says so", async () => {
    const victim = (await (await call(admin, "POST", "/api/databases", { displayName: "Victim" })).json()) as ImportCreateDatabaseResponse;
    await mariaQuery(victim.database.name, "CREATE TABLE t (id INT)");
    await mariaQuery(victim.database.name, "INSERT INTO t VALUES (7)");
    const sql = `CREATE TABLE partial (id INT);\nINSERT INTO partial VALUES (1);\nDELETE FROM \`${victim.database.name}\`.t;\n`;
    const id = (((await (await upload(owner, new TextEncoder().encode(sql), "evil.sql")).json()) as ImportUploadResponse).upload).id;
    const created = (await (await call(owner, "POST", `/api/imports/uploads/${id}/create-database`, { displayName: "Evil Import" })).json()) as ImportCreateDatabaseResponse;
    const job = await finished(created.job);
    expect(job.status).toBe("failed");
    expect(job.error).toMatch(/was kept and is empty/);
    expect(job.error).toMatch(/outside its own database/);
    expect(await rootQuery("SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = ?", [created.database.name])).toEqual([]);
    expect(await mariaQuery(victim.database.name, "SELECT id FROM t")).toEqual([{ id: 7 }]);
    expect((await call(owner, "GET", `/api/databases/${created.database.id}`)).status).toBe(200);
    expect((((await (await call(owner, "GET", `/api/databases/${created.database.id}/imports`)).json()) as ImportListResponse).imports)).toEqual([]);
  }, T);

  test("expired uploads and orphan files are removed by the imports service", async () => {
    const path = buildSqlite((db) => db.exec("CREATE TABLE t (a)"));
    const id = await uploadFile(owner, path, "old.db");
    await Bun.write(`${env.env.importsDir}/upl_${"a".repeat(32)}`, "orphan");
    const result = await service.cleanupImports(Date.now() + 25 * 60 * 60 * 1000);
    expect(result.uploads).toContain(id);
    expect(result.uploads).toContain(`upl_${"a".repeat(32)}`);
    expect(readdirSync(env.env.importsDir).filter((n) => n.startsWith(id) || n.startsWith("upl_aaaa"))).toEqual([]);
    expect((await call(owner, "GET", `/api/imports/uploads/${id}`)).status).toBe(404);
  }, T);
});
