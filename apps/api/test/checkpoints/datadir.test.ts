import { checksums, exec, makeDatabase, mariadbAvailable, populateRich, setup, type Fixture } from "./helpers";
import { testTmpRoot } from "../harness/instance";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { createCheckpoint, restoreCheckpoint } from "../../src/checkpoints";
import { checkpointDownloadStream } from "../../src/checkpoints/download";
import { objectPath } from "../../src/checkpoints/store";
import { checkpoints, databases } from "../../src/db/queries";
import { env } from "../../src/env";
import { migrateDataDir } from "../../src/util/dataDirMigration";

describe.skipIf(!mariadbAvailable())("checkpoints across a data directory move", () => {
  let fx: Fixture;

  beforeAll(async () => {
    fx = await setup();
  }, 180_000);

  afterAll(async () => {
    await fx?.instance.stop();
  }, 180_000);

  test("objects are addressed relative to the data directory, so restore and download work after a move", async () => {
    const { database } = await makeDatabase(fx.owner);
    await populateRich(database.name);
    const sums = await checksums(database.name);
    const id = (await createCheckpoint(database.id, { trigger: "manual", message: "before move" })).checkpointId!;
    await exec(database.name, "DELETE FROM players");
    const original = env.dataDir;
    const moved = join(testTmpRoot(), `moved-${Date.now()}`);
    await migrateDataDir({ newPath: moved });
    try {
      expect(env.dataDir).toBe(moved);
      expect(existsSync(join(original, "checkpoints"))).toBe(false);
      for (const e of checkpoints.entries(id)) {
        expect(objectPath(database.id, e.objectHash).startsWith(moved)).toBe(true);
        expect(existsSync(objectPath(database.id, e.objectHash))).toBe(true);
      }
      const row = databases.byId(database.id)!;
      const stream = checkpointDownloadStream(row.name, checkpoints.byId(id)!, checkpoints.entries(id));
      expect((await new Response(stream).arrayBuffer()).byteLength).toBeGreaterThan(100);
      await restoreCheckpoint(database.id, id, { userId: null });
      expect(await checksums(database.name)).toEqual(sums);
    } finally {
      await migrateDataDir({ newPath: original });
    }
    expect(env.dataDir).toBe(original);
    for (const e of checkpoints.entries(id)) expect(existsSync(objectPath(database.id, e.objectHash))).toBe(true);
  }, 300_000);
});
