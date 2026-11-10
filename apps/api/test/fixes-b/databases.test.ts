import { mariadbAvailable, rootQuery, startTestInstance, type TestInstance } from "../harness/instance";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { authHeaders, seedUser, type SeededUser } from "../harness/sqlite";
import { buildApp } from "../../src/server";

describe.skipIf(!mariadbAvailable())("PATCH /api/databases/:id", () => {
  let instance: TestInstance;
  let app: ReturnType<typeof buildApp>;
  let admin: SeededUser;

  beforeAll(async () => {
    instance = await startTestInstance();
    app = buildApp();
    admin = seedUser("admin");
  }, 180_000);

  afterAll(async () => {
    await instance?.stop();
  }, 120_000);

  async function call(path: string, method: string, body?: unknown): Promise<Response> {
    return app.request(path, {
      method,
      headers: await authHeaders(admin, { "Content-Type": "application/json" }),
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }

  async function definers(schema: string): Promise<Record<string, string>> {
    const rows = await rootQuery<{ n: string; d: string }>(
      "SELECT TABLE_NAME AS n, DEFINER AS d FROM information_schema.VIEWS WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME",
      [schema],
    );
    return Object.fromEntries(rows.map((r) => [r.n, r.d]));
  }

  test("moving the account to a new host re-creates only its own objects and reports the ones it cannot", async () => {
    const created = await call("/api/databases", "POST", { displayName: `fixes b hosts ${Date.now().toString(36)}` });
    expect(created.status).toBe(200);
    const { database, credentials } = await created.json();
    await rootQuery(`CREATE TABLE \`${database.name}\`.t (id INT PRIMARY KEY)`);
    await rootQuery(`CREATE DEFINER = ?@'%' SQL SECURITY DEFINER VIEW \`${database.name}\`.mine AS SELECT id FROM \`${database.name}\`.t`, [
      credentials.user,
    ]);
    await rootQuery(`CREATE DEFINER = 'fixes_b_ghost'@'%' SQL SECURITY DEFINER VIEW \`${database.name}\`.ghost AS SELECT id FROM \`${database.name}\`.t`);

    const res = await call(`/api/databases/${database.id}`, "PATCH", { connectionsFrom: "127.0.0.1" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.database.connectionsFrom).toBe("127.0.0.1");
    expect(body.warnings).toEqual([]);
    expect(await definers(database.name)).toEqual({ ghost: "fixes_b_ghost@%", mine: `${credentials.user}@127.0.0.1` });

    await rootQuery("CREATE DATABASE IF NOT EXISTS zz_fixes_b_side");
    await rootQuery("CREATE TABLE IF NOT EXISTS zz_fixes_b_side.rates (id INT PRIMARY KEY)");
    await rootQuery(`CREATE DEFINER = ?@'127.0.0.1' SQL SECURITY DEFINER VIEW \`${database.name}\`.outside AS SELECT id FROM zz_fixes_b_side.rates`, [
      credentials.user,
    ]);
    const moved = await call(`/api/databases/${database.id}`, "PATCH", { connectionsFrom: "10.1.%" });
    expect(moved.status).toBe(200);
    const movedBody = await moved.json();
    expect(movedBody.warnings).toHaveLength(1);
    expect(movedBody.warnings[0]).toStartWith(
      `view outside could not be re-created for ${credentials.user}@10.1.% and still names the old host ${credentials.user}@127.0.0.1`,
    );
    expect(movedBody.warnings[0]).not.toMatch(/ld_scp_/);
    expect(await definers(database.name)).toEqual({
      ghost: "fixes_b_ghost@%",
      mine: `${credentials.user}@10.1.%`,
      outside: `${credentials.user}@127.0.0.1`,
    });

    const plain = await call(`/api/databases/${database.id}`, "PATCH", { displayName: "Renamed" });
    expect(await plain.json()).toMatchObject({ database: { displayName: "Renamed" }, warnings: [] });
  }, 120_000);
});
