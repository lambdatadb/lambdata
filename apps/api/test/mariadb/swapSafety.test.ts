import { createTestDatabase, mariadbAvailable, rootQuery, startTestInstance, type TestInstance } from "../harness/instance";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { copyFileSync, existsSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import mysql from "mysql2/promise";
import { env } from "../../src/env";
import { captureCodeRecords, type CodeRecord } from "../../src/mariadb/codeObjects";
import { getRootPassword } from "../../src/mariadb/controller";
import { journalDir } from "../../src/mariadb/journal";
import { localAdminTarget } from "../../src/mariadb/process";
import {
  STAGING_PREFIX,
  SwapBlockedError,
  SwapRefusedError,
  TRASH_PREFIX,
  cleanupOrphanSchemas,
  createStagingSchema,
  holdSwapsForShutdown,
  onSwapRecovered,
  recoverInterruptedSwaps,
  releaseSwapHold,
  swapRecoveryPending,
  swapStagingIntoLive,
  type RecoveredSwap,
} from "../../src/mariadb/schemaSwap";

type Row = Record<string, unknown>;
type Db = { schema: string; user: string; password: string };

const TABLES = ["ledger", "payments", "sessions"];

async function connect(db: Db, asOwner: boolean): Promise<mysql.Connection> {
  return mysql.createConnection({
    host: "127.0.0.1",
    port: env.mariadbPort,
    user: asOwner ? db.user : env.rootUser,
    password: asOwner ? db.password : await getRootPassword(),
    database: db.schema,
    multipleStatements: true,
  });
}

async function makeLive(): Promise<Db> {
  const db = await createTestDatabase();
  const c = await connect(db, true);
  try {
    await c.query(`
      CREATE TABLE payments (id INT PRIMARY KEY, amount INT);
      CREATE TABLE ledger (id INT AUTO_INCREMENT PRIMARY KEY, payment_id INT);
      CREATE TABLE sessions (id INT PRIMARY KEY);
      CREATE TRIGGER payments_ledger AFTER INSERT ON payments FOR EACH ROW INSERT INTO ledger (payment_id) VALUES (NEW.id);
      CREATE VIEW v_total AS SELECT SUM(amount) AS total FROM payments;
      CREATE PROCEDURE p_count()
      BEGIN
        -- counts the payments
        SELECT COUNT(*) FROM payments;
      END;
      INSERT INTO sessions VALUES (1);
      INSERT INTO payments VALUES (1, 100);
    `);
  } finally {
    await c.end();
  }
  return db;
}

async function snapshot(db: Db): Promise<{ staging: string; code: CodeRecord[] }> {
  const staging = await createStagingSchema(db.schema);
  for (const t of TABLES) {
    await rootQuery(`CREATE TABLE \`${staging}\`.\`${t}\` LIKE \`${db.schema}\`.\`${t}\``);
    await rootQuery(`INSERT INTO \`${staging}\`.\`${t}\` SELECT * FROM \`${db.schema}\`.\`${t}\``);
  }
  return { staging, code: await captureCodeRecords(await localAdminTarget(), db.schema) };
}

async function codeOf(schema: string): Promise<Record<string, string>> {
  const rows = await rootQuery<Row>(
    `SELECT CONCAT('trigger:', TRIGGER_NAME) AS k, CONCAT_WS('|', EVENT_OBJECT_TABLE, ACTION_ORDER, DEFINER, ACTION_STATEMENT) AS v
       FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = ?
     UNION ALL SELECT CONCAT('view:', TABLE_NAME), CONCAT_WS('|', DEFINER, VIEW_DEFINITION) FROM information_schema.VIEWS WHERE TABLE_SCHEMA = ?
     UNION ALL SELECT CONCAT(LOWER(ROUTINE_TYPE), ':', ROUTINE_NAME), CONCAT_WS('|', DEFINER, ROUTINE_DEFINITION)
       FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA = ?`,
    [schema, schema, schema],
  );
  return Object.fromEntries(rows.map((r) => [String(r.k), String(r.v)]));
}

async function ids(schema: string, table: string, column = "id"): Promise<number[]> {
  const rows = await rootQuery<Row>(`SELECT \`${column}\` AS v FROM \`${schema}\`.\`${table}\` ORDER BY id`);
  return rows.map((r) => Number(r.v));
}

async function tablesOf(schema: string): Promise<string[]> {
  const rows = await rootQuery<{ n: string }>(
    `SELECT TABLE_NAME AS n FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME`,
    [schema],
  );
  return rows.map((r) => r.n);
}

async function managedSchemas(): Promise<string[]> {
  const rows = await rootQuery<{ n: string }>(`SELECT SCHEMA_NAME AS n FROM information_schema.SCHEMATA`);
  return rows.map((r) => r.n).filter((n) => n.startsWith(STAGING_PREFIX) || n.startsWith(TRASH_PREFIX));
}

function journalFiles(): string[] {
  const dir = journalDir();
  return existsSync(dir) ? readdirSync(dir).filter((n) => n.startsWith("swap-")) : [];
}

async function triggerCount(schema: string): Promise<number> {
  const [row] = await rootQuery<{ n: number }>(`SELECT COUNT(*) AS n FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = ?`, [schema]);
  return Number(row!.n);
}

describe.skipIf(!mariadbAvailable())("schema swap safety", () => {
  let instance: TestInstance | null = null;

  beforeAll(async () => {
    instance = await startTestInstance();
  }, 120_000);

  afterAll(async () => {
    releaseSwapHold();
    await instance?.stop();
  }, 60_000);

  test("an application holding a transaction makes the swap fail before anything is dropped, naming the session", async () => {
    const db = await makeLive();
    const { staging, code } = await snapshot(db);
    await rootQuery(`INSERT INTO \`${db.schema}\`.payments VALUES (2, 50)`);
    const before = await codeOf(db.schema);
    const holder = await connect(db, true);
    await holder.query("START TRANSACTION");
    await holder.query("SELECT * FROM sessions");
    const started = Date.now();
    let minTriggers = Number.POSITIVE_INFINITY;
    const swap = swapStagingIntoLive({ live: db.schema, staging, code, lockWaitTimeoutSec: 3 }).then(
      () => null,
      (err: unknown) => err,
    );
    let settled = false;
    void swap.then(() => {
      settled = true;
    });
    const writer = await connect(db, true);
    const insert = Bun.sleep(300).then(() => writer.query("INSERT INTO payments VALUES (3, 75)"));
    while (!settled) {
      minTriggers = Math.min(minTriggers, await triggerCount(db.schema));
      await Bun.sleep(50);
    }
    const err = await swap;
    await insert;
    await writer.end();
    await holder.query("COMMIT");
    await holder.end();
    expect(err).toBeInstanceOf(SwapBlockedError);
    expect((err as SwapBlockedError).blockers.map((b) => b.id)).toContain(holder.threadId!);
    expect((err as Error).message).toContain(`session ${holder.threadId}`);
    expect(Date.now() - started).toBeLessThan(15_000);
    expect(minTriggers).toBe(1);
    expect(await codeOf(db.schema)).toEqual(before);
    expect(await ids(db.schema, "payments")).toEqual([1, 2, 3]);
    expect(await ids(db.schema, "ledger", "payment_id")).toEqual([1, 2, 3]);
    expect(await managedSchemas()).toEqual([]);
    expect(journalFiles()).toEqual([]);
  }, 60_000);

  test("a stop right after the rename is completed at the next start, and orphan cleanup keeps the old tables until then", async () => {
    const db = await makeLive();
    const { staging, code } = await snapshot(db);
    const expected = await codeOf(db.schema);
    await rootQuery(`INSERT INTO \`${db.schema}\`.payments VALUES (2, 50)`);
    await rootQuery(`DROP VIEW \`${db.schema}\`.v_total`);
    await rootQuery(`CREATE VIEW \`${db.schema}\`.v_later AS SELECT 1 AS one`);
    const heard: RecoveredSwap[] = [];
    const stopListening = onSwapRecovered((swap) => {
      heard.push(swap);
    });
    const err = await swapStagingIntoLive({
      live: db.schema,
      staging,
      code,
      databaseId: "db_test_swap",
      note: { kind: "restore", checkpointId: "cp_test" },
      onPhase: (phase) => {
        if (phase === "renamed") throw new Error("simulated stop after the rename");
      },
    }).catch((e: unknown) => e);
    expect(String(err)).toContain("completed automatically");
    expect(swapRecoveryPending(db.schema)).toBe(true);
    const held = await managedSchemas();
    expect(held.length).toBe(2);
    const trash = held.find((n) => n.startsWith(TRASH_PREFIX))!;
    expect(await tablesOf(trash)).toEqual(TABLES);
    expect((await tablesOf(db.schema)).filter((t) => TABLES.includes(t))).toEqual(TABLES);
    expect(await triggerCount(db.schema)).toBe(0);
    await cleanupOrphanSchemas();
    expect(await managedSchemas()).toEqual(held);

    const report = await recoverInterruptedSwaps();
    stopListening();
    expect(report.completed).toContain(db.schema);
    expect(heard.map((h) => [h.live, h.databaseId, h.outcome, h.note?.checkpointId, h.result?.outcome])).toEqual([
      [db.schema, "db_test_swap", "completed", "cp_test", "done"],
    ]);
    expect(swapRecoveryPending(db.schema)).toBe(false);
    expect(await codeOf(db.schema)).toEqual(expected);
    expect(await tablesOf(db.schema)).toEqual(["ledger", "payments", "sessions", "v_total"]);
    expect(await ids(db.schema, "payments")).toEqual([1]);
    expect(await managedSchemas()).toEqual([]);
    expect(journalFiles()).toEqual([]);
    await rootQuery(`INSERT INTO \`${db.schema}\`.payments VALUES (5, 1)`);
    expect(await ids(db.schema, "ledger", "payment_id")).toEqual([1, 5]);
  }, 60_000);

  test("a stop in the middle of re-creating code is completed at the next start", async () => {
    const db = await makeLive();
    const { staging, code } = await snapshot(db);
    const expected = await codeOf(db.schema);
    await rootQuery(`DROP PROCEDURE \`${db.schema}\`.p_count`);
    const err = await swapStagingIntoLive({
      live: db.schema,
      staging,
      code,
      onPhase: (phase) => {
        if (phase === "triggers") throw new Error("simulated stop while re-creating code");
      },
    }).catch((e: unknown) => e);
    expect(String(err)).toContain("simulated stop");
    expect(swapRecoveryPending(db.schema)).toBe(true);
    await recoverInterruptedSwaps();
    expect(await codeOf(db.schema)).toEqual(expected);
    expect((await codeOf(db.schema))["procedure:p_count"]).toContain("-- counts the payments");
    expect(await managedSchemas()).toEqual([]);
  }, 60_000);

  test("a failure while the old tables are held is rolled back at once, and a stop after they left is rolled back at the next start", async () => {
    const db = await makeLive();
    const { staging, code } = await snapshot(db);
    await rootQuery(`INSERT INTO \`${db.schema}\`.payments VALUES (2, 50)`);
    const before = await codeOf(db.schema);
    const saved = mkdtempSync(join(tmpdir(), "ld-journal-"));
    let copied: { name: string; staging: string; trash: string } | null = null;
    const err = await swapStagingIntoLive({
      live: db.schema,
      staging,
      code,
      onPhase: async (phase) => {
        if (phase !== "moved-out") return;
        expect(await tablesOf(db.schema)).toEqual([...TABLES, "v_total"]);
        expect(await triggerCount(db.schema)).toBe(0);
        const name = journalFiles()[0]!;
        copyFileSync(join(journalDir(), name), join(saved, name));
        const j = JSON.parse(readFileSync(join(journalDir(), name), "utf8")) as { staging: string; trash: string };
        copied = { name, staging: j.staging, trash: j.trash };
        throw new Error("simulated failure after the old tables left");
      },
    }).catch((e: unknown) => e);
    expect(String(err)).toContain("simulated failure");
    expect(await codeOf(db.schema)).toEqual(before);
    expect(await ids(db.schema, "payments")).toEqual([1, 2]);
    expect(await managedSchemas()).toEqual([]);
    expect(journalFiles()).toEqual([]);

    const c = copied as unknown as { name: string; staging: string; trash: string };
    await rootQuery(`CREATE DATABASE \`${c.staging}\``);
    await rootQuery(`CREATE TABLE \`${c.staging}\`.payments (id INT PRIMARY KEY, amount INT)`);
    await rootQuery(`CREATE DATABASE \`${c.trash}\``);
    await rootQuery(`DROP TRIGGER \`${db.schema}\`.payments_ledger`);
    await rootQuery(`RENAME TABLE ${TABLES.map((t) => `\`${db.schema}\`.\`${t}\` TO \`${c.trash}\`.\`${t}\``).join(", ")}`);
    copyFileSync(join(saved, c.name), join(journalDir(), c.name));
    expect(swapRecoveryPending(db.schema)).toBe(true);
    const report = await recoverInterruptedSwaps();
    expect(report.rolledBack).toContain(db.schema);
    expect(await codeOf(db.schema)).toEqual(before);
    expect(await ids(db.schema, "payments")).toEqual([1, 2]);
    expect(await managedSchemas()).toEqual([]);
    expect(journalFiles()).toEqual([]);
    await rootQuery(`INSERT INTO \`${db.schema}\`.payments VALUES (9, 1)`);
    expect(await ids(db.schema, "ledger", "payment_id")).toEqual([1, 2, 9]);
  }, 60_000);

  test("re-creating code after the swap has a bounded lock wait, and the job says it finished with errors", async () => {
    const db = await makeLive();
    const { staging, code } = await snapshot(db);
    await rootQuery(`DROP TRIGGER \`${db.schema}\`.payments_ledger`);
    let app: mysql.Connection | null = null;
    const started = Date.now();
    const result = await swapStagingIntoLive({
      live: db.schema,
      staging,
      code,
      codeLockWaitTimeoutSec: 2,
      codeTimeoutMs: 30_000,
      onPhase: async (phase) => {
        if (phase !== "renamed") return;
        app = await connect(db, false);
        await app.query("START TRANSACTION");
        await app.query("SELECT * FROM payments");
      },
    });
    const elapsed = Date.now() - started;
    await (app as mysql.Connection | null)?.query("COMMIT");
    await (app as mysql.Connection | null)?.end();
    expect(elapsed).toBeLessThan(20_000);
    expect(result.outcome).toBe("done-with-errors");
    expect(result.failures.map((f) => `${f.kind}:${f.name}`)).toEqual(["TRIGGER:payments_ledger"]);
    expect(result.failures[0]!.error).toMatch(/Lock wait timeout/);
    expect(result.warnings.join(" ")).toContain("payments_ledger");
    expect(await managedSchemas()).toEqual([]);
  }, 60_000);

  test("one code object that cannot be re-created fails alone and leaves no stand-in views", async () => {
    await rootQuery("CREATE DATABASE IF NOT EXISTS zz_swap_reports");
    await rootQuery("CREATE TABLE IF NOT EXISTS zz_swap_reports.rates (id INT PRIMARY KEY, r INT)");
    const db = await makeLive();
    await rootQuery(`CREATE VIEW \`${db.schema}\`.a_rates AS SELECT * FROM zz_swap_reports.rates`);
    await rootQuery(`CREATE VIEW \`${db.schema}\`.b_orders AS SELECT id, amount FROM \`${db.schema}\`.payments`);
    const { staging, code } = await snapshot(db);
    const expected = await codeOf(db.schema);
    await rootQuery("DROP TABLE zz_swap_reports.rates");
    await rootQuery(`DROP VIEW \`${db.schema}\`.a_rates`);
    const result = await swapStagingIntoLive({ live: db.schema, staging, code });
    expect(result.outcome).toBe("done-with-errors");
    expect(result.failures.map((f) => `${f.kind}:${f.name}`)).toEqual(["VIEW:a_rates"]);
    const after = await codeOf(db.schema);
    const { ["view:a_rates"]: _gone, ...rest } = expected;
    void _gone;
    expect(after).toEqual(rest);
    expect(await rootQuery(`SELECT id, amount FROM \`${db.schema}\`.b_orders`)).toEqual([{ id: 1, amount: 100 }]);
    await rootQuery("DROP DATABASE zz_swap_reports");
  }, 60_000);

  test("code objects are re-created for the database's own account, never for another one the records name", async () => {
    const db = await makeLive();
    const { staging, code } = await snapshot(db);
    const hostile = code.map((r) =>
      r.kind === "PROCEDURE" ? { ...r, definer: { user: env.rootUser, host: "localhost" }, createSql: r.createSql.replace(/DEFINER=`[^`]*`@`[^`]*`/, `DEFINER=\`${env.rootUser}\`@\`localhost\``) } : r,
    );
    const forged: CodeRecord = {
      kind: "PROCEDURE",
      name: "p_forged",
      definer: { user: env.rootUser, host: "localhost" },
      createSql: `CREATE /*!50000 DEFINER=\`${env.rootUser}\`@\`localhost\` */ PROCEDURE \`p_forged\`() SELECT 1`,
      sqlMode: null,
      characterSetClient: null,
      collation: null,
      timeZone: null,
    };
    const result = await swapStagingIntoLive({
      live: db.schema,
      staging,
      code: [...hostile, forged],
      definers: { account: { user: db.user, host: "%" }, keep: "account" },
    });
    expect(result.failures.map((f) => `${f.kind}:${f.name}`)).toEqual(["PROCEDURE:p_forged"]);
    const definers = await rootQuery<{ d: string }>(
      `SELECT DEFINER AS d FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA = ?
       UNION ALL SELECT DEFINER FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = ?
       UNION ALL SELECT DEFINER FROM information_schema.VIEWS WHERE TABLE_SCHEMA = ?`,
      [db.schema, db.schema, db.schema],
    );
    expect(new Set(definers.map((r) => r.d))).toEqual(new Set([`${db.user}@%`]));
    const leftovers = await rootQuery(`SELECT User FROM mysql.user WHERE User LIKE 'ld\\_scp\\_%'`);
    expect(leftovers).toEqual([]);
  }, 60_000);

  test("shutdown waits for a running swap, and no new swap starts while stopping", async () => {
    const db = await makeLive();
    const { staging, code } = await snapshot(db);
    let renamedAt = 0;
    const swap = swapStagingIntoLive({
      live: db.schema,
      staging,
      code,
      onPhase: async (phase) => {
        if (phase === "renamed") {
          renamedAt = Date.now();
          await Bun.sleep(1500);
        }
      },
    });
    while (renamedAt === 0) await Bun.sleep(20);
    const unfinished = await holdSwapsForShutdown(20_000);
    expect(unfinished).toBe(0);
    expect(Date.now() - renamedAt).toBeGreaterThanOrEqual(1400);
    expect((await swap).outcome).toBe("done");
    const second = await createStagingSchema(db.schema);
    await expect(swapStagingIntoLive({ live: db.schema, staging: second })).rejects.toBeInstanceOf(SwapRefusedError);
    releaseSwapHold();
    expect(await managedSchemas()).toEqual([]);
  }, 60_000);
});
