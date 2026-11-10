import { createTestDatabase, mariadbAvailable, rootQuery, startTestInstance, type TestInstance } from "../harness/instance";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import mysql from "mysql2/promise";
import { env } from "../../src/env";
import { databases, users } from "../../src/db/queries";
import { newId, randAlphaNum } from "../../src/util/id";
import { generatePassword } from "../../src/util/credentials";
import {
  grantSchemaAccess,
  reconcileDatabaseGrants,
  revokeSchemaAccess,
  updateAllowedHost,
} from "../../src/mariadb/manager";

type Account = { user: string; password: string };

async function asUser<T>(account: Account, fn: (c: mysql.Connection) => Promise<T>): Promise<T> {
  const conn = await mysql.createConnection({
    host: "127.0.0.1",
    port: env.mariadbPort,
    user: account.user,
    password: account.password,
  });
  try {
    return await fn(conn);
  } finally {
    await conn.end();
  }
}

async function canRead(account: Account, table: string): Promise<boolean> {
  try {
    await asUser(account, (c) => c.query(`SELECT COUNT(*) FROM ${table}`));
    return true;
  } catch {
    return false;
  }
}

async function dbGrantRows(user: string): Promise<string[]> {
  const rows = await rootQuery<{ db: string; host: string }>(
    `SELECT Db AS db, Host AS host FROM mysql.db WHERE User = ? ORDER BY Db, Host`,
    [user],
  );
  return rows.map((r) => `${r.db}@${r.host}`);
}

async function sibling(name: string): Promise<string> {
  await rootQuery(`CREATE DATABASE \`${name}\``);
  await rootQuery(`CREATE TABLE \`${name}\`.secret (id INT)`);
  return `\`${name}\`.secret`;
}

describe.skipIf(!mariadbAvailable())("database grants", () => {
  let instance: TestInstance | null = null;
  let ownerId = "";

  beforeAll(async () => {
    instance = await startTestInstance();
    ownerId = newId("usr");
    users.insert({
      id: ownerId,
      email: `owner-${randAlphaNum(6)}@example.test`,
      passwordHash: "x",
      displayName: null,
      role: "admin",
      experienceLevel: "advanced",
    });
  }, 120_000);

  afterAll(async () => {
    await instance?.stop();
  }, 60_000);

  test("a provisioned user cannot reach schemas that match its name as a pattern", async () => {
    const r = randAlphaNum(6);
    const db = await createTestDatabase(`p_${r}`);
    await rootQuery(`CREATE TABLE \`${db.schema}\`.own (id INT)`);
    const other = await sibling(`pz${r}`);
    expect(await canRead(db, `\`${db.schema}\`.own`)).toBe(true);
    expect(await canRead(db, other)).toBe(false);
    expect(await dbGrantRows(db.user)).toEqual([`p\\_${r}@%`]);
  });

  test("grantSchemaAccess and revokeSchemaAccess add and remove exact access, idempotently", async () => {
    const r = randAlphaNum(6);
    const db = await createTestDatabase(`g_${r}`);
    const extra = `s_${r}`;
    await rootQuery(`CREATE DATABASE \`${extra}\``);
    await rootQuery(`CREATE TABLE \`${extra}\`.t (id INT)`);
    const other = await sibling(`sx${r}`);

    await grantSchemaAccess(db.user, "%", extra);
    await grantSchemaAccess(db.user, "%", extra);
    expect(await canRead(db, `\`${extra}\`.t`)).toBe(true);
    expect(await canRead(db, other)).toBe(false);

    await revokeSchemaAccess(db.user, "%", extra);
    await revokeSchemaAccess(db.user, "%", extra);
    expect(await canRead(db, `\`${extra}\`.t`)).toBe(false);
    expect(await dbGrantRows(db.user)).toEqual([`g\\_${r}@%`]);
  });

  test("reconcileDatabaseGrants replaces old wildcard grants without a gap in access", async () => {
    const r = randAlphaNum(6);
    const schema = `q_${r}`;
    const account = { user: `ld_q_${r}_legacy`, password: generatePassword() };
    await rootQuery(`CREATE DATABASE \`${schema}\``);
    await rootQuery(`CREATE TABLE \`${schema}\`.t (id INT)`);
    await rootQuery(`CREATE USER ?@'%' IDENTIFIED BY ?`, [account.user, account.password]);
    await rootQuery(`GRANT ALL PRIVILEGES ON \`${schema}\`.* TO ?@'%'`, [account.user]);
    const other = await sibling(`qx${r}`);
    const add = (id: string, name: string, user: string) =>
      databases.insert({
        id,
        name,
        displayName: name,
        ownerUserId: ownerId,
        kind: "standard",
        mysqlUser: user,
        mysqlPasswordEnc: "unused",
        connectionsFrom: "%",
        tailscaleExposed: false,
        lanExposed: true,
      });
    add(newId("db"), schema, account.user);
    add(newId("db"), `bad name ${r}`, "ld_nobody");
    const current = await createTestDatabase(`c_${r}`);
    add(newId("db"), current.schema, current.user);

    expect(await canRead(account, other)).toBe(true);
    expect(await dbGrantRows(account.user)).toEqual([`${schema}@%`]);

    const probes: boolean[] = [];
    let stop = false;
    const background = (async () => {
      while (!stop) {
        probes.push(await canRead(account, `\`${schema}\`.t`));
        await Bun.sleep(5);
      }
    })();
    const midway: boolean[] = [];
    let first: { fixed: number; warnings: string[] };
    try {
      first = await reconcileDatabaseGrants({
        afterGrant: async (name) => {
          if (name !== schema) return;
          midway.push(await canRead(account, `\`${schema}\`.t`));
          expect((await dbGrantRows(account.user)).sort()).toEqual([`${schema}@%`, `q\\_${r}@%`].sort());
        },
      });
    } finally {
      stop = true;
      await background;
    }

    expect(first.fixed).toBe(1);
    expect(first.warnings.length).toBe(1);
    expect(first.warnings[0]).toContain(`bad name ${r}`);
    expect(midway).toEqual([true]);
    expect(probes.length).toBeGreaterThan(0);
    expect(probes.every(Boolean)).toBe(true);
    expect(await dbGrantRows(account.user)).toEqual([`q\\_${r}@%`]);
    expect(await canRead(account, `\`${schema}\`.t`)).toBe(true);
    expect(await asUser(account, (c) => c.query(`INSERT INTO \`${schema}\`.t VALUES (1)`))).toBeDefined();
    expect(await canRead(account, other)).toBe(false);
    expect(await dbGrantRows(current.user)).toEqual([`c\\_${r}@%`]);

    const second = await reconcileDatabaseGrants();
    expect(second.fixed).toBe(0);
    expect(second.warnings).toEqual(first.warnings);
    expect(await dbGrantRows(account.user)).toEqual([`q\\_${r}@%`]);
  });

  test("updateAllowedHost keeps the escaped grant and drops a legacy one on the new account", async () => {
    const r = randAlphaNum(6);
    const db = await createTestDatabase(`h_${r}`);
    await rootQuery(`CREATE USER ?@'127.0.0.1' IDENTIFIED BY ?`, [db.user, db.password]);
    await rootQuery(`GRANT ALL PRIVILEGES ON \`${db.schema}\`.* TO ?@'127.0.0.1'`, [db.user]);
    const result = await updateAllowedHost({ user: db.user, oldHost: "%", newHost: "127.0.0.1", password: db.password, schema: db.schema });
    expect(result.warnings).toEqual([]);
    expect(await dbGrantRows(db.user)).toEqual([`h\\_${r}@127.0.0.1`]);
  });
});
