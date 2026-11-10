import { createTestDatabase, mariadbAvailable, rootQuery, startTestInstance, type TestInstance } from "../harness/instance";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import mysql from "mysql2/promise";
import { env } from "../../src/env";
import { settings } from "../../src/db/queries";
import { decryptSecret } from "../../src/util/crypto";
import { LEGACY } from "../../src/util/legacy";
import { getRootPassword, healthCheck, startMariaDb, stopMariaDb } from "../../src/mariadb/controller";

const HOSTS = ["localhost", "127.0.0.1"];

async function hostsFor(user: string): Promise<string[]> {
  const rows = await rootQuery<{ host: string }>(`SELECT Host AS host FROM mysql.user WHERE User = ? ORDER BY Host`, [user]);
  return rows.map((r) => r.host);
}

async function makeLegacyAdmin(): Promise<void> {
  const adminPassword = await getRootPassword();
  for (const host of HOSTS) {
    await rootQuery(`CREATE USER IF NOT EXISTS ?@? IDENTIFIED BY ?`, [LEGACY.mariadbRootUser, host, adminPassword]);
    await rootQuery(`GRANT ALL PRIVILEGES ON *.* TO ?@? WITH GRANT OPTION`, [LEGACY.mariadbRootUser, host]);
  }
}

async function makePreRenameInstall(): Promise<void> {
  await makeLegacyAdmin();
  const roots = await rootQuery<{ host: string }>(`SELECT Host AS host FROM mysql.user WHERE User = 'root'`);
  for (const r of roots) {
    await rootQuery(`ALTER USER 'root'@? IDENTIFIED BY ?`, [r.host, `unknown-${crypto.randomUUID()}`]).catch(() => {});
  }
  for (const host of HOSTS) await rootQuery(`DROP USER IF EXISTS ?@?`, [env.rootUser, host]);
}

async function restart(): Promise<void> {
  await stopMariaDb();
  await startMariaDb();
}

async function rootWorks(): Promise<boolean> {
  const stored = settings.get("mariadb_system_root_password_enc");
  if (!stored) return false;
  try {
    const conn = await mysql.createConnection({
      host: "127.0.0.1",
      port: env.mariadbPort,
      user: "root",
      password: await decryptSecret(stored),
    });
    await conn.end();
    return true;
  } catch {
    return false;
  }
}

describe.skipIf(!mariadbAvailable())("legacy kilndb_root admin account", () => {
  let instance: TestInstance | null = null;

  beforeAll(async () => {
    instance = await startTestInstance();
  }, 120_000);

  afterAll(async () => {
    await instance?.stop();
  }, 60_000);

  test("an install whose only admin is kilndb_root boots, gains lambdata_root and drops the legacy account", async () => {
    await makePreRenameInstall();
    expect(await hostsFor(env.rootUser)).toEqual([]);
    expect(await hostsFor(LEGACY.mariadbRootUser)).toEqual(["127.0.0.1", "localhost"]);
    expect(await rootWorks()).toBe(false);

    await restart();

    expect((await healthCheck()).ok).toBe(true);
    expect(await hostsFor(env.rootUser)).toEqual(["127.0.0.1", "localhost"]);
    expect(await hostsFor(LEGACY.mariadbRootUser)).toEqual([]);
    expect(await rootWorks()).toBe(true);
    expect(await rootQuery<{ u: string }>("SELECT SUBSTRING_INDEX(CURRENT_USER(), '@', 1) AS u")).toEqual([
      { u: env.rootUser },
    ]);
  }, 90_000);

  test("kilndb_root is kept while it is the definer of a view, and dropped once it no longer is", async () => {
    const db = await createTestDatabase();
    await makeLegacyAdmin();
    await rootQuery(`CREATE DEFINER = 'kilndb_root'@'localhost' VIEW \`${db.schema}\`.legacy_v AS SELECT 1 AS x`);

    await restart();
    expect((await healthCheck()).ok).toBe(true);
    expect(await hostsFor(LEGACY.mariadbRootUser)).toEqual(["127.0.0.1", "localhost"]);
    expect(await rootQuery(`SELECT x FROM \`${db.schema}\`.legacy_v`)).toEqual([{ x: 1 }]);

    await rootQuery(`DROP VIEW \`${db.schema}\`.legacy_v`);
    await restart();
    expect(await hostsFor(LEGACY.mariadbRootUser)).toEqual([]);
    expect(await hostsFor(env.rootUser)).toEqual(["127.0.0.1", "localhost"]);
  }, 90_000);
});
