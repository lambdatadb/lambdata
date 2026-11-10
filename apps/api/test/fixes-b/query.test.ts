import { mariadbAvailable, rootQuery, startTestInstance, type TestInstance } from "../harness/instance";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { authHeaders, seedUser, type SeededUser } from "../harness/sqlite";
import { buildApp } from "../../src/server";
import { codeTokens, queryLimits, viewerStatementRefusal } from "../../src/routes/query";

const STEAM_ID = "76561198000000008";

describe("viewer statement policy", () => {
  const refused = [
    "UPDATE t SET v = 1",
    "SET STATEMENT transaction_read_only=0 FOR UPDATE t SET v = 1",
    "/*!SET STATEMENT transaction_read_only=0 FOR*/ SELECT bump()",
    "/*M!100000 SET STATEMENT transaction_read_only=0 FOR*/ SELECT bump()",
    "/* plain */ SET STATEMENT tx_read_only=0 FOR DROP TABLE t",
    "KILL 1",
    "DO SLEEP(1)",
    "LOCK TABLES t WRITE",
    "HANDLER t OPEN",
    "SELECT * FROM t FOR UPDATE",
    "SELECT * FROM t LOCK IN SHARE MODE",
    "SELECT * FROM t lock   in\nshare mode",
    "SELECT GET_LOCK('x', 0)",
    "SELECT get_lock ('x', 0)",
    "SELECT 1 FROM t /*!FOR UPDATE*/",
    "SELECT 1 FROM t /*!50000 LOCK IN SHARE MODE */",
    "SELECT 'it\\' FOR UPDATE",
    "",
    "-- just a comment",
  ];
  const allowed = [
    "SELECT 1",
    "select * from t",
    "  (SELECT 1) UNION (SELECT 2)",
    "WITH x AS (SELECT 1) SELECT * FROM x",
    "SHOW TABLES",
    "DESCRIBE t",
    "DESC t",
    "EXPLAIN SELECT * FROM t",
    "VALUES (1), (2)",
    "SELECT 'for update', \"lock in share mode\" FROM t",
    "SELECT `for update`, `get_lock` FROM t",
    "SELECT 1 -- FOR UPDATE",
    "SELECT 1 # LOCK IN SHARE MODE",
    "SELECT 1 /* FOR UPDATE */",
    "/* leading */ SELECT 1",
    "SELECT 1--1",
    "SELECT 'it''s' AS a",
  ];

  test("refuses statement kinds and locking reads that the read-only session does not stop", () => {
    for (const sql of refused) expect({ sql, refused: viewerStatementRefusal(sql) !== null }).toEqual({ sql, refused: true });
  });

  test("admits plain reads, including lookalikes inside strings, identifiers and comments", () => {
    for (const sql of allowed) expect({ sql, refusal: viewerStatementRefusal(sql) }).toEqual({ sql, refusal: null });
  });

  test("the lexer keeps executable comments as code and drops ordinary comments", () => {
    expect(codeTokens("/*!SET*/ SELECT /* x */ 1 -- y\n , 'z'")).toEqual(["SET", "SELECT", "1", ",", "'literal'"]);
    expect(codeTokens("SELECT 1--1")).toEqual(["SELECT", "1", "-", "-", "1"]);
  });
});

describe.skipIf(!mariadbAvailable())("query runner", () => {
  let instance: TestInstance;
  let app: ReturnType<typeof buildApp>;
  let admin: SeededUser;
  let viewer: SeededUser;
  let dbId: string;
  let schema: string;

  beforeAll(async () => {
    instance = await startTestInstance();
    app = buildApp();
    admin = seedUser("admin");
    viewer = seedUser("viewer");
    const res = await app.request("/api/databases", {
      method: "POST",
      headers: await authHeaders(admin, { "Content-Type": "application/json" }),
      body: JSON.stringify({ displayName: `fixes b query ${Date.now().toString(36)}` }),
    });
    expect(res.status).toBe(200);
    const { database } = await res.json();
    dbId = database.id;
    schema = database.name;
    await rootQuery(
      `CREATE TABLE \`${schema}\`.players (steam_id BIGINT UNSIGNED PRIMARY KEY, score INT, credit DECIMAL(20,0), profile JSON)`,
    );
    await rootQuery(
      `INSERT INTO \`${schema}\`.players VALUES (${STEAM_ID}, 1, ${STEAM_ID}, JSON_OBJECT('steam_id', ${STEAM_ID})), (5, 2, 5, NULL)`,
    );
    await rootQuery(
      `CREATE FUNCTION \`${schema}\`.bump() RETURNS INT MODIFIES SQL DATA BEGIN UPDATE \`${schema}\`.players SET score = score + 1; RETURN 1; END`,
    );
  }, 180_000);

  afterAll(async () => {
    await instance?.stop();
  }, 120_000);

  afterEach(() => {
    queryLimits.timeoutMs = 30_000;
  });

  async function run(user: SeededUser, sql: string): Promise<Response> {
    return app.request(`/api/databases/${dbId}/query`, {
      method: "POST",
      headers: await authHeaders(user, { "Content-Type": "application/json" }),
      body: JSON.stringify({ sql }),
    });
  }

  async function scores(): Promise<number[]> {
    const rows = await rootQuery<{ score: number }>(`SELECT score FROM \`${schema}\`.players ORDER BY steam_id`);
    return rows.map((r) => Number(r.score));
  }

  test("64-bit SteamIDs come back exact for every role", async () => {
    for (const user of [admin, viewer]) {
      const res = await run(
        user,
        "SELECT steam_id, steam_id + 0, CAST(steam_id AS CHAR), credit, profile, score FROM players ORDER BY steam_id",
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.rows).toEqual([
        [5, 5, "5", "5", null, 2],
        [STEAM_ID, STEAM_ID, STEAM_ID, STEAM_ID, `{"steam_id": ${STEAM_ID}}`, 1],
      ]);
      const agg = await (await run(user, "SELECT MAX(steam_id), SUM(steam_id), 18446744073709551615 FROM players")).json();
      expect(agg.rows).toEqual([[STEAM_ID, "76561198000000013", "18446744073709551615"]]);
    }
  }, 60_000);

  test("a viewer cannot write through an executable-comment SET STATEMENT override", async () => {
    const before = await scores();
    const res = await run(viewer, "/*!SET STATEMENT transaction_read_only=0 FOR*/ SELECT bump()");
    expect(res.status).toBe(403);
    const dropped = await run(viewer, "SET STATEMENT transaction_read_only=0 FOR DROP TABLE players");
    expect(dropped.status).toBe(403);
    expect(await scores()).toEqual(before);
  }, 60_000);

  test("the read-only session refuses writes the statement policy lets through", async () => {
    const before = await scores();
    const res = await run(viewer, "SELECT bump()");
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe("viewers have read-only access: this statement would change data");
    expect(await scores()).toEqual(before);
  }, 60_000);

  test("viewers cannot take locks; admins can", async () => {
    for (const sql of ["SELECT * FROM players LOCK IN SHARE MODE", "SELECT GET_LOCK('fixes_b', 0)"]) {
      const res = await run(viewer, sql);
      expect(res.status).toBe(403);
      expect((await res.json()).error).toContain("locking reads");
      expect((await run(admin, sql)).status).toBe(200);
    }
  }, 60_000);

  test("a query that runs past the limit gets a clear 400", async () => {
    queryLimits.timeoutMs = 1_000;
    const started = Date.now();
    const res = await run(viewer, "SELECT SLEEP(5)");
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("Query cancelled: it ran longer than the 1s limit");
    expect(Date.now() - started).toBeLessThan(4_500);
  }, 60_000);

  test("SQL errors are 400 with the server message; bad bodies are 400", async () => {
    const res = await run(admin, "SELECT * FROM no_such_table");
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("doesn't exist");
    expect((await run(admin, "   ")).status).toBe(400);
    const notJson = await app.request(`/api/databases/${dbId}/query`, {
      method: "POST",
      headers: await authHeaders(admin, { "Content-Type": "application/json" }),
      body: "{",
    });
    expect(notJson.status).toBe(400);
  }, 60_000);
});
