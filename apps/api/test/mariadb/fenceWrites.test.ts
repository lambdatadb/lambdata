import { mariadbAvailable, rootQuery, startTestInstance, type TestInstance } from "../harness/instance";
import { authHeaders, seedUser, type SeededUser } from "../harness/sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Database } from "@lambdata/shared";
import { provisionDatabase } from "../../src/databases/provision";
import { appAuthUsers } from "../../src/db/queries";
import { signAppAuthJwt } from "../../src/auth/appJwt";
import { buildApp } from "../../src/server";
import { FENCED_WRITE_MESSAGE } from "../../src/routes/dataApi";
import { fenceLimits, withWriteFence, writesInFlight } from "../../src/mariadb/writeFence";
import { newId, randAlphaNum } from "../../src/util/id";

async function locked(user: string): Promise<boolean> {
  const [row] = await rootQuery<{ l: string | null }>(
    "SELECT JSON_VALUE(Priv, '$.account_locked') AS l FROM mysql.global_priv WHERE User = ?",
    [user],
  );
  return row?.l === "1" || row?.l === "true";
}

async function until(check: () => boolean, timeoutMs = 10_000): Promise<void> {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > timeoutMs) throw new Error("timed out waiting");
    await Bun.sleep(5);
  }
}

describe.skipIf(!mariadbAvailable())("writes already running when a write fence starts", () => {
  let instance: TestInstance | null = null;
  let app: ReturnType<typeof buildApp>;
  let owner: SeededUser;
  let shop: Database;
  let mysqlUser: string;
  let bearer: Record<string, string>;
  const drainMs = fenceLimits.drainMs;

  function insert(title: string): Promise<Response> {
    return Promise.resolve(
      app.request(`/api/data/${shop.name}/items`, { method: "POST", headers: bearer, body: JSON.stringify({ title }) }),
    );
  }

  async function rows(): Promise<string[]> {
    const found = await rootQuery<{ title: string }>(`SELECT title FROM \`${shop.name}\`.items ORDER BY id`);
    return found.map((r) => r.title);
  }

  beforeAll(async () => {
    instance = await startTestInstance();
    app = buildApp();
    owner = seedUser("db_owner");
    const made = await provisionDatabase({ displayName: `fence writes ${randAlphaNum(6)}`, ownerUserId: owner.id });
    shop = made.database;
    mysqlUser = made.credentials.user;
    const s = `\`${shop.name}\``;
    await rootQuery(`CREATE TABLE ${s}.items (id INT AUTO_INCREMENT PRIMARY KEY, title VARCHAR(100) NOT NULL)`);
    await rootQuery(
      `CREATE TRIGGER ${s}.items_slow BEFORE INSERT ON ${s}.items FOR EACH ROW BEGIN IF NEW.title LIKE 'slow%' THEN DO SLEEP(1.5); END IF; END`,
    );
    const open = await app.request(`/api/data-access/${shop.name}`, {
      method: "PUT",
      headers: await authHeaders(owner, { "Content-Type": "application/json" }),
      body: JSON.stringify({ mode: "open" }),
    });
    expect(open.status).toBe(200);
    const id = newId("app_user");
    appAuthUsers.insert({
      id,
      email: `${id.slice(-10)}@example.test`,
      passwordHash: "unused",
      displayName: "Avery Chen",
      emailConfirmed: true,
      status: "active",
    });
    const { accessToken } = await signAppAuthJwt(appAuthUsers.byId(id)!);
    bearer = { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" };
  }, 180_000);

  afterAll(async () => {
    fenceLimits.drainMs = drainMs;
    await instance?.stop();
  }, 60_000);

  test("the fence waits for a slow Data API write to commit before its work runs, and refuses new ones meanwhile", async () => {
    const slow = insert("slow one");
    await until(() => writesInFlight(shop.id) === 1);
    const inside: { rows: string[]; refused: number; refusal: string; query: number; queryError: string } = {
      rows: [],
      refused: 0,
      refusal: "",
      query: 0,
      queryError: "",
    };
    const started = Date.now();
    await withWriteFence(shop.id, async () => {
      inside.rows = await rows();
      const late = await insert("late");
      inside.refused = late.status;
      inside.refusal = ((await late.json()) as { error: string }).error;
      const sql = await app.request(`/api/databases/${shop.id}/query`, {
        method: "POST",
        headers: await authHeaders(owner, { "Content-Type": "application/json" }),
        body: JSON.stringify({ sql: "SELECT COUNT(*) FROM items" }),
      });
      inside.query = sql.status;
      inside.queryError = ((await sql.json()) as { error: string }).error;
    });
    expect(Date.now() - started).toBeGreaterThan(500);
    expect((await slow).status).toBe(201);
    expect(inside.rows).toEqual(["slow one"]);
    expect(inside.refused).toBe(503);
    expect(inside.refusal).toBe(FENCED_WRITE_MESSAGE);
    expect(inside.query).toBe(503);
    expect(inside.queryError).toBe(FENCED_WRITE_MESSAGE);
    expect(writesInFlight(shop.id)).toBe(0);
    expect(await locked(mysqlUser)).toBe(false);
  }, 60_000);

  test("a write that outlasts the wait fails the fence with a clear message and changes nothing", async () => {
    fenceLimits.drainMs = 200;
    try {
      const slow = insert("slow two");
      await until(() => writesInFlight(shop.id) === 1);
      let ran = false;
      await expect(
        withWriteFence(shop.id, async () => {
          ran = true;
        }),
      ).rejects.toThrow(`could not close ${shop.name} to writes: 1 Data API write(s) were still running after 0.2 seconds, so nothing was changed`);
      expect(ran).toBe(false);
      expect(await locked(mysqlUser)).toBe(false);
      expect((await insert("after")).status).toBe(201);
      expect((await slow).status).toBe(201);
      expect((await rows()).sort()).toEqual(["after", "slow one", "slow two"]);
    } finally {
      fenceLimits.drainMs = drainMs;
    }
  }, 60_000);
});
