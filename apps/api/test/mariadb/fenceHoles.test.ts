import { mariadbAvailable, rootQuery, startTestInstance, type TestInstance } from "../harness/instance";
import { seedUser, type SeededUser } from "../harness/sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { copyFileSync, existsSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import mysql from "mysql2/promise";
import { env } from "../../src/env";
import { provisionDatabase } from "../../src/databases/provision";
import { journalDir } from "../../src/mariadb/journal";
import { createStagingSchema, swapStagingIntoLive } from "../../src/mariadb/schemaSwap";
import {
  FenceTimeoutError,
  abortFencedWork,
  fenceAbortSignal,
  fenceLimits,
  isWriteFenced,
  liftAllWriteFences,
  liftLeftoverWriteFences,
  reconcileFencesAfterRestart,
  withWriteFence,
} from "../../src/mariadb/writeFence";

async function lockedHosts(user: string): Promise<string[]> {
  const rows = await rootQuery<{ h: string; l: string | null }>(
    "SELECT Host AS h, JSON_VALUE(Priv, '$.account_locked') AS l FROM mysql.global_priv WHERE User = ? ORDER BY Host",
    [user],
  );
  return rows.filter((r) => r.l === "1" || r.l === "true").map((r) => r.h);
}

async function eventStatus(schema: string): Promise<Record<string, string>> {
  const rows = await rootQuery<{ n: string; s: string }>(
    "SELECT EVENT_NAME AS n, STATUS AS s FROM information_schema.EVENTS WHERE EVENT_SCHEMA = ? ORDER BY EVENT_NAME",
    [schema],
  );
  return Object.fromEntries(rows.map((r) => [r.n, r.s]));
}

function fenceJournals(): string[] {
  const dir = journalDir();
  return existsSync(dir) ? readdirSync(dir).filter((n) => n.startsWith("fence-")) : [];
}

async function login(user: string, password: string, schema: string): Promise<string> {
  try {
    const c = await mysql.createConnection({ host: "127.0.0.1", port: env.mariadbPort, user, password, database: schema });
    await c.end();
    return "ok";
  } catch (err) {
    return String((err as { errno?: number }).errno ?? (err as Error).message);
  }
}

describe.skipIf(!mariadbAvailable())("write fence: every writer, events, watchdog and restarts", () => {
  let instance: TestInstance | null = null;
  let owner: SeededUser;
  let counter = 0;
  const defaultMax = fenceLimits.maxMs;

  async function makeDatabase() {
    counter++;
    return provisionDatabase({ displayName: `holes ${process.pid % 1000} ${counter} ${Math.random().toString(36).slice(2, 6)}`, ownerUserId: owner.id });
  }

  beforeAll(async () => {
    instance = await startTestInstance();
    owner = seedUser("admin");
  }, 120_000);

  afterAll(async () => {
    fenceLimits.maxMs = defaultMax;
    await instance?.stop();
  }, 60_000);

  test("every host entry of the database's own user is locked, and only those the fence locked are unlocked", async () => {
    const { database, credentials } = await makeDatabase();
    await rootQuery("CREATE USER ?@'127.0.0.1' IDENTIFIED BY ?", [credentials.user, credentials.password]);
    await rootQuery(`GRANT ALL PRIVILEGES ON \`${database.name}\`.* TO ?@'127.0.0.1'`, [credentials.user]);
    await rootQuery("CREATE USER ?@'10.9.9.9' IDENTIFIED BY ?", [credentials.user, credentials.password]);
    await rootQuery("ALTER USER ?@'10.9.9.9' ACCOUNT LOCK", [credentials.user]);
    const seen: { locked: string[]; login: string } = { locked: [], login: "" };
    await withWriteFence(database.id, async (fence) => {
      seen.locked = await lockedHosts(credentials.user);
      seen.login = await login(credentials.user, credentials.password, database.name);
      expect(fence.accounts.map((a) => a.host).sort()).toEqual(["%", "10.9.9.9", "127.0.0.1"]);
    });
    expect(seen.locked).toEqual(["%", "10.9.9.9", "127.0.0.1"]);
    expect(seen.login).toBe("4151");
    expect(await lockedHosts(credentials.user)).toEqual(["10.9.9.9"]);
    expect(await login(credentials.user, credentials.password, database.name)).toBe("ok");
    await rootQuery("DROP USER ?@'127.0.0.1'", [credentials.user]);
    await rootQuery("DROP USER ?@'10.9.9.9'", [credentials.user]);
  }, 60_000);

  test("enabled events are switched off while the fence is up, back on afterwards, and back on after a crash", async () => {
    const { database } = await makeDatabase();
    const s = `\`${database.name}\``;
    await rootQuery(`CREATE TABLE ${s}.evlog (id INT AUTO_INCREMENT PRIMARY KEY)`);
    await rootQuery(`CREATE EVENT ${s}.ev_on ON SCHEDULE EVERY 1 HOUR DO INSERT INTO ${s}.evlog VALUES ()`);
    await rootQuery(`CREATE EVENT ${s}.ev_off ON SCHEDULE EVERY 1 HOUR DISABLE DO INSERT INTO ${s}.evlog VALUES ()`);
    let during: Record<string, string> = {};
    const saved = mkdtempSync(join(tmpdir(), "ld-fence3-"));
    let name = "";
    await withWriteFence(database.id, async (fence) => {
      during = await eventStatus(database.name);
      expect(fence.eventsDisabled).toEqual(["ev_on"]);
      name = fenceJournals().find((n) => n.includes(database.id.replace(/[^A-Za-z0-9_-]/g, "_")))!;
      copyFileSync(join(journalDir(), name), join(saved, name));
    });
    expect(during).toEqual({ ev_off: "DISABLED", ev_on: "DISABLED" });
    expect(await eventStatus(database.name)).toEqual({ ev_off: "DISABLED", ev_on: "ENABLED" });

    await rootQuery(`ALTER EVENT ${s}.ev_on DISABLE`);
    copyFileSync(join(saved, name), join(journalDir(), name));
    const lifted = await liftLeftoverWriteFences();
    expect(lifted.lifted).toContain(database.name);
    expect(await eventStatus(database.name)).toEqual({ ev_off: "DISABLED", ev_on: "ENABLED" });
  }, 60_000);

  test("events a swap replaced keep the state the swap gave them", async () => {
    const { database, credentials } = await makeDatabase();
    const s = `\`${database.name}\``;
    await rootQuery(`CREATE TABLE ${s}.t (id INT PRIMARY KEY)`);
    await rootQuery(`CREATE DEFINER=?@'%' EVENT ${s}.ev ON SCHEDULE EVERY 1 HOUR DISABLE DO DELETE FROM ${s}.t`, [credentials.user]);
    const { captureCodeRecords } = await import("../../src/mariadb/codeObjects");
    const { localAdminTarget } = await import("../../src/mariadb/process");
    const code = await captureCodeRecords(await localAdminTarget(), database.name);
    await rootQuery(`ALTER EVENT ${s}.ev ENABLE`);
    const staging = await createStagingSchema(database.name);
    await rootQuery(`CREATE TABLE \`${staging}\`.t (id INT PRIMARY KEY)`);
    await withWriteFence(database.id, async () => {
      expect((await eventStatus(database.name)).ev).toBe("DISABLED");
      await swapStagingIntoLive({ live: database.name, staging, code, databaseId: database.id });
    });
    expect(await eventStatus(database.name)).toEqual({ ev: "DISABLED" });
  }, 60_000);

  test("a fence whose work hangs is lifted by its watchdog, the work is told to stop, and its late result is discarded", async () => {
    const { database, credentials } = await makeDatabase();
    fenceLimits.maxMs = 1_500;
    let signal: AbortSignal | null = null;
    let release!: () => void;
    const hung = new Promise<void>((r) => {
      release = r;
    });
    const started = Date.now();
    let err: unknown = null;
    try {
      await withWriteFence(database.id, async (fence) => {
        signal = fence.signal;
        expect(fenceAbortSignal(database.id)).toBe(fence.signal);
        await hung;
        return "late";
      });
    } catch (e) {
      err = e;
    } finally {
      fenceLimits.maxMs = defaultMax;
    }
    expect(err).toBeInstanceOf(FenceTimeoutError);
    expect(Date.now() - started).toBeLessThan(10_000);
    expect((signal as AbortSignal | null)?.aborted).toBe(true);
    expect(isWriteFenced(database.id)).toBe(false);
    expect(await lockedHosts(credentials.user)).toEqual([]);
    expect(await login(credentials.user, credentials.password, database.name)).toBe("ok");
    release();
    await Bun.sleep(50);
  }, 60_000);

  test("the watchdog waits for a swap in its critical section before it lifts the fence", async () => {
    const { database, credentials } = await makeDatabase();
    await rootQuery(`CREATE TABLE \`${database.name}\`.t (id INT PRIMARY KEY)`);
    const staging = await createStagingSchema(database.name);
    await rootQuery(`CREATE TABLE \`${staging}\`.t (id INT PRIMARY KEY)`);
    fenceLimits.maxMs = 500;
    let lockedDuringSwap: string[] = [];
    let err: unknown = null;
    try {
      await withWriteFence(database.id, async () => {
        await swapStagingIntoLive({
          live: database.name,
          staging,
          databaseId: database.id,
          onPhase: async (phase) => {
            if (phase !== "renamed") return;
            await Bun.sleep(1_500);
            lockedDuringSwap = await lockedHosts(credentials.user);
          },
        });
        await new Promise(() => {});
      });
    } catch (e) {
      err = e;
    } finally {
      fenceLimits.maxMs = defaultMax;
    }
    expect(err).toBeInstanceOf(FenceTimeoutError);
    expect(lockedDuringSwap).toEqual(["%"]);
    expect(await lockedHosts(credentials.user)).toEqual([]);
  }, 60_000);

  test("after a MariaDB restart a fence with no swap running tells its work to stop and stays applied until the work ends", async () => {
    const { database, credentials } = await makeDatabase();
    let signal: AbortSignal | null = null;
    let report: Awaited<ReturnType<typeof reconcileFencesAfterRestart>> | null = null;
    let lockedAfter: string[] = [];
    await withWriteFence(database.id, async (fence) => {
      signal = fence.signal;
      await rootQuery("ALTER USER ?@'%' ACCOUNT UNLOCK", [credentials.user]);
      report = await reconcileFencesAfterRestart();
      lockedAfter = await lockedHosts(credentials.user);
      if (!fence.signal.aborted) await new Promise<void>((resolve) => fence.signal.addEventListener("abort", () => resolve(), { once: true }));
    });
    expect((signal as AbortSignal | null)?.aborted).toBe(true);
    expect(report!.aborted).toContain(database.name);
    expect(lockedAfter).toEqual(["%"]);
    expect(await lockedHosts(credentials.user)).toEqual([]);
    expect(abortFencedWork(database.id, "nothing to stop")).toBe(false);
  }, 60_000);

  test("stopping lifts fences on a fresh connection, and the work's own lift afterwards is quiet", async () => {
    const { database, credentials } = await makeDatabase();
    const errors: string[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => {
      errors.push(args.map(String).join(" "));
    };
    try {
      await withWriteFence(database.id, async (fence) => {
        await liftAllWriteFences();
        expect(fence.signal.aborted).toBe(true);
        expect(await lockedHosts(credentials.user)).toEqual([]);
      });
    } finally {
      console.error = original;
    }
    expect(errors.filter((e) => e.includes(database.name))).toEqual([]);
    expect(fenceJournals().filter((n) => n.includes(database.id.replace(/[^A-Za-z0-9_-]/g, "_")))).toEqual([]);
  }, 60_000);
});
