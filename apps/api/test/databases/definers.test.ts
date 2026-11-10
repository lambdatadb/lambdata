import { mariadbAvailable, rootQuery, startTestInstance, type TestInstance } from "../harness/instance";
import { seedUser } from "../harness/sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import mysql from "mysql2/promise";
import { env } from "../../src/env";
import { repairMissingDefiners } from "../../src/databases/definers";
import { provisionDatabase } from "../../src/databases/provision";

describe.skipIf(!mariadbAvailable())("startup repair of code objects whose definer is gone", () => {
  let instance: TestInstance | null = null;

  beforeAll(async () => {
    instance = await startTestInstance();
  }, 120_000);

  afterAll(async () => {
    await instance?.stop();
  }, 60_000);

  test("objects defined by an account that does not exist move onto the database's own user, once", async () => {
    const owner = seedUser("admin");
    const { database, credentials } = await provisionDatabase({ displayName: `Mirror ${Date.now() % 100000}`, ownerUserId: owner.id });
    const s = database.name;
    await rootQuery(`CREATE TABLE \`${s}\`.t (id INT PRIMARY KEY)`);
    await rootQuery(`CREATE TABLE \`${s}\`.log (id INT)`);
    await rootQuery(`CREATE DEFINER='source_app'@'%' VIEW \`${s}\`.v AS SELECT id FROM \`${s}\`.t`);
    await rootQuery(`CREATE DEFINER='source_app'@'%' TRIGGER \`${s}\`.tr AFTER INSERT ON \`${s}\`.t FOR EACH ROW INSERT INTO \`${s}\`.log VALUES (NEW.id)`);
    await rootQuery(`CREATE DEFINER='source_app'@'%' PROCEDURE \`${s}\`.p()\nBEGIN\n  -- keep me\n  SELECT COUNT(*) AS n FROM t;\nEND`);
    await rootQuery(`CREATE PROCEDURE \`${s}\`.p_kept() SELECT 1`);
    const app = await mysql.createConnection({
      host: "127.0.0.1",
      port: env.mariadbPort,
      user: credentials.user,
      password: credentials.password,
      database: s,
    });
    try {
      await expect(app.query("SELECT * FROM v")).rejects.toThrow();
      const first = await repairMissingDefiners();
      expect(first.warnings.filter((w) => w.startsWith(`${s}:`))).toEqual([]);
      expect(first.moved).toBeGreaterThanOrEqual(3);
      expect(first.databases).toContain(s);
      await app.query("INSERT INTO t VALUES (1)");
      expect((await app.query("SELECT id FROM v"))[0] as unknown).toEqual([{ id: 1 }]);
      expect((await app.query("SELECT id FROM log"))[0] as unknown).toEqual([{ id: 1 }]);
      const definers = await rootQuery<{ k: string; d: string }>(
        `SELECT CONCAT('view:', TABLE_NAME) AS k, DEFINER AS d FROM information_schema.VIEWS WHERE TABLE_SCHEMA = ?
         UNION ALL SELECT CONCAT('trigger:', TRIGGER_NAME), DEFINER FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = ?
         UNION ALL SELECT CONCAT('routine:', ROUTINE_NAME), DEFINER FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA = ?
         ORDER BY k`,
        [s, s, s],
      );
      expect(definers).toEqual([
        { k: "routine:p", d: `${credentials.user}@%` },
        { k: "routine:p_kept", d: `${env.rootUser}@127.0.0.1` },
        { k: "trigger:tr", d: `${credentials.user}@%` },
        { k: "view:v", d: `${credentials.user}@%` },
      ]);
      const [proc] = await rootQuery<Record<string, string>>(`SHOW CREATE PROCEDURE \`${s}\`.p`);
      expect(proc!["Create Procedure"]).toContain("-- keep me");
      const second = await repairMissingDefiners();
      expect(second.databases).not.toContain(s);
    } finally {
      await app.end();
    }
  }, 60_000);

  test("a mirror's objects defined by an account that exists but is not the mirror's own move to the mirror's account; a standard database keeps them", async () => {
    const owner = seedUser("admin");
    const source = await provisionDatabase({ displayName: `Primary ${Date.now() % 100000}`, ownerUserId: owner.id });
    const mirror = await provisionDatabase({ displayName: `Primary Mirror ${Date.now() % 100000}`, ownerUserId: owner.id, kind: "mirror" });
    const plain = await provisionDatabase({ displayName: `Plain ${Date.now() % 100000}`, ownerUserId: owner.id });
    const m = mirror.database.name;
    const sourceUser = source.credentials.user;
    await rootQuery(`CREATE TABLE \`${m}\`.players (id INT PRIMARY KEY, score INT)`);
    await rootQuery(`CREATE TABLE \`${m}\`.audit (id INT)`);
    await rootQuery(`CREATE DEFINER=?@'%' VIEW \`${m}\`.v_board AS SELECT id, score FROM \`${m}\`.players`, [sourceUser]);
    await rootQuery(`CREATE DEFINER=?@'%' PROCEDURE \`${m}\`.sp_summary() SELECT COUNT(*) AS n FROM players`, [sourceUser]);
    await rootQuery(
      `CREATE DEFINER=?@'%' TRIGGER \`${m}\`.trg_audit AFTER UPDATE ON \`${m}\`.players FOR EACH ROW INSERT INTO \`${m}\`.audit VALUES (NEW.id)`,
      [sourceUser],
    );
    await rootQuery(`CREATE TABLE \`${plain.database.name}\`.t (id INT)`);
    await rootQuery(`CREATE DEFINER=?@'%' VIEW \`${plain.database.name}\`.v AS SELECT id FROM \`${plain.database.name}\`.t`, [sourceUser]);
    const app = await mysql.createConnection({
      host: "127.0.0.1",
      port: env.mariadbPort,
      user: mirror.credentials.user,
      password: mirror.credentials.password,
      database: m,
    });
    try {
      await app.query("INSERT INTO players VALUES (1, 10)");
      await expect(app.query("SELECT * FROM v_board")).rejects.toThrow();
      await expect(app.query("UPDATE players SET score = 11")).rejects.toThrow();
      const report = await repairMissingDefiners();
      expect(report.databases).toContain(m);
      expect(report.databases).not.toContain(plain.database.name);
      expect((await app.query("SELECT id, score FROM v_board"))[0] as unknown).toEqual([{ id: 1, score: 10 }]);
      await app.query("CALL sp_summary()");
      await app.query("UPDATE players SET score = 11");
      expect((await app.query("SELECT id FROM audit"))[0] as unknown).toEqual([{ id: 1 }]);
      const definers = await rootQuery<{ d: string }>(
        `SELECT DEFINER AS d FROM information_schema.VIEWS WHERE TABLE_SCHEMA = ?
         UNION ALL SELECT DEFINER FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA = ?
         UNION ALL SELECT DEFINER FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = ?`,
        [m, m, m],
      );
      expect(new Set(definers.map((r) => r.d))).toEqual(new Set([`${mirror.credentials.user}@%`]));
      const [kept] = await rootQuery<{ d: string }>("SELECT DEFINER AS d FROM information_schema.VIEWS WHERE TABLE_SCHEMA = ?", [plain.database.name]);
      expect(kept!.d).toBe(`${sourceUser}@%`);
      expect((await repairMissingDefiners()).databases).not.toContain(m);
    } finally {
      await app.end();
    }
  }, 60_000);
});
