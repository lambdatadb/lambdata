import { createTestDatabase, mariadbAvailable, rootQuery, startTestInstance, type TestInstance } from "../harness/instance";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import mysql from "mysql2/promise";
import { env } from "../../src/env";
import { captureCodeRecords, type CodeRecord } from "../../src/mariadb/codeObjects";
import { localAdminTarget, runSql } from "../../src/mariadb/process";
import {
  STAGING_PREFIX,
  SwapBlockedError,
  TRASH_PREFIX,
  cleanupOrphanSchemas,
  createStagingSchema,
  dropSchemaIfExists,
  stagingSchemaName,
  swapStagingIntoLive,
} from "../../src/mariadb/schemaSwap";

type Row = Record<string, unknown>;

async function run(...statements: string[]): Promise<void> {
  for (const s of statements) await rootQuery(s);
}

async function schemaExists(name: string): Promise<boolean> {
  const rows = await rootQuery<Row>(`SELECT 1 FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = ?`, [name]);
  return rows.length > 0;
}

async function managedSchemas(): Promise<string[]> {
  const rows = await rootQuery<{ name: string }>(`SELECT SCHEMA_NAME AS name FROM information_schema.SCHEMATA`);
  return rows.map((r) => r.name).filter((n) => n.startsWith(STAGING_PREFIX) || n.startsWith(TRASH_PREFIX));
}

async function codeObjects(schema: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const r of await rootQuery<Row>(`SELECT TRIGGER_NAME AS n FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = ?`, [schema])) {
    const [row] = await rootQuery<Row>(`SHOW CREATE TRIGGER \`${schema}\`.\`${r.n}\``);
    out[`trigger:${r.n}`] = `${row!.sql_mode}|${row!["SQL Original Statement"]}`;
  }
  for (const r of await rootQuery<Row>(`SELECT TABLE_NAME AS n FROM information_schema.VIEWS WHERE TABLE_SCHEMA = ?`, [schema])) {
    const [row] = await rootQuery<Row>(`SHOW CREATE VIEW \`${schema}\`.\`${r.n}\``);
    out[`view:${r.n}`] = String(row!["Create View"]);
  }
  for (const r of await rootQuery<Row>(
    `SELECT ROUTINE_NAME AS n, ROUTINE_TYPE AS t FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA = ?`,
    [schema],
  )) {
    const [row] = await rootQuery<Row>(`SHOW CREATE ${r.t} \`${schema}\`.\`${r.n}\``);
    out[`${String(r.t).toLowerCase()}:${r.n}`] = `${row!.sql_mode}|${row![r.t === "PROCEDURE" ? "Create Procedure" : "Create Function"]}`;
  }
  for (const r of await rootQuery<Row>(`SELECT EVENT_NAME AS n FROM information_schema.EVENTS WHERE EVENT_SCHEMA = ?`, [schema])) {
    const [row] = await rootQuery<Row>(`SHOW CREATE EVENT \`${schema}\`.\`${r.n}\``);
    out[`event:${r.n}`] = `${row!.sql_mode}|${row!.time_zone}|${row!["Create Event"]}`;
  }
  return out;
}

async function checksums(schema: string, tables: string[]): Promise<Row[]> {
  return rootQuery<Row>(`CHECKSUM TABLE ${tables.map((t) => `\`${schema}\`.\`${t}\``).join(", ")} EXTENDED`);
}

async function addLiveCode(schema: string): Promise<void> {
  await run(
    `CREATE TRIGGER \`${schema}\`.t1_old BEFORE INSERT ON \`${schema}\`.t1 FOR EACH ROW SET NEW.note = CONCAT('old:', NEW.note)`,
    `CREATE VIEW \`${schema}\`.v_old AS SELECT id, note FROM \`${schema}\`.t1`,
    `CREATE PROCEDURE \`${schema}\`.p_old() SELECT COUNT(*) AS n FROM t1`,
    `CREATE FUNCTION \`${schema}\`.f_old(x INT) RETURNS INT DETERMINISTIC RETURN x + 1`,
    `CREATE EVENT \`${schema}\`.ev_old ON SCHEDULE EVERY 1 DAY DISABLE DO DELETE FROM t1 WHERE id < 0`,
  );
}

async function liveWithRows(): Promise<{ schema: string; user: string; password: string }> {
  const db = await createTestDatabase();
  await run(
    `CREATE TABLE \`${db.schema}\`.t1 (id INT PRIMARY KEY, note VARCHAR(64)) ENGINE=InnoDB`,
    `CREATE TABLE \`${db.schema}\`.t2 (id INT PRIMARY KEY, payload TEXT) ENGINE=InnoDB`,
    `INSERT INTO \`${db.schema}\`.t1 VALUES (1, 'old-1'), (2, 'old-2')`,
    `INSERT INTO \`${db.schema}\`.t2 VALUES (1, 'old-payload')`,
  );
  return db;
}

async function stagingWithRows(live: string): Promise<string> {
  const staging = await createStagingSchema(live);
  await run(
    `CREATE TABLE \`${staging}\`.t1 (id INT PRIMARY KEY, note VARCHAR(64)) ENGINE=InnoDB`,
    `CREATE TABLE \`${staging}\`.t3 (id INT PRIMARY KEY) ENGINE=InnoDB`,
    `INSERT INTO \`${staging}\`.t1 VALUES (10, 'new-10'), (11, 'new-11'), (12, 'new-12')`,
    `INSERT INTO \`${staging}\`.t3 VALUES (1)`,
  );
  return staging;
}

async function recordsFrom(tableDdl: string, sql: string): Promise<CodeRecord[]> {
  const scratch = await createTestDatabase();
  const admin = await localAdminTarget();
  await runSql(admin, scratch.schema, `${tableDdl};\n${sql}`);
  return captureCodeRecords(admin, scratch.schema);
}

async function userConnection(db: { schema: string; user: string; password: string }) {
  return mysql.createConnection({
    host: "127.0.0.1",
    port: env.mariadbPort,
    user: db.user,
    password: db.password,
    database: db.schema,
  });
}

describe.skipIf(!mariadbAvailable())("schema swap", () => {
  let instance: TestInstance | null = null;

  beforeAll(async () => {
    instance = await startTestInstance();
  }, 120_000);

  afterAll(async () => {
    await instance?.stop();
  }, 60_000);

  test("staging names are unique, prefixed and at most 64 characters", () => {
    const long = "a".repeat(64);
    const names = new Set<string>();
    for (let i = 0; i < 200; i++) names.add(stagingSchemaName(long));
    expect(names.size).toBe(200);
    for (const n of names) {
      expect(n.startsWith(STAGING_PREFIX)).toBe(true);
      expect(n.length).toBeLessThanOrEqual(64);
      expect(n).toMatch(/^[a-z0-9_]+$/);
    }
    expect(stagingSchemaName("shop").endsWith("_shop")).toBe(true);
    for (const bad of ["bad`name", "mysql", "information_schema", `${STAGING_PREFIX}x`, `${TRASH_PREFIX}x`, "", "a".repeat(65)]) {
      expect(() => stagingSchemaName(bad)).toThrow();
    }
  });

  test("swaps tables with rows and leaves no staging or trash schema behind", async () => {
    const db = await liveWithRows();
    const staging = await stagingWithRows(db.schema);
    const result = await swapStagingIntoLive({ live: db.schema, staging });
    expect(result.warnings).toEqual([]);
    const tables = await rootQuery<{ n: string }>(
      `SELECT TABLE_NAME AS n FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME`,
      [db.schema],
    );
    expect(tables.map((t) => t.n)).toEqual(["t1", "t3"]);
    const rows = await rootQuery<Row>(`SELECT id, note FROM \`${db.schema}\`.t1 ORDER BY id`);
    expect(rows).toEqual([
      { id: 10, note: "new-10" },
      { id: 11, note: "new-11" },
      { id: 12, note: "new-12" },
    ]);
    expect(await schemaExists(staging)).toBe(false);
    expect(await managedSchemas()).toEqual([]);
  });

  test("foreign keys follow the rename into live and are still enforced", async () => {
    const db = await createTestDatabase();
    await run(
      `CREATE TABLE \`${db.schema}\`.parent (id INT PRIMARY KEY) ENGINE=InnoDB`,
      `CREATE TABLE \`${db.schema}\`.child (id INT PRIMARY KEY, pid INT, CONSTRAINT fk_child FOREIGN KEY (pid) REFERENCES \`${db.schema}\`.parent (id)) ENGINE=InnoDB`,
      `INSERT INTO \`${db.schema}\`.parent VALUES (1)`,
      `INSERT INTO \`${db.schema}\`.child VALUES (1, 1)`,
    );
    const staging = await createStagingSchema(db.schema);
    await run(
      `CREATE TABLE \`${staging}\`.parent (id INT PRIMARY KEY) ENGINE=InnoDB`,
      `CREATE TABLE \`${staging}\`.child (id INT PRIMARY KEY, pid INT, CONSTRAINT fk_child FOREIGN KEY (pid) REFERENCES \`${staging}\`.parent (id)) ENGINE=InnoDB`,
      `CREATE TABLE \`${staging}\`.selfref (id INT PRIMARY KEY, up INT, FOREIGN KEY (up) REFERENCES \`${staging}\`.selfref (id)) ENGINE=InnoDB`,
      `INSERT INTO \`${staging}\`.parent VALUES (1), (2)`,
      `INSERT INTO \`${staging}\`.child VALUES (1, 1), (2, 2)`,
    );
    await swapStagingIntoLive({ live: db.schema, staging });

    const refs = await rootQuery<Row>(
      `SELECT CONSTRAINT_SCHEMA AS s, TABLE_NAME AS t, UNIQUE_CONSTRAINT_SCHEMA AS rs, REFERENCED_TABLE_NAME AS rt
         FROM information_schema.REFERENTIAL_CONSTRAINTS WHERE CONSTRAINT_SCHEMA = ? OR UNIQUE_CONSTRAINT_SCHEMA = ?
        ORDER BY TABLE_NAME`,
      [db.schema, db.schema],
    );
    expect(refs).toEqual([
      { s: db.schema, t: "child", rs: db.schema, rt: "parent" },
      { s: db.schema, t: "selfref", rs: db.schema, rt: "selfref" },
    ]);

    let violation: unknown = null;
    await rootQuery(`INSERT INTO \`${db.schema}\`.child VALUES (9, 99)`).catch((err) => {
      violation = err;
    });
    expect((violation as { errno?: number } | null)?.errno).toBe(1452);
    let selfViolation: unknown = null;
    await rootQuery(`INSERT INTO \`${db.schema}\`.selfref VALUES (1, 5)`).catch((err) => {
      selfViolation = err;
    });
    expect((selfViolation as { errno?: number } | null)?.errno).toBe(1452);
    let parentDelete: unknown = null;
    await rootQuery(`DELETE FROM \`${db.schema}\`.parent WHERE id = 2`).catch((err) => {
      parentDelete = err;
    });
    expect((parentDelete as { errno?: number } | null)?.errno).toBe(1451);
    await rootQuery(`INSERT INTO \`${db.schema}\`.child VALUES (3, 2)`);
    expect(await managedSchemas()).toEqual([]);
  });

  test("replaces live triggers, views, routines and events with code records", async () => {
    const db = await liveWithRows();
    await addLiveCode(db.schema);
    const staging = await stagingWithRows(db.schema);
    const code = await recordsFrom(
      "CREATE TABLE t1 (id INT PRIMARY KEY, note VARCHAR(64))",
      [
        "CREATE TRIGGER t1_new BEFORE INSERT ON t1 FOR EACH ROW SET NEW.note = CONCAT('new:', NEW.note);",
        "CREATE VIEW v_new AS SELECT id FROM t1;",
        "DELIMITER ;;",
        "CREATE PROCEDURE p_new() BEGIN SELECT COUNT(*) AS n FROM t1; END ;;",
        "DELIMITER ;",
        "CREATE EVENT ev_new ON SCHEDULE EVERY 1 DAY DISABLE DO DELETE FROM t1 WHERE id < 0;",
      ].join("\n"),
    );
    const result = await swapStagingIntoLive({ live: db.schema, staging, code, definers: { account: { user: db.user, host: "%" }, keep: "account" } });
    expect(result.warnings).toEqual([]);
    expect(result.outcome).toBe("done");
    expect(Object.keys(await codeObjects(db.schema)).sort()).toEqual([
      "event:ev_new",
      "procedure:p_new",
      "trigger:t1_new",
      "view:v_new",
    ]);
    await rootQuery(`INSERT INTO \`${db.schema}\`.t1 VALUES (20, 'x')`);
    const [row] = await rootQuery<Row>(`SELECT note FROM \`${db.schema}\`.t1 WHERE id = 20`);
    expect(row).toEqual({ note: "new:x" });
    const viewRows = await rootQuery<Row>(`SELECT COUNT(*) AS n FROM \`${db.schema}\`.v_new`);
    expect(Number(viewRows[0]!.n)).toBe(4);
  });

  test("a code record that fails is reported alone and the swap is kept", async () => {
    const db = await liveWithRows();
    await addLiveCode(db.schema);
    const staging = await stagingWithRows(db.schema);
    const code = await recordsFrom(
      "CREATE TABLE t1 (id INT PRIMARY KEY, note VARCHAR(64), no_such_column INT)",
      "CREATE VIEW v_ok AS SELECT id FROM t1;\nCREATE VIEW v_bad AS SELECT no_such_column FROM t1;\n",
    );
    const result = await swapStagingIntoLive({
      live: db.schema,
      staging,
      code,
      definers: { account: { user: db.user, host: "%" }, keep: "account" },
    });
    expect(result.outcome).toBe("done-with-errors");
    expect(result.warnings.length).toBe(1);
    expect(result.warnings[0]).toContain("no_such_column");
    expect(result.warnings[0]).not.toContain(await (await import("../../src/mariadb/controller")).getRootPassword());
    const rows = await rootQuery<Row>(`SELECT COUNT(*) AS n FROM \`${db.schema}\`.t3`);
    expect(Number(rows[0]!.n)).toBe(1);
    expect(Object.keys(await codeObjects(db.schema))).toEqual(["view:v_ok"]);
    expect(await managedSchemas()).toEqual([]);
  });

  test("a swap blocked by an open transaction changes nothing, not even its code objects, and names the blocker", async () => {
    const db = await liveWithRows();
    await addLiveCode(db.schema);
    const staging = await stagingWithRows(db.schema);
    const beforeSums = await checksums(db.schema, ["t1", "t2"]);
    const beforeCode = await codeObjects(db.schema);
    expect(Object.keys(beforeCode).length).toBe(5);
    const triggerCreated = async () =>
      String((await rootQuery<Row>(`SHOW CREATE TRIGGER \`${db.schema}\`.t1_old`))[0]!.Created);
    const createdBefore = await triggerCreated();
    await Bun.sleep(50);

    const holder = await mysql.createConnection({
      host: "127.0.0.1",
      port: env.mariadbPort,
      user: db.user,
      password: db.password,
      database: db.schema,
    });
    try {
      await holder.query("START TRANSACTION");
      await holder.query("SELECT * FROM t2");
      let failure: unknown = null;
      await swapStagingIntoLive({ live: db.schema, staging, lockWaitTimeoutSec: 1 }).catch((err) => {
        failure = err;
      });
      expect(failure).toBeInstanceOf(SwapBlockedError);
      expect((failure as SwapBlockedError).errno).toBe(1205);
      expect((failure as SwapBlockedError).blockers.map((b) => b.id)).toContain(holder.threadId!);
      expect((failure as Error).message).toContain(`session ${holder.threadId}`);
      expect((failure as Error).message).toContain("nothing was changed");
    } finally {
      await holder.query("ROLLBACK").catch(() => {});
      await holder.end();
    }

    expect(await checksums(db.schema, ["t1", "t2"])).toEqual(beforeSums);
    expect(await codeObjects(db.schema)).toEqual(beforeCode);
    expect(await triggerCreated()).toBe(createdBefore);
    const tables = await rootQuery<{ n: string }>(
      `SELECT TABLE_NAME AS n FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_TYPE = 'BASE TABLE' ORDER BY TABLE_NAME`,
      [db.schema],
    );
    expect(tables.map((t) => t.n)).toEqual(["t1", "t2"]);
    expect(await schemaExists(staging)).toBe(false);
    expect(await managedSchemas()).toEqual([]);
    await rootQuery(`INSERT INTO \`${db.schema}\`.t1 VALUES (30, 'y')`);
    const [row] = await rootQuery<Row>(`SELECT note FROM \`${db.schema}\`.t1 WHERE id = 30`);
    expect(row).toEqual({ note: "old:y" });
  });

  test("the database user can still read and write after a swap", async () => {
    const db = await liveWithRows();
    const staging = await stagingWithRows(db.schema);
    const before = await userConnection(db);
    await before.query("SELECT COUNT(*) FROM t1");
    await swapStagingIntoLive({ live: db.schema, staging });
    const [rows] = await before.query("SELECT id FROM t3");
    expect(rows as unknown).toEqual([{ id: 1 }]);
    await before.end();
    const conn = await userConnection(db);
    try {
      await conn.query("INSERT INTO t1 VALUES (40, 'by-user')");
      await conn.query("UPDATE t3 SET id = 2 WHERE id = 1");
      await conn.query("CREATE TABLE t4 (id INT)");
      const [count] = await conn.query("SELECT COUNT(*) AS n FROM t1");
      expect(Number((count as Row[])[0]!.n)).toBe(4);
    } finally {
      await conn.end();
    }
  });

  test("rejects a staging schema with views or triggers and leaves live untouched", async () => {
    const db = await liveWithRows();
    await addLiveCode(db.schema);
    const beforeCode = await codeObjects(db.schema);
    const beforeSums = await checksums(db.schema, ["t1", "t2"]);

    const withView = await stagingWithRows(db.schema);
    await run(`CREATE VIEW \`${withView}\`.v AS SELECT id FROM \`${withView}\`.t1`);
    await expect(swapStagingIntoLive({ live: db.schema, staging: withView })).rejects.toThrow(/base tables only/);
    expect(await schemaExists(withView)).toBe(false);

    const withTrigger = await stagingWithRows(db.schema);
    await run(`CREATE TRIGGER \`${withTrigger}\`.tr BEFORE INSERT ON \`${withTrigger}\`.t1 FOR EACH ROW SET NEW.id = NEW.id`);
    await expect(swapStagingIntoLive({ live: db.schema, staging: withTrigger })).rejects.toThrow(/trigger/);
    expect(await schemaExists(withTrigger)).toBe(false);

    expect(await codeObjects(db.schema)).toEqual(beforeCode);
    expect(await checksums(db.schema, ["t1", "t2"])).toEqual(beforeSums);
    expect(await managedSchemas()).toEqual([]);
  });

  test("rejects a live schema that other schemas reference through foreign keys", async () => {
    const db = await liveWithRows();
    const other = await createTestDatabase();
    await run(
      `CREATE TABLE \`${other.schema}\`.ref (id INT PRIMARY KEY, t1_id INT, FOREIGN KEY (t1_id) REFERENCES \`${db.schema}\`.t1 (id)) ENGINE=InnoDB`,
    );
    const staging = await stagingWithRows(db.schema);
    await expect(swapStagingIntoLive({ live: db.schema, staging })).rejects.toThrow(/foreign keys/);
    const tables = await rootQuery<{ n: string }>(
      `SELECT TABLE_NAME AS n FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME`,
      [db.schema],
    );
    expect(tables.map((t) => t.n)).toEqual(["t1", "t2"]);
    expect(await managedSchemas()).toEqual([]);
  });

  test("cleanupOrphanSchemas drops only prefixed schemas that are not in use", async () => {
    const orphanStage = `${STAGING_PREFIX}orphan01_shop`;
    const orphanTrash = `${TRASH_PREFIX}orphan02_shop`;
    const lookalikes = ["ld_stage_lookalike", "_ld_other", "x_ld_stage_y", "ld_trash_shop"];
    for (const s of [orphanStage, orphanTrash, ...lookalikes]) await run(`CREATE DATABASE \`${s}\``);
    await run(`CREATE TABLE \`${orphanTrash}\`.t (id INT)`);
    const inUse = await createStagingSchema("shop");
    try {
      const dropped = await cleanupOrphanSchemas();
      expect(dropped.sort()).toEqual([orphanStage, orphanTrash].sort());
      for (const s of lookalikes) expect(await schemaExists(s)).toBe(true);
      expect(await schemaExists(inUse)).toBe(true);
    } finally {
      await dropSchemaIfExists(inUse);
      for (const s of lookalikes) await run(`DROP DATABASE IF EXISTS \`${s}\``);
    }
    expect(await managedSchemas()).toEqual([]);
  });

  test("dropSchemaIfExists refuses anything that is not a staging or trash schema", async () => {
    const db = await createTestDatabase();
    await expect(dropSchemaIfExists(db.schema)).rejects.toThrow(/not a staging or trash schema/);
    await expect(dropSchemaIfExists("mysql")).rejects.toThrow();
    await expect(dropSchemaIfExists("`x`")).rejects.toThrow();
    expect(await schemaExists(db.schema)).toBe(true);
    await dropSchemaIfExists(`${STAGING_PREFIX}never_created`);
  });
});
