import { checksums, codeObjectsOf, exec, finished, makeDatabase, mariadbAvailable, rootQuery, setup, type Fixture } from "./helpers";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import mysql from "mysql2/promise";
import { env } from "../../src/env";
import { syncJobs } from "../../src/db/queries";
import { encryptSecret } from "../../src/util/crypto";
import { newId } from "../../src/util/id";
import { startSyncJob, syncSource } from "../../src/workers/sync";
import { STAGING_PREFIX } from "../../src/mariadb/schemaSwap";

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

function streamOf(text: string): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

async function leftoverStaging(): Promise<string[]> {
  const rows = await rootQuery<{ n: string }>("SELECT SCHEMA_NAME AS n FROM information_schema.SCHEMATA");
  return rows.map((r) => r.n).filter((n) => n.startsWith(STAGING_PREFIX));
}

describe.skipIf(!mariadbAvailable())("mirror sync against a hostile source", () => {
  let fx: Fixture;
  const realDump = syncSource.dump;

  beforeAll(async () => {
    fx = await setup();
  }, 180_000);

  afterAll(async () => {
    syncSource.dump = realDump;
    await fx?.instance.stop();
  }, 120_000);

  test("statements aimed outside the staging copy fail and change nothing", async () => {
    const source = await makeDatabase(fx.owner);
    await exec(source.database.name, "CREATE TABLE t (id INT PRIMARY KEY)", "INSERT INTO t VALUES (1)");
    const victim = await makeDatabase(fx.owner);
    await exec(victim.database.name, "CREATE TABLE t (id INT PRIMARY KEY)", "INSERT INTO t VALUES (1)");
    const mirror = await makeDatabase(fx.owner, { kind: "mirror", versioned: true });
    await exec(mirror.database.name, "CREATE TABLE keep (id INT PRIMARY KEY)", "INSERT INTO keep VALUES (7)");
    await configure(mirror.database.id, {
      database: source.database.name,
      user: source.credentials.user,
      password: source.credentials.password,
    });
    const v = `\`${victim.database.name}\``;
    const hostile = [
      `INSERT INTO ${v}.t VALUES (666);`,
      `DROP DATABASE ${v};`,
      `CREATE TABLE ${v}.planted (id INT);`,
      "CREATE USER 'ld_evil_probe'@'%' IDENTIFIED BY 'x1x2x3x4';",
      "GRANT ALL PRIVILEGES ON *.* TO 'ld_evil_probe'@'%';",
      "SET GLOBAL max_connections = 7;",
      "SELECT 1 INTO OUTFILE '/tmp/ld-evil-probe.txt';",
      "CREATE DEFINER=`root`@`localhost` PROCEDURE evil() SELECT 1;",
      "CREATE PROCEDURE plain_proc() SELECT 1;",
      "KILL CONNECTION 1;",
    ];
    const victimBefore = await checksums(victim.database.name);
    const mirrorBefore = await checksums(mirror.database.name);
    const [limit] = await rootQuery<{ m: number }>("SELECT @@GLOBAL.max_connections AS m");
    try {
      for (const statement of hostile) {
        syncSource.dump = () => ({
          stdout: streamOf(`CREATE TABLE t (id INT PRIMARY KEY);\nINSERT INTO t VALUES (1);\n${statement}\n`),
          done: Promise.resolve(),
        });
        const job = await finished(startSyncJob(mirror.database.id, null).id);
        expect({ statement, status: job.status }).toEqual({ statement, status: "failed" });
        expect(job.error).not.toContain(source.credentials.password);
        expect(job.error).toMatch(/denied|unknown thread|base tables only/i);
        expect(await checksums(mirror.database.name)).toEqual(mirrorBefore);
      }
    } finally {
      syncSource.dump = realDump;
    }
    expect(await checksums(victim.database.name)).toEqual(victimBefore);
    expect(await rootQuery("SELECT User FROM mysql.user WHERE User = 'ld_evil_probe'")).toEqual([]);
    expect(await rootQuery<{ m: number }>("SELECT @@GLOBAL.max_connections AS m")).toEqual([limit!]);
    expect(await codeObjectsOf(mirror.database.name)).toEqual([]);
    expect(await leftoverStaging()).toEqual([]);
  }, 240_000);

  test("a source's code objects are created as the mirror's own user and cannot reach other schemas", async () => {
    await rootQuery("CREATE DATABASE IF NOT EXISTS zz_sync_secret");
    await rootQuery("CREATE TABLE IF NOT EXISTS zz_sync_secret.s (v VARCHAR(20))");
    await rootQuery("INSERT INTO zz_sync_secret.s VALUES ('top secret')");
    const source = await makeDatabase(fx.owner);
    const s = source.database.name;
    await exec(
      s,
      "CREATE TABLE t (id INT PRIMARY KEY)",
      "INSERT INTO t VALUES (1)",
      "CREATE VIEW v_leak AS SELECT v FROM zz_sync_secret.s",
      "CREATE DEFINER=`root`@`localhost` PROCEDURE p_leak() SQL SECURITY DEFINER SELECT v FROM zz_sync_secret.s",
      "CREATE VIEW v_ok AS SELECT id FROM t",
    );
    await rootQuery(`GRANT SELECT ON zz_sync_secret.s TO ?@'%'`, [source.credentials.user]);
    const mirror = await makeDatabase(fx.owner, { kind: "mirror" });
    await configure(mirror.database.id, {
      database: s,
      user: source.credentials.user,
      password: source.credentials.password,
    });
    const job = await finished(startSyncJob(mirror.database.id, null).id);
    expect(job.status).toBe("succeeded");
    expect(job.result).toMatchObject({ outcome: "done-with-errors" });
    const failures = (job.result as { codeFailures: { kind: string; name: string; error: string }[] }).codeFailures;
    expect(failures.map((f) => `${f.kind}:${f.name}`)).toEqual(["VIEW:v_leak"]);
    for (const f of failures) expect(f.error).not.toMatch(/ld_(?:scp|imp)_|command denied|\bERROR\b/);
    expect(await codeObjectsOf(mirror.database.name)).toEqual(["procedure:p_leak", "view:v_ok"]);
    const definers = await rootQuery<{ d: string }>(
      `SELECT DEFINER AS d FROM information_schema.VIEWS WHERE TABLE_SCHEMA = ?
       UNION ALL SELECT DEFINER FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA = ?`,
      [mirror.database.name, mirror.database.name],
    );
    for (const r of definers) expect(r.d).toBe(`${mirror.credentials.user}@%`);
    const user = await mysql.createConnection({
      host: "127.0.0.1",
      port: env.mariadbPort,
      user: mirror.credentials.user,
      password: mirror.credentials.password,
      database: mirror.database.name,
    });
    try {
      await expect(user.query("CALL p_leak()")).rejects.toThrow(/denied/i);
    } finally {
      await user.end();
    }
  }, 240_000);
});
