import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { mariadbAvailable, rootQuery, startTestInstance, testTmpRoot, type TestInstance } from "../harness/instance";
import { seedUser } from "../harness/sqlite";

describe.skipIf(!mariadbAvailable())("data directory migration", () => {
  let instance: TestInstance;
  let mods: {
    migration: typeof import("../../src/util/dataDirMigration");
    pointer: typeof import("../../src/util/pointer");
    env: typeof import("../../src/env");
    provision: typeof import("../../src/databases/provision");
    queries: typeof import("../../src/db/queries");
    jobs: typeof import("../../src/jobs");
    server: typeof import("../../src/server");
  };

  beforeAll(async () => {
    instance = await startTestInstance();
    mods = {
      migration: await import("../../src/util/dataDirMigration"),
      pointer: await import("../../src/util/pointer"),
      env: await import("../../src/env"),
      provision: await import("../../src/databases/provision"),
      queries: await import("../../src/db/queries"),
      jobs: await import("../../src/jobs"),
      server: await import("../../src/server"),
    };
  }, 120_000);

  afterAll(async () => {
    await instance?.stop();
  }, 120_000);

  test("choosing the current directory succeeds as a no-op and marks storage configured", async () => {
    const { env } = mods.env;
    mods.pointer.clearPointer();
    expect(mods.pointer.readPointer()).toBeNull();
    const v = mods.migration.validateDataDirPath(env.dataDir);
    expect(v.ok).toBe(true);
    const result = await mods.migration.migrateDataDir({ newPath: env.dataDir });
    expect(result.bytesCopied).toBe(0);
    expect(result.newPath).toBe(result.oldPath);
    expect(mods.pointer.readPointer()).toBe(result.newPath);
  });

  test("refuses to nest the data directory or to run beside an active job", async () => {
    const { env } = mods.env;
    const nested = mods.migration.validateDataDirPath(join(env.dataDir, "inner"));
    expect(nested.ok).toBe(false);
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const job = mods.jobs.startJob({ kind: "sync.run", databaseId: null, userId: null }, () => gate);
    try {
      await expect(mods.migration.migrateDataDir({ newPath: join(testTmpRoot(), "never") })).rejects.toMatchObject({
        status: 409,
      });
    } finally {
      release();
      await mods.jobs.waitForJob(job.id);
    }
  });

  test("moves everything, keeps the API responsive, and flips the pointer only after a verified copy", async () => {
    const { env } = mods.env;
    const owner = seedUser("admin");
    const { database } = await mods.provision.provisionDatabase({ displayName: "Movable", ownerUserId: owner.id });
    await rootQuery("CREATE TABLE `movable`.`rows` (id INT PRIMARY KEY, v VARCHAR(20))");
    await rootQuery("INSERT INTO `movable`.`rows` VALUES (1, 'kept')");
    const blobDir = join(env.storageDir, "bulk");
    mkdirSync(blobDir, { recursive: true });
    for (let i = 0; i < 40; i++) writeFileSync(join(blobDir, `f${i}.bin`), new Uint8Array(512 * 1024).fill(i));

    const oldDir = env.dataDir;
    const target = join(testTmpRoot(), `moved-${Date.now()}`);
    const app = mods.server.buildApp();
    let ticks = 0;
    let gated = 0;
    const timer = setInterval(() => {
      ticks++;
    }, 5);
    const probe = (async () => {
      while (!mods.migration.isDataDirMigrating()) await Bun.sleep(1);
      const res = await app.request("/api/databases");
      if (res.status === 503) gated++;
      const health = await app.request("/api/health");
      expect(health.status).toBe(200);
    })();
    const result = await mods.migration.migrateDataDir({ newPath: target });
    clearInterval(timer);
    await probe;

    expect(result.oldPath).toBe(oldDir);
    expect(result.newPath).toBe(target);
    expect(result.bytesCopied).toBeGreaterThan(40 * 512 * 1024);
    expect(ticks).toBeGreaterThan(2);
    expect(gated).toBe(1);
    expect(env.dataDir).toBe(target);
    expect(mods.pointer.readPointer()).toBe(target);
    expect(existsSync(oldDir)).toBe(false);
    expect(existsSync(join(target, "storage", "bulk", "f39.bin"))).toBe(true);
    expect(mods.queries.databases.byId(database.id)?.name).toBe("movable");
    const rows = await rootQuery<{ v: string }>("SELECT v FROM `movable`.`rows` WHERE id = 1");
    expect(rows[0]?.v).toBe("kept");
  }, 120_000);

  test("refuses a folder that holds other files, and changes nothing in it", async () => {
    const { env } = mods.env;
    const before = env.dataDir;
    const pointerBefore = mods.pointer.readPointer();
    const occupied = join(testTmpRoot(), `occupied-${Date.now()}`);
    mkdirSync(occupied, { recursive: true });
    writeFileSync(join(occupied, "notes.txt"), "keep me");
    await expect(mods.migration.migrateDataDir({ newPath: occupied })).rejects.toMatchObject({ status: 409 });
    expect(readFileSync(join(occupied, "notes.txt"), "utf8")).toBe("keep me");
    expect(existsSync(join(occupied, "metadata.sqlite"))).toBe(false);
    expect(env.dataDir).toBe(before);
    expect(mods.pointer.readPointer()).toBe(pointerBefore);
  }, 60_000);

  test("adopts a folder that already holds an installation as it is, without copying over it", async () => {
    const { env } = mods.env;
    const controller = await import("../../src/mariadb/controller");
    const owner = seedUser("admin");
    const kept = await mods.provision.provisionDatabase({ displayName: "Kept In Both", ownerUserId: owner.id });
    const current = env.dataDir;
    await controller.stopMariaDb();
    const existing = join(testTmpRoot(), `existing-${Date.now()}`);
    cpSync(current, existing, { recursive: true, filter: (src) => !src.endsWith(".sock") });
    writeFileSync(join(existing, "sentinel.txt"), "from the existing install");
    await controller.startMariaDb();
    const onlyInCurrent = await mods.provision.provisionDatabase({ displayName: "Only In Current", ownerUserId: owner.id });

    const result = await mods.migration.migrateDataDir({ newPath: existing });
    expect(result.bytesCopied).toBe(0);
    expect(env.dataDir).toBe(existing);
    expect(mods.pointer.readPointer()).toBe(existing);
    expect(readFileSync(join(existing, "sentinel.txt"), "utf8")).toBe("from the existing install");
    expect(existsSync(current)).toBe(true);
    expect(mods.queries.databases.byId(kept.database.id)?.name).toBe(kept.database.name);
    expect(mods.queries.databases.byId(onlyInCurrent.database.id)).toBeNull();
    expect((await controller.healthCheck()).ok).toBe(true);
  }, 180_000);
});
