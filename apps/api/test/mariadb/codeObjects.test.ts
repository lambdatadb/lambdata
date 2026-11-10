import { createTestDatabase, mariadbAvailable, rootQuery, startTestInstance, type TestInstance } from "../harness/instance";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import mysql from "mysql2/promise";
import { env } from "../../src/env";
import {
  applyCodeRecords,
  captureCodeRecords,
  parseRenderedCode,
  renderCodeRecords,
  type CodeRecord,
} from "../../src/mariadb/codeObjects";
import { updateAllowedHost } from "../../src/mariadb/manager";
import { localAdminTarget, runSql, type Target } from "../../src/mariadb/process";

type Row = Record<string, unknown>;

function sha256(text: string): string {
  return new Bun.CryptoHasher("sha256").update(text).digest("hex");
}

async function definitions(schema: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const r of await rootQuery<Row>(`SELECT TABLE_NAME AS n FROM information_schema.VIEWS WHERE TABLE_SCHEMA = ?`, [schema])) {
    out[`view:${r.n}`] = String((await rootQuery<Row>(`SHOW CREATE VIEW \`${schema}\`.\`${r.n}\``))[0]!["Create View"]);
  }
  for (const r of await rootQuery<Row>(
    `SELECT ROUTINE_NAME AS n, ROUTINE_TYPE AS t FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA = ?`,
    [schema],
  )) {
    const row = (await rootQuery<Row>(`SHOW CREATE ${r.t} \`${schema}\`.\`${r.n}\``))[0]!;
    out[`${String(r.t).toLowerCase()}:${r.n}`] = String(row[r.t === "PROCEDURE" ? "Create Procedure" : "Create Function"]);
  }
  for (const r of await rootQuery<Row>(
    `SELECT TRIGGER_NAME AS n, EVENT_OBJECT_TABLE AS t, ACTION_TIMING AS ti, EVENT_MANIPULATION AS ev, ACTION_ORDER AS o,
            SQL_MODE AS m, DEFINER AS d, ACTION_STATEMENT AS s
       FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = ?`,
    [schema],
  )) {
    out[`trigger:${r.n}`] = JSON.stringify([r.t, r.ti, r.ev, r.o, r.m, r.d, r.s]);
  }
  for (const r of await rootQuery<Row>(`SELECT EVENT_NAME AS n FROM information_schema.EVENTS WHERE EVENT_SCHEMA = ?`, [schema])) {
    out[`event:${r.n}`] = String((await rootQuery<Row>(`SHOW CREATE EVENT \`${schema}\`.\`${r.n}\``))[0]!["Create Event"]);
  }
  return out;
}

async function definers(schema: string): Promise<string[]> {
  const rows = await rootQuery<{ d: string }>(
    `SELECT CONCAT(kind, ':', name, '=', definer) AS d FROM (
       SELECT 'view' AS kind, TABLE_NAME AS name, DEFINER AS definer FROM information_schema.VIEWS WHERE TABLE_SCHEMA = ?
       UNION ALL SELECT LOWER(ROUTINE_TYPE), ROUTINE_NAME, DEFINER FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA = ?
       UNION ALL SELECT 'trigger', TRIGGER_NAME, DEFINER FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = ?
       UNION ALL SELECT 'event', EVENT_NAME, DEFINER FROM information_schema.EVENTS WHERE EVENT_SCHEMA = ?
     ) o ORDER BY d`,
    [schema, schema, schema, schema],
  );
  return rows.map((r) => r.d);
}

const FIXTURE_CODE = [
  "CREATE TABLE t (id INT PRIMARY KEY, a INT, note VARCHAR(32));",
  "CREATE TABLE log (msg VARCHAR(64));",
  "CREATE FUNCTION twice(x INT) RETURNS INT DETERMINISTIC RETURN x * 2;",
  "CREATE VIEW v1 AS SELECT id, twice(a) AS b FROM t;",
  "CREATE VIEW v2 AS SELECT id, b FROM v1 WHERE b > 0;",
  "DELIMITER ;;",
  "CREATE TRIGGER t_bi BEFORE INSERT ON t FOR EACH ROW BEGIN SET NEW.note = CONCAT('n:', NEW.a); INSERT INTO log VALUES (CONCAT('ins ', NEW.id)); END;;",
  "CREATE PROCEDURE total(OUT n INT) BEGIN SELECT COUNT(*) INTO n FROM t; SELECT 1; END;;",
  "CREATE EVENT nightly ON SCHEDULE EVERY 1 DAY STARTS '2031-01-01 00:00:00' DISABLE DO BEGIN DELETE FROM log; END;;",
  "DELIMITER ;",
].join("\n");

async function fixture(): Promise<{ schema: string; user: string; password: string }> {
  const db = await createTestDatabase();
  await runSql(await localAdminTarget(), db.schema, FIXTURE_CODE);
  await rootQuery(`INSERT INTO \`${db.schema}\`.t (id, a) VALUES (1, 5), (2, -1)`);
  return db;
}

async function behaviour(schema: string): Promise<unknown> {
  const conn = await mysql.createConnection({
    host: "127.0.0.1",
    port: env.mariadbPort,
    user: env.rootUser,
    password: (await localAdminTarget()).password,
    database: schema,
  });
  try {
    await conn.query("DELETE FROM log");
    await conn.query("INSERT INTO t (id, a) VALUES (100, 7)");
    const [inserted] = await conn.query("SELECT note FROM t WHERE id = 100");
    const [logged] = await conn.query("SELECT msg FROM log");
    const [v2] = await conn.query("SELECT id, b FROM v2 ORDER BY id");
    await conn.query("CALL total(@n)");
    const [total] = await conn.query("SELECT @n AS n");
    await conn.query("DELETE FROM t WHERE id = 100");
    return { inserted, logged, v2, total };
  } finally {
    await conn.end();
  }
}

describe.skipIf(!mariadbAvailable())("code objects", () => {
  let instance: TestInstance | null = null;
  let admin: Target;
  const dumpCodeObjects = async (target: Target, schema: string) => renderCodeRecords(await captureCodeRecords(target, schema));

  beforeAll(async () => {
    instance = await startTestInstance();
    admin = await localAdminTarget();
  }, 120_000);

  afterAll(async () => {
    await instance?.stop();
  }, 60_000);

  test("dumps are deterministic and free of host, version and date headers", async () => {
    const db = await fixture();
    const first = await dumpCodeObjects(admin, db.schema);
    const second = await dumpCodeObjects(admin, db.schema);
    expect(second).toBe(first);
    await rootQuery(`INSERT INTO \`${db.schema}\`.t (id, a) VALUES (3, 9)`);
    await rootQuery(`UPDATE \`${db.schema}\`.t SET a = a + 1`);
    await rootQuery(`ALTER TABLE \`${db.schema}\`.t AUTO_INCREMENT = 500`);
    expect(sha256(await dumpCodeObjects(admin, db.schema))).toBe(sha256(first));
    expect(first).not.toMatch(/MariaDB dump|Host:|Dump completed|Server version|127\.0\.0\.1:/);
    expect(first.split("\n").filter((l) => l.startsWith("--") && !l.startsWith("-- LambData code objects ") && !l.startsWith("-- ld-code "))).toEqual([]);
    expect(first).not.toMatch(/^DROP TABLE/m);
    expect(first).not.toMatch(/CREATE TABLE/);
    for (const name of ["twice", "v1", "v2", "t_bi", "total", "nightly"]) expect(first).toContain(name);
    expect(first.indexOf("FUNCTION `twice`")).toBeLessThan(first.indexOf("VIEW `v1` AS select"));

    await rootQuery(`CREATE VIEW \`${db.schema}\`.v3 AS SELECT 1 AS one`);
    expect(await dumpCodeObjects(admin, db.schema)).not.toBe(first);
  });

  test("a dump replaced into its schema behaves the same", async () => {
    const db = await fixture();
    const beforeDefs = await definitions(db.schema);
    const beforeBehaviour = await behaviour(db.schema);
    const sql = await dumpCodeObjects(admin, db.schema);
    const result = await applyCodeRecords(db.schema, parseRenderedCode(sql)!, { replace: true });
    expect(result.warnings).toEqual([]);
    expect(await definitions(db.schema)).toEqual(beforeDefs);
    expect(await behaviour(db.schema)).toEqual(beforeBehaviour);
    expect(await dumpCodeObjects(admin, db.schema)).toBe(sql);
  });

  test("objects made by a client with another character set keep that character set when re-created", async () => {
    const db = await createTestDatabase();
    const conn = await mysql.createConnection({
      host: "127.0.0.1",
      port: env.mariadbPort,
      user: env.rootUser,
      password: admin.password,
      database: db.schema,
      charset: "latin1_swedish_ci",
    });
    try {
      await conn.query("CREATE TABLE t (id INT PRIMARY KEY, a INT)");
      await conn.query("CREATE TRIGGER t_bi BEFORE INSERT ON t FOR EACH ROW SET NEW.a = NEW.a + 0");
      await conn.query("CREATE VIEW v AS SELECT id FROM t");
      await conn.query("CREATE PROCEDURE p() SELECT 1");
    } finally {
      await conn.end();
    }
    const before = await captureCodeRecords(admin, db.schema);
    expect(before.map((r) => r.characterSetClient)).toEqual(["latin1", "latin1", "latin1"]);
    await rootQuery(`DROP TRIGGER \`${db.schema}\`.t_bi`);
    await rootQuery(`DROP VIEW \`${db.schema}\`.v`);
    await rootQuery(`DROP PROCEDURE \`${db.schema}\`.p`);
    const result = await applyCodeRecords(db.schema, before, { replace: true });
    expect(result.failures).toEqual([]);
    expect(await captureCodeRecords(admin, db.schema)).toEqual(before);
  });

  test("one record that cannot be created fails alone and leaves the others applied", async () => {
    const db = await fixture();
    const records = await captureCodeRecords(admin, db.schema);
    const broken: CodeRecord = {
      ...records.find((r) => r.name === "v2")!,
      name: "v_broken",
      createSql: records.find((r) => r.name === "v2")!.createSql.replace("VIEW `v2`", "VIEW `v_broken`").replace("`b`", "`no_such_column`"),
    };
    const result = await applyCodeRecords(db.schema, [...records, broken], { replace: true });
    expect(result.failures.map((f) => `${f.kind}:${f.name}`)).toEqual(["VIEW:v_broken"]);
    expect(Object.keys(await definitions(db.schema)).sort()).toEqual(
      ["event:nightly", "function:twice", "procedure:total", "trigger:t_bi", "view:v1", "view:v2"].sort(),
    );
    const views = await rootQuery<{ n: string; d: string }>(
      `SELECT TABLE_NAME AS n, VIEW_DEFINITION AS d FROM information_schema.VIEWS WHERE TABLE_SCHEMA = ?`,
      [db.schema],
    );
    for (const v of views) expect(v.d).not.toMatch(/^select 1 AS/);
  });

  test("records keep comments inside stored programs, and render to SQL that loads the same objects", async () => {
    const db = await createTestDatabase();
    await runSql(
      await localAdminTarget(),
      db.schema,
      [
        "CREATE TABLE t (id INT PRIMARY KEY, v INT);",
        "DELIMITER ;;",
        "CREATE PROCEDURE p_doc()\nBEGIN\n  -- recompute the totals nightly\n  SELECT COUNT(*) FROM t; # count rows\n  /* keep in sync */\n  SELECT 1;\nEND;;",
        "CREATE TRIGGER t_doc BEFORE INSERT ON t FOR EACH ROW\nBEGIN\n  -- clamp negative values\n  IF NEW.v < 0 THEN SET NEW.v = 0; END IF;\nEND;;",
        "CREATE EVENT e_doc ON SCHEDULE EVERY 1 DAY STARTS '2030-01-01 00:00:00' DISABLE DO\nBEGIN\n  -- purge old rows\n  DELETE FROM t WHERE v = 0;\nEND;;",
        "DELIMITER ;",
      ].join("\n"),
    );
    const before = await definitions(db.schema);
    expect(before["procedure:p_doc"]).toContain("-- recompute the totals nightly");
    const records = await captureCodeRecords(admin, db.schema);
    await rootQuery(`DROP PROCEDURE \`${db.schema}\`.p_doc`);
    await rootQuery(`DROP TRIGGER \`${db.schema}\`.t_doc`);
    await rootQuery(`DROP EVENT \`${db.schema}\`.e_doc`);
    const applied = await applyCodeRecords(db.schema, records, { replace: true });
    expect(applied.failures).toEqual([]);
    expect(await definitions(db.schema)).toEqual(before);

    const rendered = renderCodeRecords(records);
    expect(parseRenderedCode(rendered)!.map((r) => `${r.kind}:${r.name}`).sort()).toEqual(records.map((r) => `${r.kind}:${r.name}`).sort());
    const copy = await createTestDatabase();
    await rootQuery(`CREATE TABLE \`${copy.schema}\`.t (id INT PRIMARY KEY, v INT)`);
    await runSql(await localAdminTarget(), copy.schema, rendered);
    expect(await definitions(copy.schema)).toEqual(before);
  });

  test("definers with unusual hosts are rewritten in real dump output", async () => {
    const db = await fixture();
    for (const host of ["%", "192.168.%"]) {
      await rootQuery(`CREATE USER IF NOT EXISTS 'odd'@? IDENTIFIED BY 'x'`, [host]);
      await rootQuery(`GRANT ALL ON \`${db.schema}\`.* TO 'odd'@?`, [host]);
    }
    await rootQuery(`CREATE USER IF NOT EXISTS 'ld_new'@'10.%' IDENTIFIED BY 'x'`);
    await rootQuery(`GRANT ALL ON \`${db.schema}\`.* TO 'ld_new'@'10.%'`);
    await rootQuery(`CREATE DEFINER = 'odd'@'192.168.%' VIEW \`${db.schema}\`.odd_v AS SELECT id FROM \`${db.schema}\`.t`);
    await rootQuery(`CREATE DEFINER = 'odd'@'192.168.%' PROCEDURE \`${db.schema}\`.odd_p() SELECT 1`);
    await rootQuery(`CREATE DEFINER = 'odd'@'%' VIEW \`${db.schema}\`.pct_v AS SELECT id FROM \`${db.schema}\`.t`);

    const records = await captureCodeRecords(admin, db.schema);
    const dumped = renderCodeRecords(records);
    expect(dumped).toContain("DEFINER=`odd`@`192.168.%`");
    expect(dumped).toContain("DEFINER=`odd`@`%`");
    const moving = records.filter((r) => r.definer?.user === "odd" && r.definer.host === "192.168.%");
    const result = await applyCodeRecords(db.schema, moving, { definers: { account: { user: "ld_new", host: "10.%" }, keep: "account" } });
    expect(result.failures).toEqual([]);
    const after = await definers(db.schema);
    expect(after).toContain("view:odd_v=ld_new@10.%");
    expect(after).toContain("procedure:odd_p=ld_new@10.%");
    expect(after).toContain("view:pct_v=odd@%");
    expect(await rootQuery(`SELECT COUNT(*) AS n FROM \`${db.schema}\`.odd_v`)).toEqual([{ n: 2 }]);
    for (const host of ["%", "192.168.%"]) await rootQuery(`DROP USER 'odd'@?`, [host]);
    await rootQuery(`DROP USER 'ld_new'@'10.%'`);
  });

  test("changing a database's allowed host keeps its own views, procedures and triggers working", async () => {
    const db = await createTestDatabase();
    const asUser = () =>
      mysql.createConnection({ host: "127.0.0.1", port: env.mariadbPort, user: db.user, password: db.password, database: db.schema });
    const setup = await asUser();
    await setup.query("CREATE TABLE t (id INT PRIMARY KEY, note VARCHAR(32))");
    await setup.query("CREATE TABLE audit (msg VARCHAR(64))");
    await setup.query("CREATE VIEW v AS SELECT id, note FROM t");
    await setup.query("CREATE PROCEDURE p(OUT n INT) SELECT COUNT(*) INTO n FROM t");
    await setup.query("CREATE TRIGGER tr AFTER INSERT ON t FOR EACH ROW INSERT INTO audit VALUES (CONCAT('row ', NEW.id))");
    await setup.end();
    await rootQuery(`CREATE DEFINER = ?@'10.20.%' VIEW \`${db.schema}\`.stale_v AS SELECT COUNT(*) AS n FROM \`${db.schema}\`.t`, [db.user]);
    expect(await definers(db.schema)).toEqual([
      `procedure:p=${db.user}@%`,
      `trigger:tr=${db.user}@%`,
      `view:stale_v=${db.user}@10.20.%`,
      `view:v=${db.user}@%`,
    ]);

    const result = await updateAllowedHost({ user: db.user, oldHost: "%", newHost: "127.0.0.1", password: db.password, schema: db.schema });
    expect(result.warnings).toEqual([]);
    expect(await definers(db.schema)).toEqual([
      `procedure:p=${db.user}@127.0.0.1`,
      `trigger:tr=${db.user}@127.0.0.1`,
      `view:stale_v=${db.user}@127.0.0.1`,
      `view:v=${db.user}@127.0.0.1`,
    ]);

    const conn = await asUser();
    try {
      await conn.query("INSERT INTO t VALUES (1, 'a')");
      const [viewRows] = await conn.query("SELECT id, note FROM v");
      expect(viewRows as unknown).toEqual([{ id: 1, note: "a" }]);
      await conn.query("CALL p(@n)");
      const [n] = await conn.query("SELECT @n AS n");
      expect(n as unknown).toEqual([{ n: 1 }]);
      const [audit] = await conn.query("SELECT msg FROM audit");
      expect(audit as unknown).toEqual([{ msg: "row 1" }]);
      const [stale] = await conn.query("SELECT n FROM stale_v");
      expect(stale as unknown).toEqual([{ n: 1 }]);
    } finally {
      await conn.end();
    }
  });
});
