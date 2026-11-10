import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mariadbAvailable, rootQuery, startTestInstance, type TestInstance } from "../harness/instance";
import { authHeaders, seedUser, type SeededUser } from "../harness/sqlite";
import type { AppAuthUser, Database } from "@lambdata/shared";

const available = mariadbAvailable();

type Message = Record<string, unknown> & { type: string; event?: string; channel?: string; error?: string };

interface FakeClient {
  user: AppAuthUser;
  token: string;
  sent: Message[];
  closed: { code?: number; reason?: string } | null;
  ws: import("../../src/realtime/hub").RealtimeSocket;
}

describe.skipIf(!available)("Realtime authorization", () => {
  let instance: TestInstance;
  let app: { request(path: string, init?: RequestInit): Response | Promise<Response> };
  let hub: typeof import("../../src/realtime/hub");
  let queries: typeof import("../../src/db/queries");
  let dataAccessMod: typeof import("../../src/db/queries/dataAccess");
  let appJwt: typeof import("../../src/auth/appJwt");
  let ids: typeof import("../../src/util/id");
  let owner: SeededUser;
  let adminUser: SeededUser;
  let feedDb: Database;
  let alice: FakeClient;
  let bob: FakeClient;

  async function appUser(): Promise<{ user: AppAuthUser; token: string }> {
    const id = ids.newId("app_user");
    queries.appAuthUsers.insert({
      id,
      email: `${id.slice(-10)}@example.test`,
      passwordHash: "unused",
      displayName: `User ${id.slice(-4)}`,
      emailConfirmed: true,
      status: "active",
    });
    const user = queries.appAuthUsers.byId(id)!;
    return { user, token: (await appJwt.signAppAuthJwt(user)).accessToken };
  }

  async function connect(expiresAt = Date.now() + 3_600_000): Promise<FakeClient> {
    const { user, token } = await appUser();
    const data = await hub.realtimeSocketDataFromRequest(
      new Request(`http://localhost/api/realtime/v1/websocket?token=${token}`),
    );
    expect(data).not.toBeNull();
    const client: FakeClient = {
      user,
      token,
      sent: [],
      closed: null,
      ws: {
        data: { ...data!, expiresAt },
        send(message: string) {
          client.sent.push(JSON.parse(message) as Message);
          return 1;
        },
        close(code?: number, reason?: string) {
          client.closed = { code, reason };
        },
      },
    };
    hub.openSocket(client.ws);
    return client;
  }

  async function message(client: FakeClient, body: Record<string, unknown>): Promise<Message | undefined> {
    const before = client.sent.length;
    await hub.receiveMessage(client.ws, JSON.stringify(body));
    return client.sent.slice(before).find((m) => m.type === "system" || m.type === "error");
  }

  function changes(client: FakeClient): Message[] {
    return client.sent.filter((m) => m.type === "db_changes");
  }

  async function policy(table: string, body: Record<string, unknown>): Promise<void> {
    const res = await app.request(`/api/data-policies/${feedDb.name}/${table}`, {
      method: "PATCH",
      headers: await authHeaders(owner, { "Content-Type": "application/json" }),
      body: JSON.stringify(body),
    });
    expect(res.status).toBe(200);
  }

  async function insert(client: FakeClient, table: string, row: Record<string, unknown>): Promise<Response> {
    return app.request(`/api/data/${feedDb.name}/${table}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${client.token}`, "Content-Type": "application/json" },
      body: JSON.stringify(row),
    });
  }

  beforeAll(async () => {
    instance = await startTestInstance();
    hub = await import("../../src/realtime/hub");
    queries = await import("../../src/db/queries");
    dataAccessMod = await import("../../src/db/queries/dataAccess");
    appJwt = await import("../../src/auth/appJwt");
    ids = await import("../../src/util/id");
    app = (await import("../../src/server")).buildApp();
    owner = seedUser("db_owner");
    adminUser = seedUser("admin");
    const provision = await import("../../src/databases/provision");
    feedDb = (
      await provision.provisionDatabase({ displayName: `fa feed ${ids.randAlphaNum(6)}`, ownerUserId: owner.id })
    ).database;
    const s = `\`${feedDb.name}\``;
    await rootQuery(`CREATE TABLE ${s}.feed (id INT AUTO_INCREMENT PRIMARY KEY, owner_id VARCHAR(64), msg TEXT)`);
    await rootQuery(`CREATE TABLE ${s}.board (id INT AUTO_INCREMENT PRIMARY KEY, msg TEXT)`);
    await rootQuery(`CREATE TABLE ${s}.secret (id INT PRIMARY KEY, msg TEXT)`);
    alice = await connect();
    bob = await connect();
  }, 180_000);

  afterAll(async () => {
    for (const client of [alice, bob]) if (client) hub.closeSocket(client.ws);
    await instance?.stop();
  }, 120_000);

  test("subscribing to a table without a policy in a closed database is refused and counted", async () => {
    const reply = await message(alice, { type: "subscribe", channel: `db:${feedDb.name}:table:secret` });
    expect(reply?.type).toBe("error");
    expect(reply?.error).toContain(`table "secret" in database "${feedDb.name}" has no Data API policy`);
    const denial = dataAccessMod.dataAccess.denials(feedDb.id).find((d) => d.tableName === "secret");
    expect(denial).toMatchObject({ operation: "select", count: 1 });

    const missing = await message(alice, { type: "subscribe", channel: `db:${feedDb.name}:table:ghost` });
    expect(missing?.type).toBe("error");
    expect(dataAccessMod.dataAccess.denials(feedDb.id).some((d) => d.tableName === "ghost")).toBe(false);

    const wholeDb = await message(alice, { type: "subscribe", channel: `db:${feedDb.name}` });
    expect(wholeDb?.type).toBe("error");
    const reserved = await message(alice, { type: "subscribe", channel: `db:${feedDb.name}:whatever` });
    expect(reserved?.type).toBe("error");
  });

  test("owner-scoped tables deliver change events only to the row's owner", async () => {
    await policy("feed", {
      selectEnabled: true,
      insertEnabled: true,
      updateEnabled: true,
      deleteEnabled: true,
      ownerColumn: "owner_id",
    });
    const channel = `db:${feedDb.name}:table:feed`;
    expect((await message(alice, { type: "subscribe", channel }))?.event).toBe("subscribed");
    expect((await message(bob, { type: "subscribe", channel }))?.event).toBe("subscribed");
    expect((await message(bob, { type: "subscribe", channel: `db:${feedDb.name}` }))?.event).toBe("subscribed");

    expect((await insert(alice, "feed", { owner_id: alice.user.id, msg: "for alice only" })).status).toBe(201);
    const aliceEvents = changes(alice);
    expect(aliceEvents.length).toBe(1);
    expect(aliceEvents[0]!.payload).toMatchObject({ table: "feed", operation: "INSERT", new: { msg: "for alice only" } });
    expect(aliceEvents[0]!.user).toEqual({ id: alice.user.id, displayName: alice.user.displayName });
    expect(changes(bob)).toEqual([]);

    const update = await app.request(`/api/data/${feedDb.name}/feed`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${alice.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ msg: "edited" }),
    });
    expect(update.status).toBe(200);
    expect(changes(alice).map((m) => m.event)).toEqual(["INSERT", "UPDATE"]);
    expect(changes(bob)).toEqual([]);

    expect((await insert(bob, "feed", { owner_id: bob.user.id, msg: "for bob" })).status).toBe(201);
    expect(changes(bob).map((m) => m.channel).sort()).toEqual([`db:${feedDb.name}`, channel].sort());
    expect(changes(alice).length).toBe(2);
  });

  test("events from a publisher that cannot prove ownership carry no row data", async () => {
    const before = changes(bob).length;
    hub.publishDatabaseChange({
      database: feedDb.name,
      table: "feed",
      operation: "UPDATE",
      payload: { affectedRows: 3, set: { msg: "leak?" }, filters: [] },
    });
    const latest = changes(bob).slice(before);
    expect(latest.length).toBeGreaterThan(0);
    for (const event of latest) {
      expect(event.payload).toEqual({ database: feedDb.name, table: "feed", operation: "UPDATE", affectedRows: 3 });
    }
  });

  test("tables without an owner column deliver to every subscriber, and stop when select is disabled", async () => {
    await policy("board", { selectEnabled: true, insertEnabled: true, updateEnabled: false, deleteEnabled: false });
    const channel = `db:${feedDb.name}:table:board`;
    await message(alice, { type: "subscribe", channel });
    await message(bob, { type: "subscribe", channel });
    const aliceBefore = changes(alice).length;
    const bobBefore = changes(bob).length;
    expect((await insert(alice, "board", { msg: "hello all" })).status).toBe(201);
    expect(changes(alice).length).toBe(aliceBefore + 1);
    expect(changes(bob).length).toBe(bobBefore + 2);

    await policy("board", { selectEnabled: false });
    expect((await insert(alice, "board", { msg: "nobody hears this" })).status).toBe(201);
    expect(changes(alice).length).toBe(aliceBefore + 1);
    expect(changes(bob).length).toBe(bobBefore + 2);
    expect((await message(bob, { type: "subscribe", channel }))?.type).toBe("error");
  });

  test("an open database allows subscriptions to tables without a policy", async () => {
    dataAccessMod.dataAccess.setMode(feedDb.id, "open", null);
    try {
      const reply = await message(alice, { type: "subscribe", channel: `db:${feedDb.name}:table:secret` });
      expect(reply?.event).toBe("subscribed");
    } finally {
      dataAccessMod.dataAccess.setMode(feedDb.id, "closed", null);
    }
  });

  test("app users cannot broadcast or set presence on database-change channels", async () => {
    const channel = `db:${feedDb.name}:table:feed`;
    const broadcast = await message(alice, { type: "broadcast", channel, event: "INSERT", payload: { fake: true } });
    expect(broadcast?.type).toBe("error");
    const presence = await message(alice, { type: "presence", channel, state: { here: true } });
    expect(presence?.type).toBe("error");
    expect(changes(bob).some((m) => (m.payload as Record<string, unknown>)?.fake)).toBe(false);

    const http = await app.request("/api/realtime/broadcast", {
      method: "POST",
      headers: { Authorization: `Bearer ${alice.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ messages: [{ channel, event: "INSERT", payload: { fake: true } }] }),
    });
    expect(http.status).toBe(403);
    const badChannel = await app.request("/api/realtime/broadcast", {
      method: "POST",
      headers: { Authorization: `Bearer ${alice.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ messages: [{ channel: "spaces not allowed", event: "x" }] }),
    });
    expect(badChannel.status).toBe(400);
  });

  test("application-defined channels keep working", async () => {
    const channel = "room:lobby";
    expect((await message(alice, { type: "subscribe", channel, presence: { name: "a" } }))?.event).toBe("subscribed");
    expect((await message(bob, { type: "subscribe", channel }))?.event).toBe("subscribed");
    await message(alice, { type: "broadcast", channel, event: "wave", payload: { hi: 1 } });
    expect(bob.sent.some((m) => m.type === "broadcast" && m.event === "wave")).toBe(true);
    expect(bob.sent.some((m) => m.type === "presence" && Array.isArray(m.users) && m.users.length === 1)).toBe(true);

    const http = await app.request("/api/realtime/broadcast", {
      method: "POST",
      headers: { Authorization: `Bearer ${bob.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ messages: [{ topic: channel, event: "ping" }] }),
    });
    expect(http.status).toBe(200);
    expect((await http.json()).delivered).toBe(2);
  });

  test("expired and revoked sockets are closed instead of receiving events", async () => {
    const stale = await connect(Date.now() - 1000);
    hub.publishBroadcast({ channel: "room:lobby", event: "noop", payload: null });
    await message(stale, { type: "ping" });
    expect(stale.closed?.code).toBe(4001);

    const victim = await connect();
    await message(victim, { type: "subscribe", channel: "room:lobby" });
    const res = await app.request(`/api/app-auth/users/${victim.user.id}`, {
      method: "PATCH",
      headers: await authHeaders(adminUser, { "Content-Type": "application/json" }),
      body: JSON.stringify({ status: "disabled" }),
    });
    expect(res.status).toBe(200);
    expect(victim.closed?.code).toBe(4003);
    expect(
      await hub.realtimeSocketDataFromRequest(new Request(`http://localhost/x?token=${victim.token}`)),
    ).toBeNull();
  });
});
