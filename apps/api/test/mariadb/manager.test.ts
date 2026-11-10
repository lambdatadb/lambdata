import { createTestDatabase, mariadbAvailable, rootQuery, startTestInstance, type TestInstance } from "../harness/instance";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import mysql from "mysql2/promise";
import { env } from "../../src/env";
import { QueryTimeoutError, executeUserQuery, updateAllowedHost } from "../../src/mariadb/manager";

function escaped(schema: string): string {
  return schema.replaceAll("_", "\\_");
}

async function hostsFor(user: string): Promise<string[]> {
  const rows = await rootQuery<{ host: string }>(`SELECT Host AS host FROM mysql.user WHERE User = ? ORDER BY Host`, [user]);
  return rows.map((r) => r.host);
}

async function grantsFor(user: string, host: string): Promise<string> {
  const rows = await rootQuery<Record<string, string>>(`SHOW GRANTS FOR ?@?`, [user, host]);
  return rows.map((r) => Object.values(r)[0]).join("\n");
}

async function canUse(db: { schema: string; user: string; password: string }): Promise<boolean> {
  try {
    const conn = await mysql.createConnection({
      host: "127.0.0.1",
      port: env.mariadbPort,
      user: db.user,
      password: db.password,
      database: db.schema,
    });
    await conn.query("SELECT 1");
    await conn.end();
    return true;
  } catch {
    return false;
  }
}

describe.skipIf(!mariadbAvailable())("mariadb manager", () => {
  let instance: TestInstance | null = null;

  beforeAll(async () => {
    instance = await startTestInstance();
  }, 120_000);

  afterAll(async () => {
    await instance?.stop();
  }, 60_000);

  test("updateAllowedHost renames the account and keeps its grants", async () => {
    const db = await createTestDatabase();
    const extra = `${db.schema}_extra`;
    await rootQuery(`CREATE DATABASE \`${extra}\``);
    await rootQuery(`GRANT SELECT ON \`${extra}\`.* TO ?@'%'`, [db.user]);
    expect(await hostsFor(db.user)).toEqual(["%"]);

    await updateAllowedHost({ user: db.user, oldHost: "%", newHost: "127.0.0.1", password: db.password, schema: db.schema });
    expect(await hostsFor(db.user)).toEqual(["127.0.0.1"]);
    const grants = await grantsFor(db.user, "127.0.0.1");
    expect(grants).toContain(`\`${escaped(db.schema)}\``);
    expect(grants).toContain(`\`${extra}\``);
    expect(await canUse(db)).toBe(true);
    await rootQuery(`DROP DATABASE \`${extra}\``);
  });

  test("updateAllowedHost creates the new account first when the old one is missing", async () => {
    const db = await createTestDatabase();
    await updateAllowedHost({ user: db.user, oldHost: "%", newHost: "127.0.0.1", password: db.password, schema: db.schema });
    await updateAllowedHost({ user: db.user, oldHost: "10.9.8.%", newHost: "%", password: db.password, schema: db.schema });
    expect(await hostsFor(db.user)).toEqual(["%", "127.0.0.1"]);
    expect(await grantsFor(db.user, "%")).toContain(`\`${escaped(db.schema)}\``);

    await updateAllowedHost({ user: db.user, oldHost: "127.0.0.1", newHost: "%", password: db.password, schema: db.schema });
    expect(await hostsFor(db.user)).toEqual(["%"]);
    expect(await canUse(db)).toBe(true);

    await updateAllowedHost({ user: db.user, oldHost: "%", newHost: "%", password: db.password, schema: db.schema });
    expect(await hostsFor(db.user)).toEqual(["%"]);
    expect(await canUse(db)).toBe(true);
  });

  test("executeUserQuery stops a long statement with a clear error", async () => {
    const db = await createTestDatabase();
    const started = Date.now();
    let err: unknown = null;
    await executeUserQuery({ ...db, sql: "SELECT SLEEP(10)", timeoutMs: 1_000 }).catch((e) => {
      err = e;
    });
    expect(err).toBeInstanceOf(QueryTimeoutError);
    expect((err as Error).message).toBe("Query cancelled: it ran longer than the 1s limit");
    expect(Date.now() - started).toBeLessThan(5_000);

    let cpu: unknown = null;
    await executeUserQuery({
      ...db,
      sql: "SELECT COUNT(*) FROM information_schema.COLUMNS a, information_schema.COLUMNS b, information_schema.COLUMNS c",
      timeoutMs: 500,
    }).catch((e) => {
      cpu = e;
    });
    expect(cpu).toBeInstanceOf(QueryTimeoutError);
  }, 30_000);

  test("the client-side backstop kills a statement that disables the server limit", async () => {
    const db = await createTestDatabase();
    const started = Date.now();
    let err: unknown = null;
    await executeUserQuery({
      ...db,
      sql: "SET STATEMENT max_statement_time = 0 FOR SELECT SLEEP(20) AS backstop_probe",
      timeoutMs: 1_000,
    }).catch((e) => {
      err = e;
    });
    expect(err).toBeInstanceOf(QueryTimeoutError);
    expect(Date.now() - started).toBeLessThan(8_000);
    await Bun.sleep(300);
    const running = await rootQuery(
      `SELECT ID FROM information_schema.PROCESSLIST WHERE INFO LIKE '%backstop_probe%' AND INFO NOT LIKE '%PROCESSLIST%'`,
    );
    expect(running).toEqual([]);
  }, 30_000);

  test("read-only sessions still reject writes", async () => {
    const db = await createTestDatabase();
    await rootQuery(`CREATE TABLE \`${db.schema}\`.t (id INT)`);
    await expect(executeUserQuery({ ...db, sql: "INSERT INTO t VALUES (1)", readOnly: true })).rejects.toThrow(/READ ONLY/i);
    const ok = await executeUserQuery({ ...db, sql: "SELECT COUNT(*) FROM t", readOnly: true });
    expect(ok.rows).toEqual([[0]]);
  });

  test("big integers come back as exact strings and small ones as numbers", async () => {
    const db = await createTestDatabase();
    await rootQuery(`CREATE TABLE \`${db.schema}\`.ids (id BIGINT UNSIGNED PRIMARY KEY, s BIGINT)`);
    await rootQuery(
      `INSERT INTO \`${db.schema}\`.ids VALUES (76561198000000008, -9223372036854775808), (18446744073709551615, 5), (7, 9007199254740991)`,
    );
    const res = await executeUserQuery({ ...db, sql: "SELECT id, s FROM ids ORDER BY id" });
    expect(res.rows).toEqual([
      [7, 9007199254740991],
      ["76561198000000008", "-9223372036854775808"],
      ["18446744073709551615", 5],
    ]);
    const literal = await executeUserQuery({ ...db, sql: "SELECT 76561198000000008 AS a, 42 AS b" });
    expect(literal.rows).toEqual([["76561198000000008", 42]]);
  });
});
