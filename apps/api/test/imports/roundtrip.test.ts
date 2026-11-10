import { mariadbAvailable, rootQuery, startTestInstance, type TestInstance } from "../harness/instance";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import mysql from "mysql2/promise";
import type { DatabaseCredentials, ImportCreateDatabaseResponse, ImportUploadResponse, Job } from "@lambdata/shared";
import { authHeaders, seedUser, type SeededUser } from "../harness/sqlite";

const available = mariadbAvailable();
const T = 180_000;

async function connectAs(port: number, c: DatabaseCredentials): Promise<mysql.Connection> {
  return mysql.createConnection({
    host: "127.0.0.1",
    port,
    user: c.user,
    password: c.password,
    database: c.schema,
    supportBigNumbers: true,
    bigNumberStrings: true,
    multipleStatements: false,
  });
}

describe.skipIf(!available)("checkpoint download round trip", () => {
  let instance: TestInstance;
  let owner: SeededUser;
  let app: { request: (path: string, init?: RequestInit) => Response | Promise<Response> };
  let jobs: typeof import("../../src/jobs");
  let checkpoints: typeof import("../../src/checkpoints");

  beforeAll(async () => {
    instance = await startTestInstance();
    app = (await import("../../src/server")).buildApp();
    jobs = await import("../../src/jobs");
    checkpoints = await import("../../src/checkpoints");
    owner = seedUser("db_owner");
  }, T);

  afterAll(async () => {
    await instance?.stop();
  }, T);

  async function call(method: string, path: string, body?: unknown, extra: Record<string, string> = {}): Promise<Response> {
    return app.request(path, {
      method,
      headers: await authHeaders(owner, { "Content-Type": "application/json", ...extra }),
      body: (body === undefined ? undefined : body instanceof Uint8Array ? body : JSON.stringify(body)) as BodyInit | undefined,
    });
  }

  test("a downloaded checkpoint imports as a new database whose views, triggers and routines work as its own user", async () => {
    const source = (await (await call("POST", "/api/databases", { displayName: "Round Source" })).json()) as ImportCreateDatabaseResponse;
    const src = await connectAs(instance.mariadbPort, source.credentials);
    try {
      await src.query("CREATE TABLE players (steamid BIGINT NOT NULL PRIMARY KEY, name VARCHAR(32) NOT NULL, score INT NOT NULL)");
      await src.query("CREATE TABLE audit (id INT AUTO_INCREMENT PRIMARY KEY, n INT)");
      await src.query("INSERT INTO players VALUES (76561198000000001, 'alice', 10), (76561198000000002, 'Bob', 20), (76561198000000003, 'bob ', 30)");
      await src.query("CREATE FUNCTION double_score(s INT) RETURNS INT DETERMINISTIC RETURN s * 2");
      await src.query("CREATE PROCEDURE add_player(IN sid BIGINT, IN nm VARCHAR(32)) INSERT INTO players VALUES (sid, nm, 1)");
      await src.query("CREATE TRIGGER players_ai AFTER INSERT ON players FOR EACH ROW INSERT INTO audit (n) VALUES (NEW.score)");
      await src.query("CREATE VIEW top_players AS SELECT steamid, name, double_score(score) AS doubled FROM players WHERE score >= 20");
    } finally {
      await src.end();
    }
    const cp = await checkpoints.createCheckpoint(source.database.id, { trigger: "manual", message: "before export", userId: owner.id });
    expect(cp.checkpointId).not.toBeNull();
    const download = await call("GET", `/api/databases/${source.database.id}/checkpoints/${cp.checkpointId}/download`);
    expect(download.status).toBe(200);
    const bytes = new Uint8Array(await download.arrayBuffer());
    expect(bytes[0]).toBe(0x1f);

    const up = await call("POST", "/api/imports/uploads", bytes, {
      "Content-Type": "application/octet-stream",
      "X-File-Name": encodeURIComponent("round_source-checkpoint.sql.gz"),
    });
    expect(up.status).toBe(201);
    const uploadId = ((await up.json()) as ImportUploadResponse).upload.id;
    const created = (await (await call("POST", `/api/imports/uploads/${uploadId}/create-database`, { displayName: "Round Copy" })).json()) as ImportCreateDatabaseResponse;
    const job = (await jobs.waitForJob(created.job.id)) as Job;
    expect(job.error).toBeNull();
    expect(job.status).toBe("succeeded");

    const schema = created.database.name;
    const definer = `${created.database.mysqlUser}@${created.database.connectionsFrom}`;
    const definers = await rootQuery<{ kind: string; name: string; definer: string }>(
      `SELECT 'view' AS kind, TABLE_NAME AS name, DEFINER AS definer FROM information_schema.VIEWS WHERE TABLE_SCHEMA = ?
       UNION ALL SELECT LOWER(ROUTINE_TYPE), ROUTINE_NAME, DEFINER FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA = ?
       UNION ALL SELECT 'trigger', TRIGGER_NAME, DEFINER FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = ?
       ORDER BY kind, name`,
      [schema, schema, schema],
    );
    expect(definers).toEqual([
      { kind: "function", name: "double_score", definer },
      { kind: "procedure", name: "add_player", definer },
      { kind: "trigger", name: "players_ai", definer },
      { kind: "view", name: "top_players", definer },
    ]);

    for (const t of ["players", "audit"]) {
      const a = await rootQuery<{ Checksum: string }>(`CHECKSUM TABLE \`${source.database.name}\`.\`${t}\``);
      const b = await rootQuery<{ Checksum: string }>(`CHECKSUM TABLE \`${schema}\`.\`${t}\``);
      expect(String(b[0]!.Checksum)).toBe(String(a[0]!.Checksum));
    }

    const copy = await connectAs(instance.mariadbPort, created.credentials);
    try {
      const [view] = await copy.query("SELECT steamid, name, doubled FROM top_players ORDER BY steamid");
      expect(view as unknown).toEqual([
        { steamid: "76561198000000002", name: "Bob", doubled: 40 },
        { steamid: "76561198000000003", name: "bob ", doubled: 60 },
      ]);
      const [fn] = await copy.query("SELECT double_score(21) AS v");
      expect(fn as unknown).toEqual([{ v: 42 }]);
      await copy.query("CALL add_player(76561198000000004, 'carol')");
      const [audit] = await copy.query("SELECT n FROM audit ORDER BY id");
      expect(audit as unknown).toEqual([{ n: 1 }]);
      const [players] = await copy.query("SELECT CAST(steamid AS CHAR) AS s FROM players ORDER BY steamid");
      expect((players as { s: string }[]).map((r) => r.s)).toEqual([
        "76561198000000001",
        "76561198000000002",
        "76561198000000003",
        "76561198000000004",
      ]);
    } finally {
      await copy.end();
    }
    const [srcView] = await rootQuery<{ n: number }>(`SELECT COUNT(*) AS n FROM \`${source.database.name}\`.audit`);
    expect(Number(srcView!.n)).toBe(0);
  }, T);
});
