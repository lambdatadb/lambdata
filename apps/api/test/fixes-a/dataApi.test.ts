import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mariadbAvailable, rootQuery, startTestInstance, type TestInstance } from "../harness/instance";
import { authHeaders, seedUser, type SeededUser } from "../harness/sqlite";
import type { DataApiAccessResponse, DataApiOverviewResponse, Database } from "@lambdata/shared";

const available = mariadbAvailable();

describe.skipIf(!available)("Data API access", () => {
  let instance: TestInstance;
  let app: { request(path: string, init?: RequestInit): Response | Promise<Response> };
  let mods: {
    provision: typeof import("../../src/databases/provision");
    queries: typeof import("../../src/db/queries");
    dataAccess: typeof import("../../src/db/queries/dataAccess");
    appJwt: typeof import("../../src/auth/appJwt");
    id: typeof import("../../src/util/id");
  };
  let admin: SeededUser;
  let owner: SeededUser;
  let stranger: SeededUser;
  let viewer: SeededUser;
  let shop: Database;
  let alice: { id: string; bearer: Record<string, string> };
  let bob: { id: string; bearer: Record<string, string> };

  async function appUser(): Promise<{ id: string; bearer: Record<string, string> }> {
    const id = mods.id.newId("app_user");
    mods.queries.appAuthUsers.insert({
      id,
      email: `${id.slice(-10)}@example.test`,
      passwordHash: "unused",
      displayName: null,
      emailConfirmed: true,
      status: "active",
    });
    const { accessToken } = await mods.appJwt.signAppAuthJwt(mods.queries.appAuthUsers.byId(id)!);
    return { id, bearer: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" } };
  }

  async function data(
    who: { bearer: Record<string, string> },
    method: string,
    path: string,
    body?: unknown,
  ): Promise<Response> {
    return app.request(`/api/data/${shop.name}/${path}`, {
      method,
      headers: who.bearer,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }

  async function consoleCall(user: SeededUser, method: string, path: string, body?: unknown): Promise<Response> {
    return app.request(path, {
      method,
      headers: await authHeaders(user, { "Content-Type": "application/json" }),
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }

  function denialCount(table: string, operation: string): number {
    return (
      mods.dataAccess.dataAccess.denials(shop.id).find((d) => d.tableName === table && d.operation === operation)
        ?.count ?? 0
    );
  }

  beforeAll(async () => {
    instance = await startTestInstance();
    mods = {
      provision: await import("../../src/databases/provision"),
      queries: await import("../../src/db/queries"),
      dataAccess: await import("../../src/db/queries/dataAccess"),
      appJwt: await import("../../src/auth/appJwt"),
      id: await import("../../src/util/id"),
    };
    app = (await import("../../src/server")).buildApp();
    admin = seedUser("admin");
    owner = seedUser("db_owner");
    stranger = seedUser("db_owner");
    viewer = seedUser("viewer");
    shop = (
      await mods.provision.provisionDatabase({
        displayName: `fa shop ${mods.id.randAlphaNum(6)}`,
        ownerUserId: owner.id,
      })
    ).database;
    const s = `\`${shop.name}\``;
    await rootQuery(`CREATE TABLE ${s}.items (id BIGINT PRIMARY KEY, title VARCHAR(100))`);
    await rootQuery(`CREATE TABLE ${s}.tags (id INT AUTO_INCREMENT PRIMARY KEY, label VARCHAR(40))`);
    await rootQuery(
      `CREATE TABLE ${s}.notes (id INT AUTO_INCREMENT PRIMARY KEY, owner_id VARCHAR(64) NOT NULL, body TEXT)`,
    );
    await rootQuery(
      `CREATE TABLE ${s}.big (id BIGINT PRIMARY KEY, label VARCHAR(20), meta JSON, amount DECIMAL(30,2))`,
    );
    await rootQuery(`INSERT INTO ${s}.items VALUES (1, 'first'), (2, 'second')`);
    await rootQuery(
      `INSERT INTO ${s}.big (id, label, amount) VALUES (76561198000000000, 'zero', 12345678901234567.01), (76561198000000007, 'seven', 12345678901234567.02), (76561198000000008, 'eight', NULL)`,
    );
    alice = await appUser();
    bob = await appUser();
  }, 180_000);

  afterAll(async () => {
    await instance?.stop();
  }, 120_000);

  test("a table without a policy is closed by default and every denial is counted", async () => {
    const res = await data(alice, "GET", "items");
    expect(res.status).toBe(403);
    const message = (await res.json()).error as string;
    expect(message).toContain(`table "items" in database "${shop.name}" has no Data API policy`);
    expect(message).toContain("Data API page");
    expect(denialCount("items", "select")).toBe(1);

    expect((await data(alice, "GET", "items")).status).toBe(403);
    expect((await data(alice, "POST", "items", { id: 3, title: "x" })).status).toBe(403);
    expect((await data(bob, "PATCH", "items?id=eq.1", { title: "y" })).status).toBe(403);
    expect((await data(bob, "DELETE", "items")).status).toBe(403);
    expect(denialCount("items", "select")).toBe(2);
    expect(denialCount("items", "insert")).toBe(1);
    expect(denialCount("items", "update")).toBe(1);
    expect(denialCount("items", "delete")).toBe(1);
    const rows = await rootQuery<{ n: number }>(`SELECT COUNT(*) AS n FROM \`${shop.name}\`.items`);
    expect(Number(rows[0]!.n)).toBe(2);
  });

  test("unknown tables are not counted", async () => {
    expect((await data(alice, "GET", "nope")).status).toBe(404);
    expect(mods.dataAccess.dataAccess.denials(shop.id).some((d) => d.tableName === "nope")).toBe(false);
  });

  test("the policy listing reflects closed access for tables without a policy", async () => {
    const res = await consoleCall(owner, "GET", `/api/data-policies/${shop.name}`);
    expect(res.status).toBe(200);
    const items = (await res.json()).policies.find((p: { tableName: string }) => p.tableName === "items");
    expect(items).toMatchObject({ selectEnabled: false, insertEnabled: false, createdAt: null });
  });

  test("a policy with a method disabled allows the others and its refusals are not counted", async () => {
    const res = await consoleCall(owner, "PATCH", `/api/data-policies/${shop.name}/items`, { selectEnabled: true });
    expect(res.status).toBe(200);
    expect((await res.json()).policy).toMatchObject({
      selectEnabled: true,
      insertEnabled: false,
      updateEnabled: false,
      deleteEnabled: false,
    });
    const read = await data(alice, "GET", "items?order=id.asc");
    expect(read.status).toBe(200);
    expect((await read.json()).data.map((r: { title: string }) => r.title)).toEqual(["first", "second"]);
    const insert = await data(alice, "POST", "items", { id: 3, title: "x" });
    expect(insert.status).toBe(403);
    expect((await insert.json()).error).toBe("insert is disabled by table policy");
    expect(denialCount("items", "insert")).toBe(1);
  });

  test("an open database lets app users reach tables without a policy, and closing it again denies", async () => {
    expect((await data(alice, "GET", "tags")).status).toBe(403);
    const open = await consoleCall(owner, "PUT", `/api/data-access/${shop.name}`, { mode: "open" });
    expect(open.status).toBe(200);
    expect(((await open.json()) as DataApiAccessResponse).access.mode).toBe("open");

    expect((await data(alice, "POST", "tags", { label: "red" })).status).toBe(201);
    const read = await data(bob, "GET", "tags");
    expect(read.status).toBe(200);
    expect((await read.json()).data).toEqual([{ id: 1, label: "red" }]);
    const listed = await consoleCall(owner, "GET", `/api/data-policies/${shop.name}/tags`);
    expect((await listed.json()).policy).toMatchObject({ selectEnabled: true, deleteEnabled: true, createdAt: null });

    expect((await data(alice, "GET", "items")).status).toBe(200);
    expect((await data(alice, "POST", "items", { id: 9, title: "z" })).status).toBe(403);

    const close = await consoleCall(owner, "PUT", `/api/data-access/${shop.name}`, { mode: "closed" });
    expect(((await close.json()) as DataApiAccessResponse).access.mode).toBe("closed");
    expect((await data(bob, "GET", "tags")).status).toBe(403);
  });

  test("owner-column policies scope every operation to the caller's rows", async () => {
    const policy = await consoleCall(owner, "PATCH", `/api/data-policies/${shop.name}/notes`, {
      selectEnabled: true,
      insertEnabled: true,
      updateEnabled: true,
      deleteEnabled: true,
      ownerColumn: "owner_id",
    });
    expect(policy.status).toBe(200);

    expect((await data(alice, "POST", "notes", { owner_id: alice.id, body: "a1" })).status).toBe(201);
    expect((await data(alice, "POST", "notes", [{ owner_id: alice.id, body: "a2" }])).status).toBe(201);
    expect((await data(alice, "POST", "notes", { owner_id: bob.id, body: "forged" })).status).toBe(403);
    expect((await data(bob, "POST", "notes", { owner_id: bob.id, body: "b1" })).status).toBe(201);

    const mine = await (await data(alice, "GET", "notes?order=id.asc")).json();
    expect(mine.data.map((r: { body: string }) => r.body)).toEqual(["a1", "a2"]);
    const bobNote = (await (await data(bob, "GET", "notes")).json()).data[0] as { id: number };

    const sneaky = await data(alice, "PATCH", `notes?id=eq.${bobNote.id}`, { body: "hijacked" });
    expect((await sneaky.json()).data.affectedRows).toBe(0);
    expect((await data(alice, "PATCH", "notes", { owner_id: bob.id })).status).toBe(403);
    const wipe = await data(alice, "DELETE", "notes");
    expect((await wipe.json()).data.affectedRows).toBe(2);

    const left = await rootQuery<{ owner_id: string; body: string }>(
      `SELECT owner_id, body FROM \`${shop.name}\`.notes`,
    );
    expect(left).toEqual([{ owner_id: bob.id, body: "b1" }]);
  });

  test("big integers round-trip as strings and filter exactly", async () => {
    await consoleCall(owner, "PATCH", `/api/data-policies/${shop.name}/big`, {
      selectEnabled: true,
      insertEnabled: true,
      updateEnabled: true,
      deleteEnabled: false,
    });
    const exact = await (await data(alice, "GET", "big?id=eq.76561198000000008")).json();
    expect(exact.data).toEqual([{ id: "76561198000000008", label: "eight", meta: null, amount: null }]);
    const listed = await (await data(alice, "GET", "big?id=in.(76561198000000000,76561198000000007)&order=id.asc")).json();
    expect(listed.data.map((r: { id: string }) => r.id)).toEqual(["76561198000000000", "76561198000000007"]);

    const insert = await data(alice, "POST", "big", { id: "76561198000000009", label: "nine", meta: { tier: 2 } });
    expect(insert.status).toBe(201);
    const back = await (await data(alice, "GET", "big?id=eq.76561198000000009")).json();
    expect(back.data[0].id).toBe("76561198000000009");
    expect(JSON.parse(back.data[0].meta)).toEqual({ tier: 2 });

    const update = await data(alice, "PATCH", "big?id=eq.76561198000000007", { label: "SEVEN" });
    expect((await update.json()).data.affectedRows).toBe(1);
    const labels = await rootQuery<{ id: string; label: string }>(
      `SELECT CAST(id AS CHAR) AS id, label FROM \`${shop.name}\`.big ORDER BY id`,
    );
    expect(labels.map((r) => r.label)).toEqual(["zero", "SEVEN", "eight", "nine"]);

    const decimal = await (await data(alice, "GET", "big?amount=eq.12345678901234567.02")).json();
    expect(decimal.data.map((r: { label: string; amount: string }) => [r.label, r.amount])).toEqual([
      ["SEVEN", "12345678901234567.02"],
    ]);
    const above = await (await data(alice, "GET", "big?amount=gt.12345678901234567.01")).json();
    expect(above.data.map((r: { label: string }) => r.label)).toEqual(["SEVEN"]);

    const small = await (await data(bob, "GET", "items?id=eq.1")).json();
    expect(small.data[0].id).toBe(1);
  });

  test("the overview reports mode, tables without a policy and denials per database", async () => {
    const res = await consoleCall(admin, "GET", "/api/data-access");
    expect(res.status).toBe(200);
    const body = (await res.json()) as DataApiOverviewResponse;
    expect(typeof body.signupEnabled).toBe("boolean");
    const summary = body.databases.find((d) => d.databaseId === shop.id)!;
    expect(summary).toMatchObject({ databaseName: shop.name, displayName: shop.displayName, mode: "closed", tableCount: 4 });
    expect(summary.tablesWithoutPolicy).toEqual(["tags"]);
    const select = summary.denials.find((d) => d.tableName === "items" && d.operation === "select")!;
    expect(select).toMatchObject({ databaseId: shop.id, databaseName: shop.name, count: 2 });
    expect(select.lastAt).toBeGreaterThan(Date.now() - 600_000);
    expect(summary.denials.some((d) => d.tableName === "tags" && d.operation === "select")).toBe(true);

    const viewerView = (await (await consoleCall(viewer, "GET", "/api/data-access")).json()) as DataApiOverviewResponse;
    expect(viewerView.databases.some((d) => d.databaseId === shop.id)).toBe(true);
    const strangerView = (await (await consoleCall(stranger, "GET", "/api/data-access")).json()) as DataApiOverviewResponse;
    expect(strangerView.databases.some((d) => d.databaseId === shop.id)).toBe(false);
  });

  test("access and denial endpoints check the caller's rights", async () => {
    const access = `/api/data-access/${shop.name}`;
    expect((await consoleCall(viewer, "GET", access)).status).toBe(200);
    expect((await consoleCall(viewer, "PUT", access, { mode: "open" })).status).toBe(403);
    expect((await consoleCall(stranger, "GET", access)).status).toBe(403);
    expect((await consoleCall(stranger, "PUT", access, { mode: "open" })).status).toBe(403);
    expect((await consoleCall(owner, "PUT", access, { mode: "wide-open" })).status).toBe(400);
    expect((await consoleCall(viewer, "DELETE", `/api/data-access/${shop.name}/denials`)).status).toBe(403);
    expect(mods.dataAccess.dataAccess.mode(shop.id)).toBe("closed");
  });

  test("clearing denials empties the record for that database", async () => {
    expect(mods.dataAccess.dataAccess.denials(shop.id).length).toBeGreaterThan(0);
    const res = await consoleCall(owner, "DELETE", `/api/data-access/${shop.name}/denials`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(mods.dataAccess.dataAccess.denials(shop.id)).toEqual([]);
    const after = (await (await consoleCall(owner, "GET", `/api/data-access/${shop.name}`)).json()) as DataApiAccessResponse;
    expect(after.access.denials).toEqual([]);
  });

  test("tables named access and denials have working policy routes", async () => {
    for (const table of ["access", "denials"]) {
      await rootQuery(`CREATE TABLE \`${shop.name}\`.\`${table}\` (id INT PRIMARY KEY)`);
      const path = `/api/data-policies/${shop.name}/${table}`;
      const initial = await consoleCall(owner, "GET", path);
      expect(initial.status).toBe(200);
      expect((await initial.json()).policy).toMatchObject({ tableName: table, selectEnabled: false, createdAt: null });
      const set = await consoleCall(owner, "PATCH", path, { selectEnabled: true });
      expect(set.status).toBe(200);
      expect((await set.json()).policy).toMatchObject({ tableName: table, selectEnabled: true });
      const got = await consoleCall(owner, "GET", path);
      expect((await got.json()).policy.selectEnabled).toBe(true);
      expect((await data(alice, "GET", table)).status).toBe(200);
      const reset = await consoleCall(owner, "DELETE", path);
      expect(reset.status).toBe(200);
      expect((await reset.json()).policy).toMatchObject({ tableName: table, createdAt: null });
      expect(mods.queries.dataApiPolicies.byTable(shop.id, table)).toBeNull();
    }
  });

  test("database errors caused by the request are client errors", async () => {
    await consoleCall(owner, "PATCH", `/api/data-policies/${shop.name}/tags`, { selectEnabled: true, insertEnabled: true });
    const first = await data(alice, "POST", "tags", { id: 500, label: "dup" });
    expect(first.status).toBe(201);
    const duplicate = await data(alice, "POST", "tags", { id: 500, label: "dup" });
    expect(duplicate.status).toBe(409);
    expect((await duplicate.json()).error).toContain("Duplicate entry");
  });

  test("below the disk floor inserts and updates answer 507 like uploads, reads and deletes still work, and the disk is not checked per request", async () => {
    const disk = await import("../../src/util/disk");
    await consoleCall(owner, "PATCH", `/api/data-policies/${shop.name}/tags`, {
      selectEnabled: true,
      insertEnabled: true,
      updateEnabled: true,
      deleteEnabled: true,
    });
    const realSpace = disk.diskProbe.space;
    let probes = 0;
    disk.diskProbe.space = () => {
      probes++;
      return { freeBytes: 1024 * 1024 * 1024, totalBytes: 100 * 1024 * 1024 * 1024 };
    };
    try {
      const expected =
        "Not enough disk space to write rows through the Data API: the data volume has 1 GB free, below the 5 GB floor that LambData keeps free so MariaDB can keep running. Free some space (old checkpoints, pending uploads, files in Storage) or ask an admin to; the floor is set with LAMBDATA_DISK_FLOOR.";
      const insert = await data(alice, "POST", "tags", { id: 900, label: "full" });
      expect(insert.status).toBe(507);
      expect((await insert.json()).error).toBe(expected);
      const many = await data(alice, "POST", "tags", [{ id: 901, label: "a" }, { id: 902, label: "b" }]);
      expect(many.status).toBe(507);
      const update = await data(alice, "PATCH", "tags?id=eq.500", { label: "changed" });
      expect(update.status).toBe(507);
      expect((await update.json()).error).toBe(expected);
      expect(probes).toBe(1);
      expect((await data(alice, "GET", "tags?id=eq.500")).status).toBe(200);
      expect((await data(alice, "DELETE", "tags?id=eq.500")).status).toBe(200);
      expect(await rootQuery(`SELECT id FROM \`${shop.name}\`.tags WHERE id >= 900`)).toEqual([]);
    } finally {
      disk.diskProbe.space = realSpace;
    }
    expect((await data(alice, "POST", "tags", { id: 903, label: "room again" })).status).toBe(201);
  });
});
