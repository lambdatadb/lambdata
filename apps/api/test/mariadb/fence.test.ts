import { mariadbAvailable, rootQuery, startTestInstance, type TestInstance } from "../harness/instance";
import { seedUser, type SeededUser } from "../harness/sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { copyFileSync, existsSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import mysql from "mysql2/promise";
import { env } from "../../src/env";
import { provisionDatabase } from "../../src/databases/provision";
import { startJob, waitForJob } from "../../src/jobs";
import { journalDir } from "../../src/mariadb/journal";
import { updateAllowedHost } from "../../src/mariadb/manager";
import { createScopedAccount, dropOrphanScopedAccounts, withScopedAccount } from "../../src/mariadb/scopedAccount";
import { isWriteFenced, liftLeftoverWriteFences, withWriteFence } from "../../src/mariadb/writeFence";

type Row = Record<string, unknown>;

async function ownerLogin(user: string, password: string, schema: string): Promise<mysql.Connection> {
  return mysql.createConnection({ host: "127.0.0.1", port: env.mariadbPort, user, password, database: schema, multipleStatements: true });
}

async function locked(user: string): Promise<boolean> {
  const [row] = await rootQuery<{ l: string | null }>(
    "SELECT JSON_VALUE(Priv, '$.account_locked') AS l FROM mysql.global_priv WHERE User = ?",
    [user],
  );
  return row?.l === "1" || row?.l === "true";
}

function fenceJournals(): string[] {
  const dir = journalDir();
  return existsSync(dir) ? readdirSync(dir).filter((n) => n.startsWith("fence-")) : [];
}

describe.skipIf(!mariadbAvailable())("write fence, scoped accounts and host changes", () => {
  let instance: TestInstance | null = null;
  let owner: SeededUser;
  let counter = 0;

  async function makeDatabase() {
    counter++;
    return provisionDatabase({ displayName: `fence ${process.pid % 1000} ${counter} ${Math.random().toString(36).slice(2, 6)}`, ownerUserId: owner.id });
  }

  beforeAll(async () => {
    instance = await startTestInstance();
    owner = seedUser("admin");
  }, 120_000);

  afterAll(async () => {
    await instance?.stop();
  }, 60_000);

  test("the fence ends the database's own sessions, refuses new ones, and always lifts", async () => {
    const { database, credentials } = await makeDatabase();
    const app = await ownerLogin(credentials.user, credentials.password, database.name);
    await app.query("CREATE TABLE t (id INT PRIMARY KEY)");
    await app.query("START TRANSACTION");
    await app.query("INSERT INTO t VALUES (1)");
    const seen: { sessionsEnded: number; refused: string; fenced: boolean; journals: number } = {
      sessionsEnded: 0,
      refused: "",
      fenced: false,
      journals: 0,
    };
    await withWriteFence(database.id, async (fence) => {
      seen.sessionsEnded = fence.sessionsEnded;
      seen.fenced = isWriteFenced(database.id) && isWriteFenced(database.name);
      seen.journals = fenceJournals().length;
      await ownerLogin(credentials.user, credentials.password, database.name).then(
        (c) => c.end(),
        (err: { errno?: number; message?: string }) => {
          seen.refused = `${err.errno} ${err.message}`;
        },
      );
    });
    expect(seen.sessionsEnded).toBe(1);
    expect(seen.fenced).toBe(true);
    expect(seen.journals).toBe(1);
    expect(seen.refused).toMatch(/^4151 /);
    await expect(app.query("SELECT 1")).rejects.toThrow();
    app.destroy();
    expect(await rootQuery(`SELECT COUNT(*) AS n FROM \`${database.name}\`.t`)).toEqual([{ n: 0 }]);
    expect(isWriteFenced(database.id)).toBe(false);
    expect(await locked(credentials.user)).toBe(false);
    expect(fenceJournals()).toEqual([]);
    const again = await ownerLogin(credentials.user, credentials.password, database.name);
    await again.end();

    await expect(
      withWriteFence(database.id, async () => {
        throw new Error("the work inside failed");
      }),
    ).rejects.toThrow("the work inside failed");
    expect(await locked(credentials.user)).toBe(false);
  }, 60_000);

  test("a fence left behind by a crash is lifted at startup, and an account locked by an admin stays locked", async () => {
    const { database, credentials } = await makeDatabase();
    const saved = mkdtempSync(join(tmpdir(), "ld-fence-"));
    let name = "";
    await withWriteFence(database.id, async () => {
      name = fenceJournals()[0]!;
      copyFileSync(join(journalDir(), name), join(saved, name));
    });
    copyFileSync(join(saved, name), join(journalDir(), name));
    await rootQuery("ALTER USER ?@'%' ACCOUNT LOCK", [credentials.user]);
    const lifted = await liftLeftoverWriteFences();
    expect(lifted.lifted).toEqual([database.name]);
    expect(await locked(credentials.user)).toBe(false);
    expect(fenceJournals()).toEqual([]);

    await rootQuery("ALTER USER ?@'%' ACCOUNT LOCK", [credentials.user]);
    await withWriteFence(database.id, async () => {});
    expect(await locked(credentials.user)).toBe(true);
    await rootQuery("ALTER USER ?@'%' ACCOUNT UNLOCK", [credentials.user]);
  }, 60_000);

  test("a scoped account reaches exactly its schema and is removed afterwards, even on failure", async () => {
    const a = await makeDatabase();
    const b = await makeDatabase();
    await rootQuery(`CREATE TABLE \`${b.database.name}\`.secret (v INT)`);
    let user = "";
    await expect(
      withScopedAccount({ schemas: [a.database.name] }, async (account) => {
        user = account.user;
        const c = await mysql.createConnection({ ...account.target, database: a.database.name });
        try {
          await c.query("CREATE TABLE mine (id INT)");
          await expect(c.query(`SELECT * FROM \`${b.database.name}\`.secret`)).rejects.toThrow(/denied/);
          await expect(c.query("SELECT * FROM mysql.user")).rejects.toThrow(/denied/);
          await expect(c.query("CREATE USER 'x'@'%'")).rejects.toThrow(/denied/);
        } finally {
          await c.end();
        }
        throw new Error("loader failed");
      }),
    ).rejects.toThrow("loader failed");
    expect(await rootQuery("SELECT User FROM mysql.user WHERE User = ?", [user])).toEqual([]);

    const orphan = await createScopedAccount({ schemas: [a.database.name] });
    const fresh = await import("../../src/mariadb/scopedAccount");
    expect(fresh.scopedAccountActive(orphan.user)).toBe(true);
    await fresh.dropScopedAccount(orphan);
    await rootQuery("CREATE USER 'ld_scp_abcdefghijkl'@'127.0.0.1' IDENTIFIED BY 'leftover-pass'");
    expect(await dropOrphanScopedAccounts()).toBeGreaterThanOrEqual(1);
    expect(await rootQuery("SELECT User FROM mysql.user WHERE User = 'ld_scp_abcdefghijkl'")).toEqual([]);
  }, 60_000);

  test("a host change waits for the database lock and re-creates only the objects whose definer changes", async () => {
    const { database, credentials } = await makeDatabase();
    const app = await ownerLogin(credentials.user, credentials.password, database.name);
    await app.query(`
      CREATE TABLE t (id INT PRIMARY KEY);
      CREATE TABLE log (msg VARCHAR(40));
      CREATE PROCEDURE p_doc()
      BEGIN
        -- explains the business rule
        SELECT 1;
      END;
      CREATE TRIGGER a_first AFTER INSERT ON t FOR EACH ROW INSERT INTO log VALUES ('first');
    `);
    await app.end();
    await rootQuery(`CREATE PROCEDURE \`${database.name}\`.p_admin() SELECT 2`);
    await rootQuery(`CREATE TRIGGER \`${database.name}\`.b_second AFTER INSERT ON \`${database.name}\`.t FOR EACH ROW INSERT INTO \`${database.name}\`.log VALUES ('second')`);
    const created = async (name: string) =>
      String((await rootQuery<Row>(`SELECT CREATED AS c FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA = ? AND ROUTINE_NAME = ?`, [database.name, name]))[0]!.c);
    const adminBefore = await created("p_admin");

    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const job = startJob({ kind: "sync.run", databaseId: database.id, userId: null }, () => gate);
    await expect(
      updateAllowedHost({ user: credentials.user, oldHost: "%", newHost: "10.9.%", password: credentials.password, schema: database.name }),
    ).rejects.toMatchObject({ name: "JobConflictError" });
    release();
    await waitForJob(job.id);

    await Bun.sleep(1100);
    const result = await updateAllowedHost({
      user: credentials.user,
      oldHost: "%",
      newHost: "10.9.%",
      password: credentials.password,
      schema: database.name,
    });
    expect(result.warnings).toEqual([]);
    const [proc] = await rootQuery<Row>(`SHOW CREATE PROCEDURE \`${database.name}\`.p_doc`);
    expect(String(proc!["Create Procedure"])).toContain("-- explains the business rule");
    expect(String(proc!["Create Procedure"])).toContain(`DEFINER=\`${credentials.user}\`@\`10.9.%\``);
    expect(await created("p_admin")).toBe(adminBefore);
    const triggers = await rootQuery<Row>(
      `SELECT TRIGGER_NAME AS n, ACTION_ORDER AS o, DEFINER AS d FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = ? ORDER BY ACTION_ORDER`,
      [database.name],
    );
    expect(triggers.map((t) => `${t.o}:${t.n}`)).toEqual(["1:a_first", "2:b_second"]);
    expect(String(triggers[0]!.d)).toBe(`${credentials.user}@10.9.%`);
  }, 60_000);
});
