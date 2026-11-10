import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import mysql from "mysql2/promise";
import { mariadbAvailable, rootQuery, startTestInstance, type TestInstance } from "../harness/instance";
import { authHeaders, seedUser, type SeededUser } from "../harness/sqlite";

const available = mariadbAvailable();

describe.skipIf(!available)("database provisioning", () => {
  let instance: TestInstance;
  let owner: SeededUser;
  let mods: {
    provision: typeof import("../../src/databases/provision");
    reconcile: typeof import("../../src/databases/reconcile");
    queries: typeof import("../../src/db/queries");
    manager: typeof import("../../src/mariadb/manager");
    env: typeof import("../../src/env");
    server: typeof import("../../src/server");
    jobs: typeof import("../../src/jobs");
  };

  async function schemaExists(name: string): Promise<boolean> {
    const rows = await rootQuery<{ n: number }>(
      "SELECT COUNT(*) AS n FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = ?",
      [name],
    );
    return Number(rows[0]?.n ?? 0) > 0;
  }

  async function userExists(user: string): Promise<boolean> {
    const rows = await rootQuery<{ n: number }>("SELECT COUNT(*) AS n FROM mysql.user WHERE User = ?", [user]);
    return Number(rows[0]?.n ?? 0) > 0;
  }

  beforeAll(async () => {
    instance = await startTestInstance();
    mods = {
      provision: await import("../../src/databases/provision"),
      reconcile: await import("../../src/databases/reconcile"),
      queries: await import("../../src/db/queries"),
      manager: await import("../../src/mariadb/manager"),
      env: await import("../../src/env"),
      server: await import("../../src/server"),
      jobs: await import("../../src/jobs"),
    };
    owner = seedUser("admin");
  }, 120_000);

  afterAll(async () => {
    await instance?.stop();
  }, 120_000);

  test("creates schema, user and metadata together, with working credentials", async () => {
    const { database, credentials } = await mods.provision.provisionDatabase({
      displayName: "Shop Data",
      ownerUserId: owner.id,
      versioned: true,
    });
    expect(database.name).toBe("shop_data");
    expect(database.versioned).toBe(true);
    expect(database.showInVitals).toBe(true);
    expect(Object.keys(database)).not.toContain("mysqlPasswordEnc");
    expect(mods.queries.databases.provisionStateOf(database.id)).toBeNull();
    expect(await schemaExists("shop_data")).toBe(true);
    expect(await userExists(credentials.user)).toBe(true);
    const conn = await mysql.createConnection({
      host: "127.0.0.1",
      port: instance.mariadbPort,
      user: credentials.user,
      password: credentials.password,
      database: credentials.schema,
    });
    try {
      await conn.query("CREATE TABLE t (id INT PRIMARY KEY)");
      await conn.query("INSERT INTO t VALUES (1)");
    } finally {
      await conn.end();
    }
  });

  test("skips names that already exist in MariaDB or are reserved", async () => {
    await rootQuery("CREATE DATABASE IF NOT EXISTS `taken_name`");
    const a = await mods.provision.provisionDatabase({ displayName: "Taken Name", ownerUserId: owner.id });
    expect(a.database.name).toBe("taken_name_1");
    const sys = await mods.provision.provisionDatabase({ displayName: "Information Schema", ownerUserId: owner.id });
    expect(sys.database.name).not.toBe("information_schema");
  });

  test("concurrent creates with one display name get distinct schemas", async () => {
    const results = await Promise.all(
      [1, 2, 3].map(() => mods.provision.provisionDatabase({ displayName: "Same Name", ownerUserId: owner.id })),
    );
    const names = results.map((r) => r.database.name).sort();
    expect(names).toEqual(["same_name", "same_name_1", "same_name_2"]);
    for (const n of names) expect(await schemaExists(n)).toBe(true);
  });

  test("a failure part-way through leaves neither metadata nor schema behind", async () => {
    const before = mods.queries.databases.allNames().length;
    const envMod = await import("../../src/env");
    const bind = envMod.env.mariadbBind;
    let status = 0;
    try {
      envMod.env.mariadbBind = "not a host pattern";
      await mods.provision.provisionDatabase({ displayName: "Doomed", ownerUserId: owner.id });
    } catch (err) {
      status = (err as { status?: number }).status ?? -1;
    } finally {
      envMod.env.mariadbBind = bind;
    }
    expect(status).toBe(503);
    expect(mods.queries.databases.allNames().length).toBe(before);
    expect(mods.queries.databases.byName("doomed")).toBeNull();
    expect(await schemaExists("doomed")).toBe(false);
    const retry = await mods.provision.provisionDatabase({ displayName: "Doomed", ownerUserId: owner.id });
    expect(retry.database.name).toBe("doomed");
  });

  test("reconciliation rolls back half-created rows and finishes half-deleted ones", async () => {
    const { databases } = mods.queries;
    const old = Date.now() - 60_000;
    const half = { id: "db_halfmade", name: "halfmade", user: "ld_halfmade_abcd1234" };
    databases.insert({
      id: half.id,
      name: half.name,
      displayName: "Half made",
      ownerUserId: owner.id,
      kind: "standard",
      mysqlUser: half.user,
      mysqlPasswordEnc: "enc",
      connectionsFrom: "%",
      tailscaleExposed: false,
      lanExposed: true,
      provisionState: "creating",
    });
    await mods.manager.createDatabaseAndUser({
      schema: half.name,
      user: half.user,
      password: "pw-half-1234",
      connectionsFrom: "%",
    });

    const kept = { id: "db_keptdata", name: "keptdata", user: "ld_keptdata_abcd1234" };
    databases.insert({
      id: kept.id,
      name: kept.name,
      displayName: "Kept",
      ownerUserId: owner.id,
      kind: "standard",
      mysqlUser: kept.user,
      mysqlPasswordEnc: "enc",
      connectionsFrom: "%",
      tailscaleExposed: false,
      lanExposed: true,
      provisionState: "creating",
    });
    await mods.manager.createDatabaseAndUser({
      schema: kept.name,
      user: kept.user,
      password: "pw-kept-1234",
      connectionsFrom: "%",
    });
    await rootQuery("CREATE TABLE `keptdata`.`important` (id INT)");

    const doomed = await mods.provision.provisionDatabase({ displayName: "Half Deleted", ownerUserId: owner.id });
    databases.setProvisionState(doomed.database.id, "deleting");
    const cpDir = join(mods.env.env.checkpointsDir, doomed.database.id);
    mkdirSync(join(cpDir, "objects"), { recursive: true });

    await rootQuery("CREATE DATABASE IF NOT EXISTS `stray_schema`");

    const report = await mods.reconcile.reconcileDatabases({ startedBefore: old + 120_000 });
    expect(report.rolledBack).toContain("halfmade");
    expect(report.finalized).toContain("keptdata");
    expect(report.deleted).toContain("half_deleted");
    expect(report.orphanSchemas).toContain("stray_schema");
    expect(report.orphanSchemas).toContain("taken_name");
    expect(databases.byId(half.id)).toBeNull();
    expect(await schemaExists("halfmade")).toBe(false);
    expect(await userExists(half.user)).toBe(false);
    expect(databases.provisionStateOf(kept.id)).toBeNull();
    expect(await schemaExists("keptdata")).toBe(true);
    expect(databases.byId(doomed.database.id)).toBeNull();
    expect(await schemaExists("half_deleted")).toBe(false);
    expect(existsSync(cpDir)).toBe(false);
    expect(await schemaExists("stray_schema")).toBe(true);
  });

  test("a row created by this process is not rolled back while still in flight", async () => {
    const { databases } = mods.queries;
    databases.insert({
      id: "db_inflight",
      name: "inflight",
      displayName: "In flight",
      ownerUserId: owner.id,
      kind: "standard",
      mysqlUser: "ld_inflight_abcd1234",
      mysqlPasswordEnc: "enc",
      connectionsFrom: "%",
      tailscaleExposed: false,
      lanExposed: true,
      provisionState: "creating",
    });
    const report = await mods.reconcile.reconcileDatabases({ startedBefore: Date.now() - 60_000 });
    expect(report.rolledBack).not.toContain("inflight");
    expect(databases.byId("db_inflight")).not.toBeNull();
    databases.delete("db_inflight");
  });

  test("deprovisioning removes schema, user, checkpoint directory and legacy snapshot files", async () => {
    const { database, credentials } = await mods.provision.provisionDatabase({
      displayName: "Going Away",
      ownerUserId: owner.id,
    });
    const keep = await mods.provision.provisionDatabase({ displayName: "Staying", ownerUserId: owner.id });
    const { env } = mods.env;
    const cpDir = join(env.checkpointsDir, database.id);
    mkdirSync(join(cpDir, "objects", "ab"), { recursive: true });
    writeFileSync(join(cpDir, "objects", "ab", "x.sql.gz"), "x");
    mkdirSync(env.snapshotsDir, { recursive: true });
    const byPattern = join(env.snapshotsDir, `${database.id}_111.sql`);
    const stale = join(env.snapshotsDir, `${database.id}_222.sql`);
    const other = join(env.snapshotsDir, `${keep.database.id}_333.sql`);
    for (const f of [byPattern, stale, other]) writeFileSync(f, "-- dump");
    mods.queries.snapshots.insert({
      id: "snap_stale",
      databaseId: database.id,
      filePath: `/somewhere/old/snapshots/${database.id}_222.sql`,
      sizeBytes: 7,
      createdAt: Date.now(),
      trigger: "manual",
    });

    await mods.provision.deprovisionDatabase(database.id);

    expect(mods.queries.databases.byId(database.id)).toBeNull();
    expect(await schemaExists(database.name)).toBe(false);
    expect(await userExists(credentials.user)).toBe(false);
    expect(existsSync(cpDir)).toBe(false);
    expect(existsSync(byPattern)).toBe(false);
    expect(existsSync(stale)).toBe(false);
    expect(existsSync(other)).toBe(true);
    expect(mods.queries.snapshots.byId("snap_stale")).toBeNull();
  });

  test("POST and DELETE /api/databases go through provisioning", async () => {
    const app = mods.server.buildApp();
    const headers = await authHeaders(owner, { "Content-Type": "application/json" });
    const res = await app.request("/api/databases", {
      method: "POST",
      headers,
      body: JSON.stringify({ displayName: "Via HTTP", versioned: true, showInVitals: false }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      database: { id: string; name: string; versioned: boolean; showInVitals: boolean };
      credentials: { user: string };
    };
    expect(body.database).toMatchObject({ name: "via_http", versioned: true, showInVitals: false });
    const patch = await app.request(`/api/databases/${body.database.id}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ showInVitals: true, versioned: false }),
    });
    expect(((await patch.json()) as { database: { showInVitals: boolean; versioned: boolean } }).database).toMatchObject({
      showInVitals: true,
      versioned: false,
    });
    const bad = await app.request("/api/databases", {
      method: "POST",
      headers,
      body: JSON.stringify({ displayName: "x", connectionsFrom: "bad host'" }),
    });
    expect(bad.status).toBe(400);
    const del = await app.request(`/api/databases/${body.database.id}`, { method: "DELETE", headers });
    expect(del.status).toBe(200);
    expect(await schemaExists("via_http")).toBe(false);
    expect(await userExists(body.credentials.user)).toBe(false);
  });
});
