import { mariadbAvailable, startTestInstance, type TestInstance } from "../harness/instance";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "@lambdata/shared";
import { authHeaders, seedUser, type SeededUser } from "../harness/sqlite";
import { buildApp } from "../../src/server";
import { env } from "../../src/env";
import { audit, settings } from "../../src/db/queries";
import { resetAccessTokenRateLimits } from "../../src/accessTokens/gate";
import { LOOPBACK, createToken, session, withToken, type App } from "./helpers";
import { callTool } from "../mcp/helpers";

const RUN = Date.now().toString(36);

async function waitJob(app: App, admin: SeededUser, id: string): Promise<void> {
  for (let i = 0; i < 200; i++) {
    const res = await session(app, admin, `/api/jobs/${id}`);
    const { job } = await res.json();
    if (job.status !== "queued" && job.status !== "running") return;
    await Bun.sleep(100);
  }
  throw new Error(`job ${id} did not finish`);
}

describe.skipIf(!mariadbAvailable())("access token database scope", () => {
  let instance: TestInstance;
  let app: App;
  let admin: SeededUser;
  let owner: SeededUser;
  let other: Database;
  let otherJobId: string;
  let builder: { id: string; secret: string };
  let mine: Database;

  beforeAll(async () => {
    instance = await startTestInstance();
    app = buildApp();
    admin = seedUser("admin");
    owner = seedUser("db_owner");
    settings.set("setup_complete", "1");
    const created = await session(app, admin, "/api/databases", "POST", { displayName: `Ledger ${RUN}` });
    expect(created.status).toBe(200);
    other = (await created.json()).database;
    const cp = await session(app, admin, `/api/databases/${other.id}/checkpoints`, "POST", { message: "first" });
    expect(cp.status).toBe(202);
    otherJobId = (await cp.json()).job.id;
    await waitJob(app, admin, otherJobId);
    const made = await createToken(app, admin, { name: "Builder bot", preset: "builder", limits: { maxDatabases: 2 } });
    builder = { id: made.token.id, secret: made.secret };
  }, 180_000);

  afterAll(async () => {
    await instance?.stop();
  }, 120_000);

  beforeEach(() => resetAccessTokenRateLimits());

  test("ensure creates once and then returns the same database", async () => {
    const first = await withToken(app, builder.secret, "/api/databases", {
      method: "POST",
      body: { displayName: `Shop ${RUN}`, ensure: true },
    });
    expect(first.status).toBe(200);
    const a = await first.json();
    expect(a.created).toBe(true);
    expect(a.credentials?.password).toBeTruthy();
    expect(a.database.createdByTokenId).toBe(builder.id);
    expect(a.database.createdByTokenName).toBe("Builder bot");
    mine = a.database;
    const again = await withToken(app, builder.secret, "/api/databases", {
      method: "POST",
      body: { displayName: `  shop ${RUN.toUpperCase()} `, ensure: true },
    });
    expect(again.status).toBe(200);
    const b = await again.json();
    expect(b).toMatchObject({ created: false, credentials: null });
    expect(b.database.id).toBe(mine.id);
    const tokenEntry = audit.list(20).find((e) => e.action === "db.create" && e.target === mine.id)!;
    expect(tokenEntry).toMatchObject({ actor_kind: "token", token_id: builder.id, user_display_name: "Builder bot", user_email: null });
  }, 60_000);

  test("ensure on a name the caller cannot manage", async () => {
    const asOwner = await session(app, owner, "/api/databases", "POST", { displayName: `Ledger ${RUN}`, ensure: true });
    expect(asOwner.status).toBe(409);
    expect((await asOwner.json()).error).toContain("Choose another name");
    const asAdmin = await session(app, admin, "/api/databases", "POST", { displayName: `ledger ${RUN}`, ensure: true });
    expect(asAdmin.status).toBe(200);
    expect((await asAdmin.json()).created).toBe(false);
    const asBuilder = await withToken(app, builder.secret, "/api/databases", {
      method: "POST",
      body: { displayName: `Ledger ${RUN}`, ensure: true },
    });
    expect(asBuilder.status).toBe(200);
    const body = await asBuilder.json();
    expect(body.created).toBe(true);
    expect(body.database.id).not.toBe(other.id);
  }, 60_000);

  test("ensure never hands a caller a database someone else created", async () => {
    const squatter = await createToken(app, admin, { name: "Squatter", preset: "builder" });
    const name = `Customer Orders ${RUN}`;
    const squat = await withToken(app, squatter.secret, "/api/databases", { method: "POST", body: { displayName: name, ensure: true } });
    expect(squat.status).toBe(200);
    const trap = (await squat.json()).database as Database;

    const adminToken = await createToken(app, admin, { name: "Ops admin", preset: "admin", askFirst: false });
    const viaToken = await withToken(app, adminToken.secret, "/api/databases", {
      method: "POST",
      body: { displayName: name.toLowerCase(), ensure: true },
    });
    expect(viaToken.status).toBe(409);
    const tokenBody = await viaToken.json();
    expect(tokenBody.database).toBeUndefined();
    expect(tokenBody.error).toContain(trap.id);
    expect(tokenBody.error).toContain("the access token “Squatter”");
    expect(tokenBody.error).toContain("It was not returned because this access token did not create it.");
    expect(tokenBody.error).not.toContain("use it directly");

    const viaSession = await session(app, admin, "/api/databases", "POST", { displayName: `  ${name.toUpperCase()} `, ensure: true });
    expect(viaSession.status).toBe(409);
    const sessionBody = await viaSession.json();
    expect(sessionBody.database).toBeUndefined();
    expect(sessionBody.error).toContain("use it directly by its id");
    expect(sessionBody.error).toContain(trap.id);

    const ownMade = await withToken(app, adminToken.secret, "/api/databases", { method: "POST", body: { displayName: `Ops ${RUN}`, ensure: true } });
    const own = (await ownMade.json()).database as Database;
    const ownAgain = await withToken(app, adminToken.secret, "/api/databases", { method: "POST", body: { displayName: `ops ${RUN}`, ensure: true } });
    expect(await ownAgain.json()).toMatchObject({ created: false, database: { id: own.id } });
    const sessionMeetsToken = await session(app, admin, "/api/databases", "POST", { displayName: `Ops ${RUN}`, ensure: true });
    expect(sessionMeetsToken.status).toBe(409);
    expect((await sessionMeetsToken.json()).error).toContain("the access token “Ops admin”");

    const colleague = seedUser("admin");
    const theirs = await session(app, colleague, "/api/databases", "POST", { displayName: `Colleague ${RUN}` });
    const theirDb = (await theirs.json()).database as Database;
    const meetsPerson = await session(app, admin, "/api/databases", "POST", { displayName: `Colleague ${RUN}`, ensure: true });
    expect(meetsPerson.status).toBe(409);
    const personMessage = (await meetsPerson.json()).error;
    expect(personMessage).toContain(theirDb.id);
    expect(personMessage).toMatch(/created by admin \d+\./);
    const tokenMeetsPerson = await withToken(app, adminToken.secret, "/api/databases", {
      method: "POST",
      body: { displayName: `Colleague ${RUN}`, ensure: true },
    });
    expect(tokenMeetsPerson.status).toBe(409);
    const colleagueAgain = await session(app, colleague, "/api/databases", "POST", { displayName: `Colleague ${RUN}`, ensure: true });
    expect(await colleagueAgain.json()).toMatchObject({ created: false, database: { id: theirDb.id } });

    const mcp = await callTool(app, adminToken.secret, "ensure_database", { name });
    expect(mcp.isError).toBe(true);
    expect(mcp.text).toContain(trap.id);
    expect(mcp.text).toContain("this access token did not create it");

    const plain = await withToken(app, adminToken.secret, "/api/databases", { method: "POST", body: { displayName: name } });
    expect(plain.status).toBe(200);
    const plainDb = (await plain.json()).database as Database;
    expect(plainDb.id).not.toBe(trap.id);
    const ensuredOwn = await withToken(app, adminToken.secret, "/api/databases", { method: "POST", body: { displayName: name, ensure: true } });
    expect(await ensuredOwn.json()).toMatchObject({ created: false, database: { id: plainDb.id } });

    const hidden = await withToken(app, squatter.secret, "/api/databases", { method: "POST", body: { displayName: `Ops ${RUN}`, ensure: true } });
    expect(hidden.status).toBe(200);
    const hiddenBody = await hidden.json();
    expect(hiddenBody.created).toBe(true);
    expect(hiddenBody.database.id).not.toBe(own.id);

  }, 120_000);

  test("maxDatabases counts the databases the token created", async () => {
    const over = await withToken(app, builder.secret, "/api/databases", { method: "POST", body: { displayName: `Third ${RUN}` } });
    expect(over.status).toBe(403);
    expect((await over.json()).error).toContain("limit of 2 databases");
    const again = await withToken(app, builder.secret, "/api/databases", {
      method: "POST",
      body: { displayName: `Shop ${RUN}`, ensure: true },
    });
    expect(again.status).toBe(200);
    expect((await again.json()).created).toBe(false);
  });

  test("database details carry connection facts and never a password", async () => {
    const before = env.mariadbBind;
    try {
      env.mariadbBind = "127.0.0.1";
      const closed = await (await withToken(app, builder.secret, `/api/databases/${mine.id}`)).json();
      expect(closed.connection).toEqual({ host: null, port: env.mariadbPort, outsideConnections: false });
      env.mariadbBind = "192.168.1.50";
      const res = await withToken(app, builder.secret, `/api/databases/${mine.id}`);
      const open = await res.json();
      expect(open.connection).toEqual({ host: "192.168.1.50", port: env.mariadbPort, outsideConnections: true });
      const creds = await (await withToken(app, builder.secret, `/api/databases/${mine.id}/credentials`)).json();
      expect(creds.credentials.host).toBe(open.connection.host);
      expect(JSON.stringify(open)).not.toContain(creds.credentials.password);
      env.mariadbBind = "0.0.0.0";
      const wildcard = await (await session(app, admin, `/api/databases/${mine.id}`)).json();
      expect(wildcard.connection).toEqual({ host: null, port: env.mariadbPort, outsideConnections: true });
      const { secret } = await createToken(app, admin, { name: "Reader conn", preset: "read_only" });
      expect((await (await withToken(app, secret, `/api/databases/${mine.id}`)).json()).connection.outsideConnections).toBe(true);
    } finally {
      env.mariadbBind = before;
    }
  });

  test("a builder cannot see, read or change a database it did not create", async () => {
    const list = await (await withToken(app, builder.secret, "/api/databases")).json();
    const ids = list.databases.map((d: Database) => d.id);
    expect(ids).toContain(mine.id);
    expect(ids).not.toContain(other.id);
    const probes: [string, string, unknown?][] = [
      ["GET", `/api/databases/${other.id}`],
      ["PATCH", `/api/databases/${other.id}`, { displayName: "mine now" }],
      ["DELETE", `/api/databases/${other.id}`],
      ["GET", `/api/databases/${other.id}/credentials`],
      ["POST", `/api/databases/${other.id}/rotate-password`, {}],
      ["POST", `/api/databases/${other.id}/query`, { sql: "SELECT 1" }],
      ["GET", `/api/databases/${other.id}/metrics`],
      ["GET", `/api/databases/${other.id}/tables`],
      ["GET", `/api/databases/${other.id}/checkpoints`],
      ["GET", `/api/databases/${other.id}/checkpoints/status`],
      ["POST", `/api/databases/${other.id}/checkpoints`, {}],
      ["PUT", `/api/databases/${other.id}/checkpoints/policy`, { autoRetention: 3 }],
      ["GET", `/api/databases/${other.id}/sync`],
      ["GET", `/api/databases/${other.id}/imports`],
      ["GET", `/api/databases/${other.id}/set-aside`],
      ["GET", `/api/jobs?databaseId=${other.id}`],
      ["GET", `/api/jobs/${otherJobId}`],
      ["GET", `/api/data-access/${other.name}`],
      ["PUT", `/api/data-access/${other.name}`, { mode: "open" }],
      ["GET", `/api/data-policies/${other.name}`],
      ["GET", `/api/data-docs/${other.name}/schema`],
      ["GET", `/api/data-docs/${other.name}/openapi.json`],
    ];
    for (const [method, path, body] of probes) {
      const res = await withToken(app, builder.secret, path, { method, body });
      const text = await res.text();
      expect({ path, method, status: res.status }).toEqual({ path, method, status: 404 });
      expect(text).not.toContain(other.name);
      expect(text).not.toContain("Ledger");
    }
    const jobs = await (await withToken(app, builder.secret, "/api/jobs")).json();
    expect(jobs.jobs.some((j: { databaseId: string | null }) => j.databaseId === other.id)).toBe(false);
    const own = await withToken(app, builder.secret, `/api/databases/${mine.id}/query`, {
      method: "POST",
      body: { sql: "CREATE TABLE items (id INT PRIMARY KEY, label VARCHAR(20))" },
    });
    expect(own.status).toBe(200);
    const cross = await withToken(app, builder.secret, `/api/databases/${mine.id}/query`, {
      method: "POST",
      body: { sql: `SELECT * FROM \`${other.name}\`.information_schema_probe` },
    });
    expect(cross.status).toBe(400);
    const schemas = await withToken(app, builder.secret, `/api/databases/${mine.id}/query`, {
      method: "POST",
      body: { sql: "SHOW DATABASES" },
    });
    expect(JSON.stringify(await schemas.json())).not.toContain(other.name);
  }, 120_000);

  test("uploads belong to the token that sent them", async () => {
    const sent = await app.request(
      "/api/imports/uploads",
      {
        method: "POST",
        headers: { ...(await authHeaders(admin)), "X-File-Name": "people.sql", "Content-Type": "application/octet-stream" },
        body: "CREATE TABLE people (id INT PRIMARY KEY);\n",
      },
      LOOPBACK,
    );
    expect(sent.status).toBe(201);
    const { upload } = await sent.json();
    for (const [method, path, body] of [
      ["GET", `/api/imports/uploads/${upload.id}`, undefined],
      ["GET", `/api/imports/uploads/${upload.id}/plan`, undefined],
      ["DELETE", `/api/imports/uploads/${upload.id}`, undefined],
      ["POST", `/api/imports/uploads/${upload.id}/create-database`, { displayName: "stolen" }],
    ] as const) {
      const res = await withToken(app, builder.secret, path, { method, body });
      expect({ path, status: res.status }).toEqual({ path, status: 404 });
    }
    const { secret } = await createToken(app, admin, { name: "Importer", preset: "admin", askFirst: false });
    const replace = await withToken(app, secret, `/api/databases/${other.id}/imports`, { method: "POST", body: { uploadId: upload.id } });
    expect(replace.status).toBe(404);
    expect((await session(app, admin, `/api/imports/uploads/${upload.id}`)).status).toBe(200);
  }, 60_000);

  test("activity records the database by name, the statement and the real outcome", async () => {
    const secretLike = `ld_${"Q".repeat(40)}`;
    const statement = `SELECT 'x'\t\t, '${secretLike}' AS k, '${"y".repeat(400)}'`;
    const ran = await withToken(app, builder.secret, `/api/databases/${mine.id}/query`, { method: "POST", body: { sql: statement } });
    expect(ran.status).toBe(200);
    const missingDelete = await withToken(app, builder.secret, "/api/databases/db_does_not_exist", { method: "DELETE" });
    expect(missingDelete.status).toBe(404);
    const res = await session(app, admin, `/api/access-tokens/${builder.id}/activity?limit=200`);
    const { entries } = await res.json();
    const sql = entries.find((e: { action: string; status: number }) => e.action === "sql.run" && e.status === 200);
    expect(sql).toMatchObject({ databaseId: mine.id, databaseName: mine.displayName, summary: `Ran SQL on ${mine.displayName}.` });
    expect(sql.detail.startsWith("SELECT 'x' , 'ld_[hidden]' AS k, 'yyy")).toBe(true);
    expect([...sql.detail].length).toBe(300);
    expect(sql.detail).not.toContain(secretLike);
    expect(sql.detail).not.toMatch(/[\u0000-\u001f]/);
    const del = entries.find((e: { action: string; status: number }) => e.action === "database.delete" && e.status === 404);
    expect(del.summary).toBe("Tried to delete a database.");
    const creates = entries.filter((e: { action: string; status: number }) => e.action === "database.create" && e.status === 200);
    const summaries = creates.map((e: { summary: string }) => e.summary);
    expect(summaries).toContain(`Created database Shop ${RUN}.`);
    expect(summaries).toContain(`Found the existing database Shop ${RUN}.`);
    expect(summaries.filter((t: string) => t === `Created database Shop ${RUN}.`)).toHaveLength(1);
    const over = entries.find((e: { action: string; status: number }) => e.action === "database.create" && e.status === 403);
    expect(over.summary).toBe("Tried to create a database.");
    const refused = entries.find((e: { status: number; databaseId: string | null }) => e.status === 404 && e.databaseId === other.id);
    expect(refused.databaseName).toBeNull();
    expect(refused.summary.startsWith("Tried to")).toBe(true);
  });

  test("a read only token reads everything and changes nothing", async () => {
    const { secret } = await createToken(app, admin, { name: "Reader", preset: "read_only" });
    const list = await (await withToken(app, secret, "/api/databases")).json();
    expect(list.databases.map((d: Database) => d.id)).toEqual(expect.arrayContaining([mine.id, other.id]));
    const read = await withToken(app, secret, `/api/databases/${mine.id}/query`, { method: "POST", body: { sql: "SELECT COUNT(*) FROM items" } });
    expect(read.status).toBe(200);
    const write = await withToken(app, secret, `/api/databases/${mine.id}/query`, { method: "POST", body: { sql: "INSERT INTO items VALUES (1, 'x')" } });
    expect(write.status).toBe(403);
    expect((await write.json()).error).toBe("This access token is read only, so it can only run queries that read data.");
    const del = await withToken(app, secret, `/api/databases/${mine.id}/query`, { method: "POST", body: { sql: "DELETE FROM items" } });
    expect((await del.json()).error).toBe("This access token is read only, so it can only run queries that read data.");
    const locking = await withToken(app, secret, `/api/databases/${mine.id}/query`, { method: "POST", body: { sql: "SELECT * FROM items FOR UPDATE" } });
    expect((await locking.json()).error).toContain("This access token is read only, so it cannot run locking reads");
    const viewer = seedUser("viewer");
    const console = await session(app, viewer, `/api/databases/${mine.id}/query`, "POST", { sql: "DELETE FROM items" });
    expect((await console.json()).error).toBe("viewers may only run read-only queries");
    expect((await withToken(app, secret, "/api/databases", { method: "POST", body: { displayName: "nope" } })).status).toBe(403);
    expect((await withToken(app, secret, `/api/databases/${mine.id}/credentials`)).status).toBe(403);
    expect((await withToken(app, secret, `/api/databases/${mine.id}`, { method: "DELETE" })).status).toBe(403);
    expect((await withToken(app, secret, `/api/databases/${mine.id}/checkpoints`)).status).toBe(200);
  }, 60_000);

  test("an admin token limited to some databases sees only those and cannot create", async () => {
    const { secret } = await createToken(app, admin, { name: "Scoped admin", preset: "admin", databaseIds: [other.id] });
    const list = await (await withToken(app, secret, "/api/databases")).json();
    expect(list.databases.map((d: Database) => d.id)).toEqual([other.id]);
    expect((await withToken(app, secret, `/api/databases/${mine.id}`)).status).toBe(404);
    expect((await withToken(app, secret, `/api/databases/${other.id}`)).status).toBe(200);
    expect((await withToken(app, secret, `/api/jobs/${otherJobId}`)).status).toBe(200);
    const jobs = await (await withToken(app, secret, "/api/jobs")).json();
    expect(jobs.jobs.every((j: { databaseId: string | null }) => j.databaseId === other.id)).toBe(true);
    const create = await withToken(app, secret, "/api/databases", { method: "POST", body: { displayName: `Scoped ${RUN}` } });
    expect(create.status).toBe(403);
    expect((await create.json()).error).toContain("limited to particular databases");
  }, 60_000);

  test("credentials appear only when the token may see them", async () => {
    const { secret } = await createToken(app, admin, { name: "Quiet admin", preset: "admin", askFirst: false });
    const made = await withToken(app, secret, "/api/databases", { method: "POST", body: { displayName: `Quiet ${RUN}` } });
    expect(made.status).toBe(200);
    const body = await made.json();
    expect(body.credentials).toBeNull();
    expect((await withToken(app, secret, `/api/databases/${body.database.id}/credentials`)).status).toBe(403);
    expect((await withToken(app, secret, `/api/databases/${body.database.id}/rotate-password`, { method: "POST", body: {} })).status).toBe(403);
    const shown = await withToken(app, builder.secret, `/api/databases/${mine.id}/credentials`);
    expect(shown.status).toBe(200);
    expect((await shown.json()).credentials.user).toBe(mine.mysqlUser);
    const del = await withToken(app, secret, `/api/databases/${body.database.id}`, { method: "DELETE" });
    expect(del.status).toBe(200);
  }, 60_000);
});
