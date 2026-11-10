import { createTestDatabase, mariadbAvailable, rootQuery, startTestInstance, type TestInstance } from "../harness/instance";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { copyFileSync, existsSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import mysql from "mysql2/promise";
import "../../src/databases/startup";
import { env } from "../../src/env";
import { captureCodeRecords, renderCodeRecords, type CodeRecord } from "../../src/mariadb/codeObjects";
import { getRootPassword, mariadbServerPid, mariadbState } from "../../src/mariadb/controller";
import { journalDir } from "../../src/mariadb/journal";
import { explainMariaDbFailure, sanitizeMariaDbMessage } from "../../src/mariadb/messages";
import { localAdminTarget } from "../../src/mariadb/process";
import {
  QUARANTINE_PREFIX,
  STAGING_PREFIX,
  SwapStaleError,
  TRASH_PREFIX,
  cleanupOrphanSchemas,
  createStagingSchema,
  dropSchemaIfExists,
  onSwapCompleted,
  onSwapRolledBack,
  recoverInterruptedSwaps,
  swapRecoveryPending,
  swapStagingIntoLive,
  type ExpectLive,
  type SwapHookInfo,
  type SwapNote,
} from "../../src/mariadb/schemaSwap";

type Db = { schema: string; user: string; password: string };

async function as(db: Db, user?: { user: string; password: string }): Promise<mysql.Connection> {
  return mysql.createConnection({
    host: "127.0.0.1",
    port: env.mariadbPort,
    user: user?.user ?? env.rootUser,
    password: user?.password ?? (await getRootPassword()),
    database: db.schema,
    multipleStatements: true,
  });
}

async function run(db: Db, sql: string): Promise<void> {
  const c = await as(db);
  try {
    await c.query(sql);
  } finally {
    await c.end();
  }
}

async function makeLive(): Promise<Db> {
  const db = await createTestDatabase();
  await run(db, "CREATE TABLE orders (id INT PRIMARY KEY, note VARCHAR(20)); CREATE TABLE other (id INT PRIMARY KEY); INSERT INTO orders VALUES (1, 'a'), (2, 'b');");
  return db;
}

async function copyToStaging(db: Db, tables = ["orders", "other"]): Promise<string> {
  const staging = await createStagingSchema(db.schema);
  for (const t of tables) {
    await rootQuery(`CREATE TABLE \`${staging}\`.\`${t}\` LIKE \`${db.schema}\`.\`${t}\``);
    await rootQuery(`INSERT INTO \`${staging}\`.\`${t}\` SELECT * FROM \`${db.schema}\`.\`${t}\``);
  }
  return staging;
}

async function expectNow(db: Db): Promise<ExpectLive> {
  const tables: ExpectLive["tables"] = [];
  for (const t of await rootQuery<{ n: string }>(
    "SELECT TABLE_NAME AS n FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_TYPE = 'BASE TABLE' ORDER BY 1",
    [db.schema],
  )) {
    const [count] = await rootQuery<{ n: number }>(`SELECT COUNT(*) AS n FROM \`${db.schema}\`.\`${t.n}\``);
    const [sum] = await rootQuery<{ Checksum: number }>(`CHECKSUM TABLE \`${db.schema}\`.\`${t.n}\``);
    tables.push({ name: t.n, rowCount: Number(count!.n), checksum: Number(sum!.Checksum) });
  }
  return { tables, capturedAt: Date.now() };
}

async function rows(schema: string, table: string): Promise<number[]> {
  return (await rootQuery<{ id: number }>(`SELECT id FROM \`${schema}\`.\`${table}\` ORDER BY id`)).map((r) => Number(r.id));
}

async function schemas(prefix: string): Promise<string[]> {
  const all = await rootQuery<{ n: string }>("SELECT SCHEMA_NAME AS n FROM information_schema.SCHEMATA ORDER BY 1");
  return all.map((r) => r.n).filter((n) => n.startsWith(prefix));
}

function journals(): string[] {
  const dir = journalDir();
  return existsSync(dir) ? readdirSync(dir).filter((n) => n.startsWith("swap-")) : [];
}

async function originals(schema: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const t of await rootQuery<{ n: string }>("SELECT TRIGGER_NAME AS n FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = ?", [schema])) {
    const [row] = await rootQuery<Record<string, string>>(`SHOW CREATE TRIGGER \`${schema}\`.\`${t.n}\``);
    out[t.n] = row!["SQL Original Statement"]!;
  }
  return out;
}

function withoutSource(records: CodeRecord[]): unknown[] {
  return records.map(({ sourceSchema: _s, ...rest }) => rest);
}

describe.skipIf(!mariadbAvailable())("schema swap guards", () => {
  let instance: TestInstance | null = null;
  let extra = 0;

  async function extraAccount(db: Db): Promise<{ user: string; password: string }> {
    extra++;
    const user = `xa_${process.pid % 1000}_${extra}`;
    const password = "Extra-pass-1234";
    await rootQuery("CREATE USER ?@'%' IDENTIFIED BY ?", [user, password]);
    await rootQuery(`GRANT ALL PRIVILEGES ON \`${db.schema}\`.* TO ?@'%'`, [user]);
    return { user, password };
  }

  beforeAll(async () => {
    instance = await startTestInstance();
  }, 120_000);

  afterAll(async () => {
    await instance?.stop();
  }, 60_000);

  test("a write by another account after the safety checkpoint makes the swap refuse, changing nothing", async () => {
    const db = await makeLive();
    const staging = await copyToStaging(db);
    const expectLive = await expectNow(db);
    const app = await as(db, await extraAccount(db));
    await app.query("INSERT INTO orders VALUES (3, 'paid')");
    await app.end();
    const err = await swapStagingIntoLive({ live: db.schema, staging, expectLive }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SwapStaleError);
    expect((err as SwapStaleError).changed).toEqual(["orders"]);
    expect((err as Error).message).toContain("nothing was changed");
    expect(await rows(db.schema, "orders")).toEqual([1, 2, 3]);
    expect(await schemas(STAGING_PREFIX)).toEqual([staging]);
    expect(await rows(staging, "orders")).toEqual([1, 2]);
    expect(await schemas(TRASH_PREFIX)).toEqual([]);
    expect(journals()).toEqual([]);
    await cleanupOrphanSchemas();
    expect(await schemas(STAGING_PREFIX)).toEqual([staging]);

    const retried = await swapStagingIntoLive({ live: db.schema, staging, expectLive: await expectNow(db) });
    expect(retried.outcome).toBe("done");
    expect(await rows(db.schema, "orders")).toEqual([1, 2]);
    expect(await schemas(STAGING_PREFIX)).toEqual([]);
    expect(await schemas(TRASH_PREFIX)).toEqual([]);

    const again = await copyToStaging(db);
    const stale = await expectNow(db);
    await run(db, "INSERT INTO orders VALUES (4, 'late')");
    expect(await swapStagingIntoLive({ live: db.schema, staging: again, expectLive: stale }).catch((e: unknown) => e)).toBeInstanceOf(SwapStaleError);
    await dropSchemaIfExists(again);
    expect(await schemas(STAGING_PREFIX)).toEqual([]);
    expect(await rows(db.schema, "orders")).toEqual([1, 2, 4]);
  }, 60_000);

  test("the check sees a change that keeps the row count, a new table, and skips values it was not given", async () => {
    const db = await makeLive();
    const base = await expectNow(db);
    await run(db, "UPDATE orders SET note = 'z' WHERE id = 2");
    const s1 = await copyToStaging(db);
    const same = await swapStagingIntoLive({ live: db.schema, staging: s1, expectLive: base }).catch((e: unknown) => e);
    expect((same as SwapStaleError).changed).toEqual(["orders"]);
    await dropSchemaIfExists(s1);

    await run(db, "CREATE TABLE added (id INT PRIMARY KEY)");
    const s2 = await copyToStaging(db);
    const added = await swapStagingIntoLive({ live: db.schema, staging: s2, expectLive: await expectNow(db).then((e) => ({ ...e, tables: e.tables.filter((t) => t.name !== "added") })) }).catch(
      (e: unknown) => e,
    );
    expect((added as SwapStaleError).changed).toEqual(["added (added)"]);
    await dropSchemaIfExists(s2);

    const loose = await expectNow(db);
    await run(db, "UPDATE orders SET note = 'y' WHERE id = 1");
    const s3 = await copyToStaging(db, ["orders", "other", "added"]);
    const result = await swapStagingIntoLive({
      live: db.schema,
      staging: s3,
      expectLive: { ...loose, tables: loose.tables.map((t) => (t.name === "orders" ? { ...t, rowCount: null, checksum: null } : t)) },
    });
    expect(result.outcome).toBe("done");
  }, 60_000);

  async function interruptedAfterMoveOut(db: Db): Promise<{ name: string; staging: string; trash: string; saved: string }> {
    const saved = mkdtempSync(join(tmpdir(), "ld-guard-"));
    let copied: { name: string; staging: string; trash: string } | null = null;
    await swapStagingIntoLive({
      live: db.schema,
      staging: await copyToStaging(db),
      onPhase: (phase) => {
        if (phase !== "moved-out") return;
        const name = journals()[0]!;
        copyFileSync(join(journalDir(), name), join(saved, name));
        const j = JSON.parse(readFileSync(join(journalDir(), name), "utf8")) as { staging: string; trash: string };
        copied = { name, staging: j.staging, trash: j.trash };
        throw new Error("simulated stop");
      },
    }).catch(() => {});
    const k = copied as unknown as { name: string; staging: string; trash: string };
    await rootQuery(`CREATE DATABASE \`${k.staging}\``);
    await rootQuery(`CREATE TABLE \`${k.staging}\`.orders (id INT PRIMARY KEY, note VARCHAR(20))`);
    await rootQuery(`CREATE DATABASE \`${k.trash}\``);
    await rootQuery(`RENAME TABLE \`${db.schema}\`.orders TO \`${k.trash}\`.orders, \`${db.schema}\`.other TO \`${k.trash}\`.other`);
    return { ...k, saved };
  }

  test("while the swap holds the old tables, no session can create a table under their names", async () => {
    const db = await makeLive();
    const staging = await copyToStaging(db);
    const creds = await extraAccount(db);
    const app = await as(db, creds);
    await app.query("SET SESSION lock_wait_timeout = 1");
    let attempt: unknown = null;
    const result = await swapStagingIntoLive({
      live: db.schema,
      staging,
      onPhase: async (phase) => {
        if (phase !== "moved-out") return;
        attempt = await app.query("CREATE TABLE IF NOT EXISTS orders (id INT PRIMARY KEY, note VARCHAR(20)); INSERT INTO orders VALUES (99, 'intruder');").catch((e: unknown) => e);
      },
    });
    await app.end();
    expect(result.outcome).toBe("done");
    expect(String(attempt)).toContain("Lock wait timeout");
    expect(await rows(db.schema, "orders")).toEqual([1, 2]);
    expect(await schemas(QUARANTINE_PREFIX)).toEqual([]);
  }, 60_000);

  test("a table created under a set-aside name before recovery is moved aside, and the original comes back whole", async () => {
    const db = await makeLive();
    const k = await interruptedAfterMoveOut(db);
    await run(db, "CREATE TABLE orders (id INT PRIMARY KEY, note VARCHAR(20)); INSERT INTO orders VALUES (99, 'intruder');");
    const reasons: string[] = [];
    const off = onSwapRolledBack((_n, info) => {
      if (info.live === db.schema && info.reason) reasons.push(info.reason);
    });
    copyFileSync(join(k.saved, k.name), join(journalDir(), k.name));
    try {
      const report = await recoverInterruptedSwaps();
      expect(report.rolledBack).toContain(db.schema);
    } finally {
      off();
    }
    const quarantine = await schemas(QUARANTINE_PREFIX);
    expect(quarantine.length).toBe(1);
    expect(reasons.join(" ")).toContain(quarantine[0]!);
    expect(reasons.join(" ")).toContain("nothing was lost");
    expect(await rows(db.schema, "orders")).toEqual([1, 2]);
    expect(await rows(quarantine[0]!, "orders")).toEqual([99]);
    expect(await schemas(TRASH_PREFIX)).toEqual([]);
    expect(journals()).toEqual([]);
    await rootQuery(`DROP DATABASE \`${quarantine[0]}\``);
  }, 60_000);

  test("an object that cannot be moved aside keeps the original in the trash schema, named in the refusal, until recovery can finish", async () => {
    const db = await makeLive();
    const k = await interruptedAfterMoveOut(db);
    await run(db, "CREATE VIEW orders AS SELECT 1 AS id");
    copyFileSync(join(k.saved, k.name), join(journalDir(), k.name));
    const report = await recoverInterruptedSwaps();
    expect(report.failed).toContain(db.schema);
    expect(swapRecoveryPending(db.schema)).toBe(true);
    const next = await createStagingSchema(db.schema).catch((e: unknown) => e);
    expect(next).toBeInstanceOf(Error);
    expect((next as Error).message).toContain(k.trash);
    expect((next as Error).message).toContain("`orders`");
    expect(await rows(k.trash, "orders")).toEqual([1, 2]);
    await run(db, "DROP VIEW orders");
    const done = await recoverInterruptedSwaps();
    expect(done.rolledBack).toContain(db.schema);
    expect(await rows(db.schema, "orders")).toEqual([1, 2]);
    expect(await schemas(TRASH_PREFIX)).toEqual([]);
    expect(await schemas(STAGING_PREFIX)).toEqual([]);
  }, 60_000);

  test("the completion hook runs before the journal is removed, on the normal path and in recovery; recovery reports rollbacks", async () => {
    const heard: { kind: string; note: SwapNote | null; info: SwapHookInfo; journalPresent: boolean }[] = [];
    const offDone = onSwapCompleted((note, info) => {
      heard.push({ kind: "completed", note, info, journalPresent: journals().length > 0 });
    });
    const offBack = onSwapRolledBack((note, info) => {
      heard.push({ kind: "rolled-back", note, info, journalPresent: journals().length > 0 });
    });
    try {
      const a = await makeLive();
      await swapStagingIntoLive({ live: a.schema, staging: await copyToStaging(a), databaseId: "db_hook_a", note: { kind: "checkpoint.restore", jobId: "job_a" } });

      const b = await makeLive();
      await swapStagingIntoLive({
        live: b.schema,
        staging: await copyToStaging(b),
        databaseId: "db_hook_b",
        note: { kind: "checkpoint.restore", jobId: "job_b" },
        onPhase: (phase) => {
          if (phase === "renamed") throw new Error("simulated stop after the rename");
        },
      }).catch(() => {});
      await recoverInterruptedSwaps();

      const c = await makeLive();
      const saved = mkdtempSync(join(tmpdir(), "ld-hook-"));
      let copied: { name: string; staging: string; trash: string } | null = null;
      await swapStagingIntoLive({
        live: c.schema,
        staging: await copyToStaging(c),
        databaseId: "db_hook_c",
        note: { kind: "checkpoint.restore", jobId: "job_c" },
        onPhase: (phase) => {
          if (phase !== "moved-out") return;
          const name = journals()[0]!;
          copyFileSync(join(journalDir(), name), join(saved, name));
          const j = JSON.parse(readFileSync(join(journalDir(), name), "utf8")) as { staging: string; trash: string };
          copied = { name, staging: j.staging, trash: j.trash };
          throw new Error("simulated failure after the old tables left");
        },
      }).catch(() => {});
      const k = copied as unknown as { name: string; staging: string; trash: string };
      await rootQuery(`CREATE DATABASE \`${k.trash}\``);
      await rootQuery(`RENAME TABLE \`${c.schema}\`.orders TO \`${k.trash}\`.orders, \`${c.schema}\`.other TO \`${k.trash}\`.other`);
      copyFileSync(join(saved, k.name), join(journalDir(), k.name));
      await recoverInterruptedSwaps();
      expect(await rows(c.schema, "orders")).toEqual([1, 2]);
    } finally {
      offDone();
      offBack();
    }
    const summary = heard.map((h) => [h.kind, h.note?.jobId, h.info.recovered, h.info.databaseId, h.journalPresent]);
    expect(summary).toEqual([
      ["completed", "job_a", false, "db_hook_a", true],
      ["completed", "job_b", true, "db_hook_b", true],
      ["rolled-back", "job_c", false, "db_hook_c", true],
      ["rolled-back", "job_c", true, "db_hook_c", true],
    ]);
    expect(heard[3]!.info.reason).toContain("put back as it was");
  }, 120_000);

  test("after MariaDB restarts mid-swap, recovery finishes the swap, puts back the schema defaults, and cleans up copies and accounts", async () => {
    const db = await makeLive();
    const staging = await copyToStaging(db);
    let killed = 0;
    const err = await swapStagingIntoLive({
      live: db.schema,
      staging,
      schemaDefaults: { characterSet: "latin1", collation: "latin1_swedish_ci" },
      definers: { account: { user: db.user, host: "%" } },
      onPhase: async (phase) => {
        if (phase !== "triggers") return;
        killed = mariadbServerPid() ?? 0;
        process.kill(killed, "SIGKILL");
        while (mariadbServerPid() === killed) await Bun.sleep(20);
      },
    }).catch((e: unknown) => e);
    expect(String(err)).toContain("completed automatically");
    const deadline = Date.now() + 90_000;
    for (;;) {
      if (mariadbState() === "running" && journals().length === 0) {
        const left = [...(await schemas(STAGING_PREFIX)), ...(await schemas(TRASH_PREFIX))];
        const accounts = await rootQuery("SELECT User FROM mysql.user WHERE User LIKE 'ld\\_scp\\_%'");
        if (left.length === 0 && accounts.length === 0) break;
      }
      if (Date.now() > deadline) throw new Error("recovery after the restart did not finish");
      await Bun.sleep(250);
    }
    const [defaults] = await rootQuery<{ cs: string }>("SELECT DEFAULT_CHARACTER_SET_NAME AS cs FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = ?", [db.schema]);
    expect(defaults!.cs).toBe("latin1");
    expect(await rows(db.schema, "orders")).toEqual([1, 2]);
  }, 180_000);

  test("failures name no temporary account or staging schema and say plainly what is outside the database", async () => {
    expect(sanitizeMariaDbMessage("SELECT command denied to user 'ld_scp_abcdefghijkl'@'127.0.0.1' for table `rates`.`fx_rates`")).toBe(
      "SELECT command denied for table `rates`.`fx_rates`",
    );
    expect(sanitizeMariaDbMessage("Table '_ld_stage_ab12cd34_shop.orders' doesn't exist")).toBe("Table 'orders' doesn't exist");
    expect(sanitizeMariaDbMessage("schema _ld_trash_ab12cd34_shop is busy")).toBe("schema the set-aside copy of the old tables is busy");
    expect(explainMariaDbFailure("SELECT command denied to user 'ld_scp_abcdefghijkl'@'127.0.0.1' for table `rates`.`fx_rates`")).toBe(
      "reads `rates`.`fx_rates`, which is outside this database",
    );
    expect(explainMariaDbFailure("execute command denied to user 'ld_scp_abcdefghijkl'@'127.0.0.1' for routine 'rates.fx'")).toBe(
      "calls `rates`.`fx`, which is outside this database",
    );

    await rootQuery("CREATE DATABASE IF NOT EXISTS zz_rates");
    await rootQuery("CREATE TABLE IF NOT EXISTS zz_rates.fx (id INT PRIMARY KEY, r INT)");
    const db = await makeLive();
    await run(db, "CREATE VIEW v_fx AS SELECT * FROM zz_rates.fx");
    const code = await captureCodeRecords(await localAdminTarget(), db.schema);
    await run(db, "DROP VIEW v_fx");
    const result = await swapStagingIntoLive({ live: db.schema, staging: await copyToStaging(db), code, definers: { account: { user: db.user, host: "%" }, keep: "account" } });
    expect(result.outcome).toBe("done-with-errors");
    const failure = result.failures[0]!;
    expect(failure.name).toBe("v_fx");
    expect(failure.error).not.toMatch(/ld_scp_|_ld_stage_|_ld_trash_/);
    expect(failure.explanation).toBe("reads `zz_rates`.`fx`, which is outside this database");
    expect(result.warnings.join(" ")).not.toMatch(/ld_scp_|_ld_stage_|_ld_trash_/);
    await rootQuery("DROP DATABASE zz_rates");
  }, 60_000);

  test("a rollback leaves every trigger exactly as the server printed it, and capture returns the records that were applied", async () => {
    const db = await createTestDatabase();
    const s = db.schema;
    await run(
      db,
      [
        "CREATE TABLE t (id INT PRIMARY KEY, v INT);",
        "CREATE TABLE log (id INT AUTO_INCREMENT PRIMARY KEY, v INT);",
        "create trigger t_doc before insert on t for each row\nbegin\n  -- clamp negative values\n  if new.v < 0 then set new.v = 0; end if;\nend;",
        `CREATE TRIGGER \`${s}\`.t_qual AFTER INSERT ON \`${s}\`.t FOR EACH ROW INSERT INTO log (v) VALUES (NEW.v);`,
        "CREATE TRIGGER t_after AFTER INSERT ON t FOR EACH ROW FOLLOWS t_qual INSERT INTO log (v) VALUES (-NEW.v);",
      ].join("\n"),
    );
    const before = await originals(s);
    const code = await captureCodeRecords(await localAdminTarget(), s);
    const staging = await createStagingSchema(s);
    await rootQuery(`CREATE TABLE \`${staging}\`.t LIKE \`${s}\`.t`);
    await rootQuery(`CREATE TABLE \`${staging}\`.log LIKE \`${s}\`.log`);
    const result = await swapStagingIntoLive({ live: s, staging, code, definers: { account: { user: db.user, host: "%" } } });
    expect(result.failures).toEqual([]);
    expect(await originals(s)).toEqual(before);
    const after = await captureCodeRecords(await localAdminTarget(), s);
    expect(withoutSource(after)).toEqual(withoutSource(code));
    expect(renderCodeRecords(after)).toBe(renderCodeRecords(code));
    const order = await rootQuery<{ n: string; o: number }>(
      "SELECT TRIGGER_NAME AS n, ACTION_ORDER AS o FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = ? AND ACTION_TIMING = 'AFTER' ORDER BY ACTION_ORDER",
      [s],
    );
    expect(order.map((r) => r.n)).toEqual(["t_qual", "t_after"]);
  }, 60_000);
});
