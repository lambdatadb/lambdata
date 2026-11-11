import { mariadbAvailable, startTestInstance, type TestInstance } from "../harness/instance";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "@lambdata/shared";
import { authHeaders, seedUser, type SeededUser } from "../harness/sqlite";
import { buildApp } from "../../src/server";
import { db } from "../../src/db/client";
import { settings } from "../../src/db/queries";
import { resetAccessTokenRateLimits } from "../../src/accessTokens/gate";
import { LOOPBACK, createToken, session, withToken, type App } from "./helpers";

const RUN = Date.now().toString(36);
const HIDDEN = /^[a-z0-9_]+_[a-z0-9]{5}$/;

async function waitJob(app: App, admin: SeededUser, id: string): Promise<void> {
  for (let i = 0; i < 300; i++) {
    const { job } = await (await session(app, admin, `/api/jobs/${id}`)).json();
    if (job.status !== "queued" && job.status !== "running") return;
    await Bun.sleep(100);
  }
  throw new Error(`job ${id} did not finish`);
}

describe.skipIf(!mariadbAvailable())("ensure and schema names for tokens", () => {
  let instance: TestInstance;
  let app: App;
  let admin: SeededUser;
  let builder: { id: string; secret: string };

  beforeAll(async () => {
    instance = await startTestInstance();
    app = buildApp();
    admin = seedUser("admin");
    settings.set("setup_complete", "1");
    const b = await createToken(app, admin, { name: "Namer", preset: "builder", limits: { maxDatabases: 50 } });
    builder = { id: b.token.id, secret: b.secret };
  }, 180_000);

  afterAll(async () => {
    await instance?.stop();
  }, 120_000);

  beforeEach(() => resetAccessTokenRateLimits());

  function tokenCreate(secret: string, body: Record<string, unknown>): Promise<Response> {
    return withToken(app, secret, "/api/databases", { method: "POST", body });
  }

  test("a builder's schema always gets a random ending, so a hidden name cannot be detected", async () => {
    const name = `Customer Orders ${RUN}`;
    const first = await (await session(app, admin, "/api/databases", "POST", { displayName: name })).json();
    const base = first.database.name as string;
    expect(base).toBe(`customer_orders_${RUN}`);
    const second = await (await session(app, admin, "/api/databases", "POST", { displayName: name })).json();
    expect(second.database.name).toBe(`${base}_1`);

    const colliding = await (await tokenCreate(builder.secret, { displayName: name })).json();
    const fresh = await (await tokenCreate(builder.secret, { displayName: `Fresh ${RUN}` })).json();
    for (const made of [colliding, fresh]) {
      expect(made.database.name).toMatch(HIDDEN);
      expect(made.database.name).not.toMatch(/_\d+$/);
    }
    expect(colliding.database.name.startsWith(`${base}_`)).toBe(true);
    expect(fresh.database.name.startsWith(`fresh_${RUN}_`)).toBe(true);

    const again = await (await tokenCreate(builder.secret, { displayName: `fresh ${RUN}`, ensure: true })).json();
    expect(again).toMatchObject({ created: false, database: { id: fresh.database.id } });

    const adminToken = await createToken(app, admin, { name: "Wide admin", preset: "admin", askFirst: false });
    const wide = await (await tokenCreate(adminToken.secret, { displayName: `Wide ${RUN}` })).json();
    expect(wide.database.name).toBe(`wide_${RUN}`);
  }, 60_000);

  test("create from an upload also gets a random ending and never returns another database", async () => {
    const owned = await (await session(app, admin, "/api/databases", "POST", { displayName: `Imported ${RUN}` })).json();
    const upload = await app.request(
      "/api/imports/uploads",
      {
        method: "POST",
        headers: { Authorization: `Bearer ${builder.secret}`, "X-File-Name": "people.sql", "Content-Type": "application/octet-stream" },
        body: "CREATE TABLE people (id INT PRIMARY KEY);\nINSERT INTO people VALUES (1);\n",
      },
      LOOPBACK,
    );
    expect(upload.status).toBe(201);
    const { upload: up } = await upload.json();
    const res = await withToken(app, builder.secret, `/api/imports/uploads/${up.id}/create-database`, {
      method: "POST",
      body: { displayName: `Imported ${RUN}` },
    });
    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body.database.id).not.toBe(owned.database.id);
    expect(body.database.name).toMatch(HIDDEN);
    expect(body.database.createdByTokenId).toBe(builder.id);
    expect(body.credentials.user).not.toBe(owned.credentials.user);
    await waitJob(app, admin, body.job.id);
    const adminUpload = await app.request(
      "/api/imports/uploads",
      {
        method: "POST",
        headers: { ...(await authHeaders(admin)), "X-File-Name": "other.sql", "Content-Type": "application/octet-stream" },
        body: "CREATE TABLE other (id INT);\n",
      },
      LOOPBACK,
    );
    const { upload: theirs } = await adminUpload.json();
    const stolen = await withToken(app, builder.secret, `/api/imports/uploads/${theirs.id}/create-database`, {
      method: "POST",
      body: { displayName: `Stolen ${RUN}` },
    });
    expect(stolen.status).toBe(404);
    const replace = await withToken(app, builder.secret, `/api/databases/${owned.database.id}/imports`, {
      method: "POST",
      body: { uploadId: up.id },
    });
    expect(replace.status).toBe(404);
  }, 120_000);

  test("parallel ensure calls from one caller create exactly one database", async () => {
    const name = `Parallel ${RUN}`;
    const replies = await Promise.all(
      Array.from({ length: 8 }, () => tokenCreate(builder.secret, { displayName: name, ensure: true })),
    );
    const bodies = await Promise.all(replies.map((r) => r.json()));
    expect(replies.map((r) => r.status)).toEqual(Array(8).fill(200));
    expect(bodies.filter((b) => b.created === true)).toHaveLength(1);
    expect(new Set(bodies.map((b) => b.database.id)).size).toBe(1);
    const rows = db.query("SELECT COUNT(*) AS n FROM databases WHERE display_name = ?").get(name) as { n: number };
    expect(rows.n).toBe(1);

    const sessionName = `Parallel session ${RUN}`;
    const sessionReplies = await Promise.all(
      Array.from({ length: 8 }, () => session(app, admin, "/api/databases", "POST", { displayName: sessionName, ensure: true })),
    );
    const sessionBodies = await Promise.all(sessionReplies.map((r) => r.json()));
    expect(sessionBodies.filter((b) => b.created === true)).toHaveLength(1);
    expect(new Set(sessionBodies.map((b) => b.database.id)).size).toBe(1);
  }, 120_000);

  test("name variants never return a database the caller did not create", async () => {
    const long = `Ledger ${RUN} ${"x".repeat(180)}`;
    const trap = (await (await tokenCreate(builder.secret, { displayName: `Ledger ${RUN}` })).json()).database as Database;
    const longTrap = (await (await tokenCreate(builder.secret, { displayName: long })).json()).database as Database;
    const variants = [`  ledger ${RUN}  `, `LEDGER ${RUN.toUpperCase()}`, `Ledger  ${RUN}`, `Lеdger ${RUN}`, `\tLedger ${RUN}\n`];
    for (const variant of variants) {
      const res = await session(app, admin, "/api/databases", "POST", { displayName: variant, ensure: true });
      const body = await res.json();
      expect({ variant, returned: body.database?.id === trap.id }).toEqual({ variant, returned: false });
      if (res.status === 409) expect(body.error).toContain(trap.id);
    }
    const longRes = await session(app, admin, "/api/databases", "POST", { displayName: long.toUpperCase(), ensure: true });
    expect(longRes.status).toBe(409);
    expect((await longRes.json()).database).toBeUndefined();
    expect(longTrap.name.length).toBeLessThanOrEqual(64);
  }, 120_000);

  test("an admin token limited to some databases never receives one it did not create", async () => {
    const allowed = (await (await session(app, admin, "/api/databases", "POST", { displayName: `Allowed ${RUN}` })).json()).database as Database;
    const outside = (await (await tokenCreate(builder.secret, { displayName: `Outside ${RUN}` })).json()).database as Database;
    const limited = await createToken(app, admin, { name: "Limited admin", preset: "admin", askFirst: false, databaseIds: [allowed.id] });
    const own = await tokenCreate(limited.secret, { displayName: `Allowed ${RUN}`, ensure: true });
    expect(own.status).toBe(409);
    const ownBody = await own.json();
    expect(ownBody.database).toBeUndefined();
    expect(ownBody.error).toContain(allowed.id);
    expect(ownBody.error).toContain("did not create it");
    const other = await tokenCreate(limited.secret, { displayName: `Outside ${RUN}`, ensure: true });
    expect(other.status).toBe(403);
    const otherBody = await other.json();
    expect(otherBody.database).toBeUndefined();
    expect(otherBody.error).not.toContain(outside.id);
  }, 60_000);

  test("a paused or revoked builder's leftover database is not handed to an admin", async () => {
    const paused = await createToken(app, admin, { name: "Paused builder", preset: "builder" });
    const revoked = await createToken(app, admin, { name: "Revoked builder", preset: "builder" });
    const p = (await (await tokenCreate(paused.secret, { displayName: `Leftover P ${RUN}` })).json()).database as Database;
    const r = (await (await tokenCreate(revoked.secret, { displayName: `Leftover R ${RUN}` })).json()).database as Database;
    await session(app, admin, `/api/access-tokens/${paused.token.id}`, "PATCH", { paused: true });
    await session(app, admin, `/api/access-tokens/${revoked.token.id}`, "DELETE");
    for (const [name, id] of [[`Leftover P ${RUN}`, p.id], [`Leftover R ${RUN}`, r.id]] as const) {
      const res = await session(app, admin, "/api/databases", "POST", { displayName: name, ensure: true });
      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body.database).toBeUndefined();
      expect(body.error).toContain(id);
    }
  }, 60_000);

  test("a percent-encoded note with control characters and a secret is stored as one clean line", async () => {
    const secret = `ld_${"Zz9".repeat(15)}`;
    const raw = `first line\nsecond\tline\r\n\u0007bell ${secret} end`;
    const res = await withToken(app, builder.secret, "/api/databases", { headers: { "X-LambData-Note": encodeURIComponent(raw) } });
    expect(res.status).toBe(200);
    const { entries } = await (await session(app, admin, `/api/access-tokens/${builder.id}/activity?limit=1`)).json();
    expect(entries[0].note).toBe("first line second line bell ld_[hidden] end");
  });

  test("the connection field is there for the builder's own database and another's is 404", async () => {
    const mine = (await (await tokenCreate(builder.secret, { displayName: `Conn ${RUN}` })).json()).database as Database;
    const theirs = (await (await session(app, admin, "/api/databases", "POST", { displayName: `Conn other ${RUN}` })).json()).database as Database;
    const ok = await withToken(app, builder.secret, `/api/databases/${mine.id}`);
    expect(ok.status).toBe(200);
    const body = await ok.json();
    expect(body.connection).toMatchObject({ port: expect.any(Number), outsideConnections: expect.any(Boolean) });
    expect("password" in body.connection).toBe(false);
    const hidden = await withToken(app, builder.secret, `/api/databases/${theirs.id}`);
    expect(hidden.status).toBe(404);
    expect(JSON.stringify(await hidden.json())).not.toContain("connection");
  }, 60_000);
});
