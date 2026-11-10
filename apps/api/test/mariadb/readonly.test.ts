import { mariadbAvailable, rootQuery, startTestInstance, type TestInstance } from "../harness/instance";
import { authHeaders, seedUser, type SeededUser } from "../harness/sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import mysql from "mysql2/promise";
import { env } from "../../src/env";
import { databases } from "../../src/db/queries";
import { readonlyAccounts } from "../../src/db/queries/readonlyAccounts";
import { deprovisionDatabase, provisionDatabase } from "../../src/databases/provision";
import { runSessionQuery } from "../../src/mariadb/manager";
import {
  ViewerAccessUnavailableError,
  ViewerQueryDeniedError,
  dropReadonlyAccount,
  executeViewerQuery,
  readonlyAccountHost,
  reconcileReadonlyAccounts,
} from "../../src/mariadb/readonly";
import { decryptSecret } from "../../src/util/crypto";
import { buildApp } from "../../src/server";

type Provisioned = { id: string; schema: string; user: string; password: string };

async function provision(owner: SeededUser, displayName: string): Promise<Provisioned> {
  const { database, credentials } = await provisionDatabase({ displayName, ownerUserId: owner.id });
  return { id: database.id, schema: database.name, user: credentials.user, password: credentials.password };
}

async function asOwner(db: Provisioned, ...statements: string[]): Promise<void> {
  const conn = await mysql.createConnection({
    host: "127.0.0.1",
    port: env.mariadbPort,
    user: db.user,
    password: db.password,
    database: db.schema,
  });
  try {
    for (const s of statements) await conn.query(s);
  } finally {
    await conn.end();
  }
}

async function readonlyGrants(databaseId: string): Promise<string[]> {
  const account = readonlyAccounts.byDatabaseId(databaseId)!;
  const rows = await rootQuery<Record<string, string>>("SHOW GRANTS FOR ?@?", [account.mysqlUser, account.mysqlHost]);
  return rows.map((r) => Object.values(r)[0]!.replace(/ IDENTIFIED BY PASSWORD '[^']*'/, ""));
}

async function accountState(): Promise<string[]> {
  const users = await rootQuery<{ u: string }>(
    "SELECT CONCAT(User, '@', Host) AS u FROM mysql.user WHERE User LIKE 'ldr\\_%' ORDER BY u",
  );
  const dbs = await rootQuery<{ d: string }>(
    "SELECT CONCAT(User, '@', Host, ':', Db, ':', Select_priv, Show_view_priv, Insert_priv, Execute_priv) AS d FROM mysql.db WHERE User LIKE 'ldr\\_%' ORDER BY d",
  );
  return [...users.map((r) => r.u), ...dbs.map((r) => r.d)];
}

async function withoutSessionLayer(databaseId: string, sql: string): Promise<number | undefined> {
  const account = readonlyAccounts.byDatabaseId(databaseId)!;
  const database = databases.byId(databaseId)!;
  try {
    await runSessionQuery({
      host: account.mysqlHost,
      user: account.mysqlUser,
      password: await decryptSecret(account.passwordEnc),
      schema: database.name,
      sql,
      readOnly: false,
    });
    return undefined;
  } catch (err) {
    return (err as { errno?: number }).errno;
  }
}

describe.skipIf(!mariadbAvailable())("read-only viewer accounts", () => {
  let instance: TestInstance | null = null;
  let owner: SeededUser;
  let shop: Provisioned;
  let other: Provisioned;

  beforeAll(async () => {
    instance = await startTestInstance();
    owner = seedUser("admin");
    shop = await provision(owner, "Viewer Shop");
    other = await provision(owner, "Viewer Other");
    await asOwner(
      shop,
      "CREATE TABLE t (id BIGINT UNSIGNED PRIMARY KEY, note VARCHAR(32))",
      "INSERT INTO t VALUES (1, 'a'), (76561198000000008, 'big')",
      "CREATE TABLE log (msg VARCHAR(32))",
      "CREATE FUNCTION bump() RETURNS INT MODIFIES SQL DATA BEGIN INSERT INTO log VALUES ('bumped'); RETURN 1; END",
      "CREATE PROCEDURE wipe() DELETE FROM t",
      "CREATE FUNCTION twice(x BIGINT) RETURNS BIGINT DETERMINISTIC NO SQL RETURN x * 2",
      "CREATE VIEW v_notes AS SELECT id, note FROM t",
      "CREATE VIEW v_bump AS SELECT bump() AS b",
    );
    await asOwner(other, "CREATE TABLE secret (id INT)", "INSERT INTO secret VALUES (42)");
  }, 180_000);

  afterAll(async () => {
    await instance?.stop();
  }, 60_000);

  test("provisioning creates a read-only account bound to the API host with SELECT and SHOW VIEW only", async () => {
    const account = readonlyAccounts.byDatabaseId(shop.id)!;
    expect(account.ready).toBe(true);
    expect(account.mysqlHost).toBe(readonlyAccountHost());
    expect(account.mysqlUser).toMatch(/^ldr_[a-z0-9_]+_[a-z0-9]{8}$/);
    expect(account.mysqlUser.length).toBeLessThanOrEqual(32);
    expect(await readonlyGrants(shop.id)).toEqual([
      `GRANT USAGE ON *.* TO \`${account.mysqlUser}\`@\`${account.mysqlHost}\``,
      `GRANT SELECT, SHOW VIEW ON \`${shop.schema.replaceAll("_", "\\_")}\`.* TO \`${account.mysqlUser}\`@\`${account.mysqlHost}\``,
    ]);
  });

  test("ordinary reads still work and big integers stay exact", async () => {
    const select = await executeViewerQuery({ databaseId: shop.id, sql: "SELECT id, note FROM t ORDER BY id" });
    expect(select.rows).toEqual([
      [1, "a"],
      ["76561198000000008", "big"],
    ]);
    const tables = await executeViewerQuery({ databaseId: shop.id, sql: "SHOW TABLES" });
    expect(tables.rows.map((r) => r[0]).sort()).toEqual(["log", "t", "v_bump", "v_notes"]);
    const describe = await executeViewerQuery({ databaseId: shop.id, sql: "DESCRIBE t" });
    expect(describe.rows.map((r) => r[0])).toEqual(["id", "note"]);
    const explain = await executeViewerQuery({ databaseId: shop.id, sql: "EXPLAIN SELECT * FROM t WHERE id = 1" });
    expect(explain.rowCount).toBeGreaterThan(0);
    const cte = await executeViewerQuery({
      databaseId: shop.id,
      sql: "WITH big AS (SELECT id FROM t WHERE id > 100) SELECT COUNT(*) AS n, MAX(id) FROM big",
    });
    expect(cte.rows).toEqual([[1, "76561198000000008"]]);
    const view = await executeViewerQuery({ databaseId: shop.id, sql: "SELECT note FROM v_notes ORDER BY id" });
    expect(view.rows).toEqual([["a"], ["big"]]);
    const showView = await executeViewerQuery({ databaseId: shop.id, sql: "SHOW CREATE VIEW v_notes" });
    expect(String(showView.rows[0]![1])).toContain("v_notes");
  });

  const attacks: { name: string; sql: () => string; errnos: number[] }[] = [
    { name: "INSERT", sql: () => "INSERT INTO t VALUES (2, 'x')", errnos: [1142] },
    { name: "UPDATE", sql: () => "UPDATE t SET note = 'x'", errnos: [1142] },
    { name: "DELETE", sql: () => "DELETE FROM t", errnos: [1142] },
    { name: "DROP", sql: () => "DROP TABLE t", errnos: [1142] },
    { name: "SET STATEMENT override", sql: () => "SET STATEMENT transaction_read_only=0 FOR DELETE FROM t", errnos: [1142] },
    { name: "executable comment", sql: () => "/*!SET STATEMENT transaction_read_only=0 FOR*/ SELECT bump()", errnos: [1370] },
    { name: "stored function write", sql: () => "SELECT bump()", errnos: [1370] },
    { name: "stored procedure", sql: () => "CALL wipe()", errnos: [1370] },
    { name: "INTO OUTFILE", sql: () => "SELECT * FROM t INTO OUTFILE '/tmp/ld-viewer-outfile.txt'", errnos: [1045] },
    { name: "temporary table", sql: () => "CREATE TEMPORARY TABLE tmp_x (a INT)", errnos: [1044] },
    { name: "cross-schema read", sql: () => `SELECT * FROM \`${other.schema}\`.secret`, errnos: [1142] },
  ];

  for (const attack of attacks) {
    test(`a viewer ${attack.name} is refused by privileges and changes nothing`, async () => {
      const before = await rootQuery(`SELECT (SELECT COUNT(*) FROM \`${shop.schema}\`.t) AS t, (SELECT COUNT(*) FROM \`${shop.schema}\`.log) AS log`);
      let err: unknown = null;
      await executeViewerQuery({ databaseId: shop.id, sql: attack.sql() }).catch((e) => {
        err = e;
      });
      expect(err).toBeInstanceOf(ViewerQueryDeniedError);
      expect((err as ViewerQueryDeniedError).status).toBe(403);
      expect((err as Error).message).not.toContain("ldr_");
      expect(attack.errnos).toContain((await withoutSessionLayer(shop.id, attack.sql())) ?? -1);
      expect(await rootQuery(`SELECT (SELECT COUNT(*) FROM \`${shop.schema}\`.t) AS t, (SELECT COUNT(*) FROM \`${shop.schema}\`.log) AS log`)).toEqual(before);
    });
  }

  test("calling even a harmless stored function gives a clear message", async () => {
    let err: unknown = null;
    await executeViewerQuery({ databaseId: shop.id, sql: "SELECT twice(id) FROM t" }).catch((e) => {
      err = e;
    });
    expect(err).toBeInstanceOf(ViewerQueryDeniedError);
    expect((err as ViewerQueryDeniedError).errno).toBe(1370);
    expect((err as Error).message).toBe(
      "viewers cannot call stored functions or procedures: read-only access has no EXECUTE right on this database",
    );
  });

  test("a definer view that writes is still stopped by the read-only session", async () => {
    let err: unknown = null;
    await executeViewerQuery({ databaseId: shop.id, sql: "SELECT b FROM v_bump" }).catch((e) => {
      err = e;
    });
    expect(err).toBeInstanceOf(ViewerQueryDeniedError);
    expect((err as ViewerQueryDeniedError).errno).toBe(1792);
    expect(await rootQuery(`SELECT COUNT(*) AS n FROM \`${shop.schema}\`.log`)).toEqual([{ n: 0 }]);
  });

  test("viewer queries through the route run as the read-only account", async () => {
    const viewer = seedUser("viewer");
    const res = await buildApp().request(`/api/databases/${shop.id}/query`, {
      method: "POST",
      headers: await authHeaders(viewer, { "Content-Type": "application/json" }),
      body: JSON.stringify({ sql: "SELECT SUBSTRING_INDEX(CURRENT_USER(), '@', 1) AS u, COUNT(*) AS n FROM t" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { rows: unknown[][] };
    expect(body.rows).toEqual([[readonlyAccounts.byDatabaseId(shop.id)!.mysqlUser, 2]]);
  });

  test("startup reconciliation creates a missing account and is a no-op the second time", async () => {
    await dropReadonlyAccount(other.id);
    expect(readonlyAccounts.byDatabaseId(other.id)).toBeNull();
    await expect(executeViewerQuery({ databaseId: other.id, sql: "SELECT 1" })).rejects.toBeInstanceOf(
      ViewerAccessUnavailableError,
    );

    const first = await reconcileReadonlyAccounts();
    expect(first).toEqual({ created: 1, repaired: 0, dropped: 0, warnings: [] });
    expect((await executeViewerQuery({ databaseId: other.id, sql: "SELECT id FROM secret" })).rows).toEqual([[42]]);

    const state = await accountState();
    const second = await reconcileReadonlyAccounts();
    expect(second).toEqual({ created: 0, repaired: 0, dropped: 0, warnings: [] });
    expect(await accountState()).toEqual(state);
  });

  test("reconciliation repairs drifted privileges and removes leftover accounts", async () => {
    const account = readonlyAccounts.byDatabaseId(shop.id)!;
    await rootQuery(`GRANT INSERT ON \`${shop.schema}\`.* TO ?@?`, [account.mysqlUser, account.mysqlHost]);
    await rootQuery("CREATE USER 'ldr_leftover_abcd1234'@'127.0.0.1' IDENTIFIED BY 'x'");
    const result = await reconcileReadonlyAccounts();
    expect(result).toEqual({ created: 0, repaired: 1, dropped: 1, warnings: [] });
    expect(await withoutSessionLayer(shop.id, "INSERT INTO t VALUES (3, 'x')")).toBe(1142);
    expect(await rootQuery("SELECT User FROM mysql.user WHERE User = 'ldr_leftover_abcd1234'")).toEqual([]);
  });

  test("a database whose account is not ready is refused instead of falling back", async () => {
    readonlyAccounts.setReady(other.id, false);
    await expect(executeViewerQuery({ databaseId: other.id, sql: "SELECT 1" })).rejects.toThrow(/read-only access/);
    const account = readonlyAccounts.byDatabaseId(other.id)!;
    await rootQuery("DROP USER ?@?", [account.mysqlUser, account.mysqlHost]);
    readonlyAccounts.setReady(other.id, true);
    let err: unknown = null;
    await executeViewerQuery({ databaseId: other.id, sql: "SELECT 1" }).catch((e) => {
      err = e;
    });
    expect(err).toBeInstanceOf(ViewerAccessUnavailableError);
    expect((err as ViewerAccessUnavailableError).status).toBe(503);
    expect((await reconcileReadonlyAccounts()).repaired).toBe(1);
    expect((await executeViewerQuery({ databaseId: other.id, sql: "SELECT 1 AS one" })).rows).toEqual([[1]]);
  });

  test("deprovisioning removes the read-only account", async () => {
    const doomed = await provision(owner, "Viewer Doomed");
    const account = readonlyAccounts.byDatabaseId(doomed.id)!;
    expect(await rootQuery("SELECT User FROM mysql.user WHERE User = ?", [account.mysqlUser])).toHaveLength(1);
    await deprovisionDatabase(doomed.id);
    expect(await rootQuery("SELECT User FROM mysql.user WHERE User = ?", [account.mysqlUser])).toEqual([]);
    expect(readonlyAccounts.byDatabaseId(doomed.id)).toBeNull();
  });
});
