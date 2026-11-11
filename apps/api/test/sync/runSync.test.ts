import { exec, finished, makeDatabase, mariadbAvailable, setup, type Fixture } from "../checkpoints/helpers";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { SyncJobResult } from "@lambdata/shared";
import { env } from "../../src/env";
import { syncJobs } from "../../src/db/queries";
import { encryptSecret } from "../../src/util/crypto";
import { newId } from "../../src/util/id";
import { startSyncJob } from "../../src/workers/sync";
import { syncChanges } from "../../src/sync/changes";

async function configure(mirrorId: string, p: { database: string; user: string; password: string }) {
  syncJobs.upsert({
    id: newId("sj"),
    databaseId: mirrorId,
    sourceKind: "mysql",
    sourceHost: "127.0.0.1",
    sourcePort: env.mariadbPort,
    sourceUser: p.user,
    passwordEnc: await encryptSecret(p.password),
    sourceDatabase: p.database,
    intervalSeconds: 3600,
    enabled: true,
  });
}

async function sync(mirrorId: string) {
  const job = await finished(startSyncJob(mirrorId, null).id);
  return { job, result: job.result as SyncJobResult | null };
}

describe.skipIf(!mariadbAvailable())("sync results carry what changed", () => {
  let fx: Fixture;
  const original = syncChanges.measure;

  beforeAll(async () => {
    fx = await setup();
  }, 180_000);

  afterAll(async () => {
    syncChanges.measure = original;
    await fx?.instance.stop();
  }, 120_000);

  for (const versioned of [false, true]) {
    test(`${versioned ? "a versioned" : "an unversioned"} mirror reports added tables first, then exact row changes, then nothing`, async () => {
      const primary = await makeDatabase(fx.owner);
      await exec(
        primary.database.name,
        "CREATE TABLE players (id INT PRIMARY KEY, name VARCHAR(40) NOT NULL, score INT NULL)",
        "INSERT INTO players VALUES (1, 'Avery', 10), (2, 'Blake', NULL), (3, 'Casey', 30)",
        "CREATE TABLE events (msg VARCHAR(40))",
        "INSERT INTO events VALUES ('a')",
      );
      const mirror = await makeDatabase(fx.owner, { kind: "mirror", versioned });
      await configure(mirror.database.id, {
        database: primary.database.name,
        user: primary.credentials.user,
        password: primary.credentials.password,
      });

      const first = await sync(mirror.database.id);
      expect(first.job.status).toBe("succeeded");
      expect(first.result!.changes).toMatchObject({ tablesChanged: 2, tablesUnchanged: 0, rowDelta: 4, rowsAdded: null });
      expect(first.result!.changes!.tables.map((t) => [t.name, t.change, t.method])).toEqual([
        ["players", "added", "net"],
        ["events", "added", "net"],
      ]);

      await exec(primary.database.name, "UPDATE players SET score = 20 WHERE id = 2", "DELETE FROM players WHERE id = 3", "INSERT INTO players VALUES (4, 'Drew', 1), (5, 'Emery', 2)");
      const second = await sync(mirror.database.id);
      expect(second.job.status).toBe("succeeded");
      expect(second.result!.changes).toMatchObject({
        tablesChanged: 1,
        tablesUnchanged: 1,
        rowsAdded: 2,
        rowsRemoved: 1,
        rowsChanged: 1,
        rowDelta: 1,
      });
      expect(second.result!.changes!.tables[0]).toMatchObject({ name: "players", method: "exact", added: 2, removed: 1, changed: 1 });

      const third = await sync(mirror.database.id);
      expect(third.result!.changes).toMatchObject({ tablesChanged: 0, tablesUnchanged: 2, rowDelta: 0, tables: [] });
    }, 240_000);
  }

  test("a failure while measuring leaves the sync successful with no summary", async () => {
    const primary = await makeDatabase(fx.owner);
    await exec(primary.database.name, "CREATE TABLE t (id INT PRIMARY KEY)", "INSERT INTO t VALUES (1)");
    const mirror = await makeDatabase(fx.owner, { kind: "mirror", versioned: true });
    await configure(mirror.database.id, {
      database: primary.database.name,
      user: primary.credentials.user,
      password: primary.credentials.password,
    });
    syncChanges.measure = async () => {
      throw new Error("measuring broke on purpose");
    };
    try {
      const run = await sync(mirror.database.id);
      expect(run.job.status).toBe("succeeded");
      expect(run.job.warnings).toEqual([]);
      expect(run.result).toMatchObject({ status: "ok", changes: null, tables: 1 });
      expect(syncJobs.byDatabaseId(mirror.database.id)!.lastStatus).toBe("ok");
    } finally {
      syncChanges.measure = original;
    }
  }, 240_000);
});
