import { mariadbAvailable, rootQuery, startTestInstance, type TestInstance } from "../harness/instance";
import { authHeaders, seedUser, useTempMetadata, type TempMetadata } from "../harness/sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import mysql from "mysql2/promise";
import { env } from "../../src/env";
import { databases, users } from "../../src/db/queries";
import { buildApp } from "../../src/server";

async function schemaExists(name: string): Promise<boolean> {
  const rows = await rootQuery<{ n: number }>("SELECT COUNT(*) AS n FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = ?", [name]);
  return Number(rows[0]?.n ?? 0) > 0;
}

async function provisionThroughRoute(displayName: string) {
  const admin = seedUser("admin");
  const headers = await authHeaders(admin, { "Content-Type": "application/json" });
  const res = await buildApp().request("/api/databases", {
    method: "POST",
    headers,
    body: JSON.stringify({ displayName }),
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as {
    database: { id: string; name: string };
    credentials: { user: string; password: string; schema: string };
  };
  expect(databases.byId(body.database.id)?.ownerUserId).toBe(admin.id);
  expect(await schemaExists(body.database.name)).toBe(true);
  const conn = await mysql.createConnection({
    host: "127.0.0.1",
    port: env.mariadbPort,
    user: body.credentials.user,
    password: body.credentials.password,
    database: body.credentials.schema,
  });
  try {
    await conn.query("CREATE TABLE t (id INT PRIMARY KEY)");
    await conn.query("INSERT INTO t VALUES (1)");
  } finally {
    await conn.end();
  }
  return { headers, body };
}

describe.skipIf(!mariadbAvailable())("both harnesses in one file: instance first", () => {
  let instance: TestInstance | null = null;
  let md: TempMetadata | null = null;

  beforeAll(async () => {
    instance = await startTestInstance();
    md = useTempMetadata();
  }, 120_000);

  afterAll(async () => {
    md?.cleanup();
    await instance?.stop();
  }, 60_000);

  test("a route seeded through the SQLite helpers runs against the real MariaDB", async () => {
    expect(users.list()).toEqual([]);
    const { headers, body } = await provisionThroughRoute("Mixed First");
    const del = await buildApp().request(`/api/databases/${body.database.id}`, { method: "DELETE", headers });
    expect(del.status).toBe(200);
    expect(await schemaExists(body.database.name)).toBe(false);
  });
});

describe.skipIf(!mariadbAvailable())("both harnesses in one file: metadata first", () => {
  let instance: TestInstance | null = null;
  let md: TempMetadata | null = null;

  beforeAll(async () => {
    md = useTempMetadata();
    seedUser("viewer");
    instance = await startTestInstance();
  }, 120_000);

  afterAll(async () => {
    await instance?.stop();
    md?.cleanup();
  }, 60_000);

  test("the instance adopts the seeded store and the route works against it", async () => {
    expect(users.list().map((u) => u.role)).toEqual(["viewer"]);
    expect(instance!.dataDir).toBe(md!.dataDir);
    await provisionThroughRoute("Mixed Second");
  });
});
