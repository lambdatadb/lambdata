import {
  createTestDatabase,
  mariadbAvailable,
  rootQuery,
  startTestInstance,
  testTmpRoot,
  type TestInstance,
} from "../harness/instance";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { env } from "../../src/env";
import { localAdminTarget, loadStream, runSql, type Target } from "../../src/mariadb/process";
import { applyCodeRecords, captureCodeRecords, parseRenderedCode, renderCodeRecords } from "../../src/mariadb/codeObjects";
import { createStagingSchema, swapStagingIntoLive } from "../../src/mariadb/schemaSwap";

let sentinelCounter = 0;

function sentinelPath(): string {
  return join(testTmpRoot(), `client-exec-sentinel-${process.pid}-${++sentinelCounter}.txt`);
}

function blobStream(sql: string): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(sql);
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

describe.skipIf(!mariadbAvailable())("mariadb client cannot run host commands", () => {
  let instance: TestInstance | null = null;
  let admin: Target;

  beforeAll(async () => {
    instance = await startTestInstance();
    admin = await localAdminTarget();
  }, 120_000);

  afterAll(async () => {
    await instance?.stop();
  }, 60_000);

  test("runSql does not honour a \\! client command on stdin", async () => {
    const sentinel = sentinelPath();
    const db = await createTestDatabase();
    await runSql(admin, db.schema, `SELECT 1;\n\\! touch ${sentinel}\n`).catch(() => undefined);
    await Bun.sleep(200);
    expect(existsSync(sentinel)).toBe(false);
  });

  test("loadStream does not honour a system client command on stdin", async () => {
    const sentinel = sentinelPath();
    const db = await createTestDatabase();
    await loadStream(admin, db.schema, blobStream(`SELECT 1;\nsystem touch ${sentinel}\n`)).catch(() => undefined);
    await Bun.sleep(200);
    expect(existsSync(sentinel)).toBe(false);
  });

  test("LOAD DATA LOCAL INFILE is refused by the client", async () => {
    const db = await createTestDatabase();
    await rootQuery(`CREATE TABLE \`${db.schema}\`.sink (line TEXT)`);
    let err: unknown = null;
    await runSql(admin, db.schema, `LOAD DATA LOCAL INFILE '/etc/hostname' INTO TABLE sink;\n`).catch((e) => {
      err = e;
    });
    expect(err).not.toBeNull();
    const rows = await rootQuery<{ n: number }>(`SELECT COUNT(*) AS n FROM \`${db.schema}\`.sink`);
    expect(Number(rows[0]?.n)).toBe(0);
  });

  test("a \\! line smuggled in a routine body never executes through dump then reload", async () => {
    const sentinel = sentinelPath();
    const db = await createTestDatabase();
    await rootQuery(
      `CREATE PROCEDURE \`${db.schema}\`.evil()
       BEGIN
         DECLARE note TEXT DEFAULT 'guard';
         SET note = 'guard';
       END`,
    );
    await rootQuery(
      `CREATE PROCEDURE \`${db.schema}\`.evil2()
       BEGIN
         SELECT 1;
       END`,
    );
    await rootQuery(`CREATE PROCEDURE \`${db.schema}\`.smuggle()\nBEGIN\n-- \\! touch ${sentinel}\n-- system touch ${sentinel}\n  SELECT 1;\nEND`);
    const rendered = renderCodeRecords(await captureCodeRecords(admin, db.schema));
    expect(rendered).toContain("smuggle");
    const copy = await createTestDatabase();
    await runSql(admin, copy.schema, rendered);
    await applyCodeRecords(db.schema, parseRenderedCode(rendered)!, { replace: true });
    await Bun.sleep(200);
    expect(existsSync(sentinel)).toBe(false);
    const after = await rootQuery<{ n: number }>(
      `SELECT COUNT(*) AS n FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA = ? AND ROUTINE_NAME = 'smuggle'`,
      [db.schema],
    );
    expect(Number(after[0]?.n)).toBe(1);
  });

  test("a \\! line inside a code record never executes through swapStagingIntoLive", async () => {
    const sentinel = sentinelPath();
    const db = await createTestDatabase();
    await rootQuery(`CREATE TABLE \`${db.schema}\`.t (id INT PRIMARY KEY)`);
    await rootQuery(`INSERT INTO \`${db.schema}\`.t VALUES (1)`);
    const source = await createTestDatabase();
    await rootQuery(`CREATE TABLE \`${source.schema}\`.t (id INT PRIMARY KEY)`);
    await rootQuery(`CREATE PROCEDURE \`${source.schema}\`.p_bang()\nBEGIN\n-- \\! touch ${sentinel}\n  SELECT 1;\nEND`);
    await rootQuery(`CREATE VIEW \`${source.schema}\`.v_ok AS SELECT id FROM \`${source.schema}\`.t`);
    const code = await captureCodeRecords(admin, source.schema);
    const staging = await createStagingSchema(db.schema);
    await rootQuery(`CREATE TABLE \`${staging}\`.t (id INT PRIMARY KEY)`);
    await rootQuery(`INSERT INTO \`${staging}\`.t VALUES (2)`);
    const result = await swapStagingIntoLive({ live: db.schema, staging, code });
    expect(result.outcome).toBe("done");
    await Bun.sleep(200);
    expect(existsSync(sentinel)).toBe(false);
    const rows = await rootQuery<{ id: number }>(`SELECT id FROM \`${db.schema}\`.t ORDER BY id`);
    expect(rows.map((r) => r.id)).toEqual([2]);
    void result;
  });

  test("a routine whose body contains these characters still round-trips intact", async () => {
    const db = await createTestDatabase();
    await rootQuery(
      `CREATE PROCEDURE \`${db.schema}\`.keeper()
       BEGIN
         DECLARE marker TEXT DEFAULT 'system touch and bang chars kept';
         SET marker = 'system touch and bang chars kept';
       END`,
    );
    const before = await rootQuery<{ body: string }>(
      `SELECT ROUTINE_DEFINITION AS body FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA = ? AND ROUTINE_NAME = 'keeper'`,
      [db.schema],
    );
    expect(before[0]?.body).toContain("system touch and bang chars kept");
    await applyCodeRecords(db.schema, await captureCodeRecords(admin, db.schema), { replace: true });
    const after = await rootQuery<{ body: string }>(
      `SELECT ROUTINE_DEFINITION AS body FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA = ? AND ROUTINE_NAME = 'keeper'`,
      [db.schema],
    );
    expect(after[0]?.body).toBe(before[0]?.body);
    expect(after[0]?.body).toContain("system touch and bang chars kept");
  });

  afterAll(() => {
    for (let i = 1; i <= sentinelCounter; i++) {
      rmSync(join(testTmpRoot(), `client-exec-sentinel-${process.pid}-${i}.txt`), { force: true });
    }
  });
});
