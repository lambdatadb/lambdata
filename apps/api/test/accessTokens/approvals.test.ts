import { mariadbAvailable, startTestInstance, type TestInstance } from "../harness/instance";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { Approval, Database } from "@lambdata/shared";
import { seedUser, type SeededUser } from "../harness/sqlite";
import { buildApp } from "../../src/server";
import { audit, settings } from "../../src/db/queries";
import { db } from "../../src/db/client";
import { startJob } from "../../src/jobs";
import { resetAccessTokenRateLimits } from "../../src/accessTokens/gate";
import { createToken, session, withToken, type App } from "./helpers";

const RUN = Date.now().toString(36);

async function waitJob(app: App, admin: SeededUser, id: string): Promise<{ status: string; error: string | null }> {
  for (let i = 0; i < 300; i++) {
    const { job } = await (await session(app, admin, `/api/jobs/${id}`)).json();
    if (job.status !== "queued" && job.status !== "running") return job;
    await Bun.sleep(100);
  }
  throw new Error(`job ${id} did not finish`);
}

describe.skipIf(!mariadbAvailable())("ask first, undo points and the row cap", () => {
  let instance: TestInstance;
  let app: App;
  let admin: SeededUser;
  let asker: { id: string; secret: string };
  let builder: { id: string; secret: string };
  let target: Database;

  beforeAll(async () => {
    instance = await startTestInstance();
    app = buildApp();
    admin = seedUser("admin");
    settings.set("setup_complete", "1");
    const a = await createToken(app, admin, { name: "Careful agent", preset: "admin" });
    expect(a.token.askFirst).toBe(true);
    asker = { id: a.token.id, secret: a.secret };
    const b = await createToken(app, admin, { name: "Fast builder", preset: "builder" });
    builder = { id: b.token.id, secret: b.secret };
    const made = await withToken(app, asker.secret, "/api/databases", { method: "POST", body: { displayName: `Orders ${RUN}` } });
    expect(made.status).toBe(200);
    target = (await made.json()).database;
    const table = await withToken(app, asker.secret, `/api/databases/${target.id}/query`, {
      method: "POST",
      body: { sql: "CREATE TABLE a (id INT PRIMARY KEY)" },
    });
    expect(table.status).toBe(200);
    for (const name of ["b", "c", "d"]) {
      await withToken(app, asker.secret, `/api/databases/${target.id}/query`, { method: "POST", body: { sql: `CREATE TABLE ${name} (id INT)` } });
    }
  }, 180_000);

  afterAll(async () => {
    await instance?.stop();
  }, 120_000);

  beforeEach(() => resetAccessTokenRateLimits());

  function sql(secret: string, dbId: string, statement: string, headers: Record<string, string> = {}, extra: Record<string, unknown> = {}) {
    return withToken(app, secret, `/api/databases/${dbId}/query`, { method: "POST", body: { sql: statement, ...extra }, headers });
  }

  async function decide(id: string, decision: "approve" | "deny"): Promise<Response> {
    return session(app, admin, `/api/approvals/${id}/decision`, "POST", { decision });
  }

  test("a destructive statement waits for a person and the same request returns the same approval", async () => {
    const first = await sql(asker.secret, target.id, "DROP TABLE a", { "X-LambData-Note": "cleaning up the test table" });
    expect(first.status).toBe(403);
    const body = await first.json();
    expect(body.code).toBe("approval_required");
    const approval: Approval = body.approval;
    expect(approval).toMatchObject({
      tokenId: asker.id,
      tokenName: "Careful agent",
      action: "sql.destructive",
      status: "pending",
      databaseId: target.id,
      databaseName: target.displayName,
      note: "cleaning up the test table",
      approvedUntil: null,
    });
    expect(approval.summary).toBe(`Run a DROP statement on ${target.displayName}.`);
    expect(approval.detail).toBe("DROP TABLE a");
    expect(approval.expiresAt - approval.requestedAt).toBe(24 * 60 * 60 * 1000);
    const again = await (await sql(asker.secret, target.id, "DROP TABLE a")).json();
    expect(again.approval.id).toBe(approval.id);
    const waiting = await (await sql(asker.secret, target.id, "DROP TABLE a", { "X-LambData-Approval": approval.id })).json();
    expect(waiting.code).toBe("approval_required");

    const entry = audit.list(30).find((e) => e.action === "approval.request" && e.target === approval.id)!;
    expect(JSON.parse(entry.details!)).toEqual({
      tokenId: asker.id,
      tokenName: "Careful agent",
      action: "sql.destructive",
      summary: approval.summary,
      databaseId: target.id,
    });
    expect(entry.actor_kind).toBe("token");

    const activity = await (await session(app, admin, `/api/access-tokens/${asker.id}/activity?limit=5`)).json();
    expect(activity.entries[0]).toMatchObject({ outcome: "waiting-approval", status: 403, action: "sql.run" });
    const listed = await (await session(app, admin, `/api/access-tokens/${asker.id}`)).json();
    expect(listed.token.pendingApprovals).toBe(1);

    const pending = await (await session(app, admin, "/api/approvals?status=pending")).json();
    expect(pending.pending).toBe(1);
    expect(pending.approvals.map((a: Approval) => a.id)).toEqual([approval.id]);
    expect(JSON.stringify(pending)).not.toContain("bodyHash");

    const mine = await (await withToken(app, asker.secret, "/api/approvals")).json();
    expect(mine.approvals.map((a: Approval) => a.id)).toEqual([approval.id]);
    expect((await withToken(app, builder.secret, "/api/approvals")).status).toBe(200);
    expect((await (await withToken(app, builder.secret, "/api/approvals")).json()).approvals).toEqual([]);
    expect((await withToken(app, builder.secret, `/api/approvals/${approval.id}`)).status).toBe(404);
    expect((await withToken(app, asker.secret, `/api/approvals/${approval.id}`)).status).toBe(200);

    const tokenDecides = await withToken(app, asker.secret, `/api/approvals/${approval.id}/decision`, { method: "POST", body: { decision: "approve" } });
    expect(tokenDecides.status).toBe(403);
    const viewer = seedUser("viewer");
    expect((await session(app, viewer, `/api/approvals/${approval.id}/decision`, "POST", { decision: "approve" })).status).toBe(403);
    expect((await session(app, viewer, "/api/approvals")).status).toBe(403);

    const approved = await decide(approval.id, "approve");
    expect(approved.status).toBe(200);
    const decided = (await approved.json()).approval as Approval;
    expect(decided.status).toBe("approved");
    expect(decided.approvedUntil).toBe(decided.decidedAt! + 60 * 60 * 1000);
    const decideAudit = audit.list(10).find((e) => e.action === "approval.decide" && e.target === approval.id)!;
    expect(JSON.parse(decideAudit.details!)).toEqual({ tokenId: asker.id, tokenName: "Careful agent", action: "sql.destructive", status: "approved" });
    const twice = await decide(approval.id, "deny");
    expect(twice.status).toBe(409);
    expect((await twice.json()).error).toContain("already approved");

    const otherBody = await sql(asker.secret, target.id, "DROP TABLE b", { "X-LambData-Approval": approval.id });
    expect(otherBody.status).toBe(403);
    expect((await otherBody.json()).error).toContain("different request");
    const otherPath = await withToken(app, asker.secret, `/api/databases/${target.id}`, { method: "DELETE", headers: { "X-LambData-Approval": approval.id } });
    expect(otherPath.status).toBe(403);
    expect((await otherPath.json()).error).toContain("different request");
    const otherToken = await createToken(app, admin, { name: "Thief", preset: "admin" });
    const stolen = await sql(otherToken.secret, target.id, "DROP TABLE a", { "X-LambData-Approval": approval.id });
    expect(stolen.status).toBe(403);
    expect((await stolen.json()).error).toContain("belongs to this access token");

    const used = await sql(asker.secret, target.id, "DROP TABLE a", { "X-LambData-Approval": approval.id });
    expect(used.status).toBe(200);
    const replay = await sql(asker.secret, target.id, "DROP TABLE a", { "X-LambData-Approval": approval.id });
    expect(replay.status).toBe(403);
    expect((await replay.json()).error).toContain("already used");
    const final = await (await withToken(app, asker.secret, `/api/approvals/${approval.id}`)).json();
    expect(final.approval.status).toBe("used");
    expect(final.approval.usedAt).toBeGreaterThan(0);
  }, 60_000);

  test("non-destructive SQL from an ask first token runs at once", async () => {
    const res = await sql(asker.secret, target.id, "INSERT INTO b VALUES (1)");
    expect(res.status).toBe(200);
    const tricky = await sql(asker.secret, target.id, "/* note */ -- comment\n (TRUNCATE TABLE b)");
    expect(tricky.status).toBe(403);
    expect((await tricky.json()).approval.summary).toContain("TRUNCATE");
    const hidden = await sql(asker.secret, target.id, "/*!50000 DROP TABLE c */");
    expect(hidden.status).toBe(403);
  });

  test("deny, cancel and expiry", async () => {
    const denied = (await (await sql(asker.secret, target.id, "DROP TABLE c")).json()).approval as Approval;
    await decide(denied.id, "deny");
    const afterDeny = await sql(asker.secret, target.id, "DROP TABLE c", { "X-LambData-Approval": denied.id });
    expect(afterDeny.status).toBe(403);
    expect((await afterDeny.json()).error).toContain("denied");

    const cancelled = (await (await sql(asker.secret, target.id, "DROP TABLE d")).json()).approval as Approval;
    expect((await session(app, admin, `/api/approvals/${cancelled.id}`, "DELETE")).status).toBe(403);
    const cancel = await withToken(app, asker.secret, `/api/approvals/${cancelled.id}`, { method: "DELETE" });
    expect(cancel.status).toBe(200);
    expect((await cancel.json()).approval.status).toBe("cancelled");
    const late = await decide(cancelled.id, "approve");
    expect(late.status).toBe(409);
    expect((await late.json()).error).toContain("cancelled");

    const stale = (await (await sql(asker.secret, target.id, "TRUNCATE TABLE d")).json()).approval as Approval;
    db.query("UPDATE access_token_approvals SET expires_at = ? WHERE id = ?").run(Date.now() - 1, stale.id);
    const expiredDecision = await decide(stale.id, "approve");
    expect(expiredDecision.status).toBe(409);
    expect((await expiredDecision.json()).error).toContain("expired");

    const window = (await (await sql(asker.secret, target.id, "TRUNCATE TABLE c")).json()).approval as Approval;
    await decide(window.id, "approve");
    db.query("UPDATE access_token_approvals SET approved_until = ? WHERE id = ?").run(Date.now() - 1, window.id);
    const tooLate = await sql(asker.secret, target.id, "TRUNCATE TABLE c", { "X-LambData-Approval": window.id });
    expect(tooLate.status).toBe(403);
    expect((await tooLate.json()).error).toContain("expired");
  }, 60_000);

  test("deleting a database and rolling back ask first, then go through once approved", async () => {
    const made = await withToken(app, asker.secret, "/api/databases", { method: "POST", body: { displayName: `Scratch ${RUN}` } });
    const scratch = (await made.json()).database as Database;
    const asked = await withToken(app, asker.secret, `/api/databases/${scratch.id}`, { method: "DELETE" });
    expect(asked.status).toBe(403);
    const approval = (await asked.json()).approval as Approval;
    expect(approval).toMatchObject({ action: "database.delete", summary: `Delete the database ${scratch.displayName}.` });
    await decide(approval.id, "approve");
    const gone = await withToken(app, asker.secret, `/api/databases/${scratch.id}`, { method: "DELETE", headers: { "X-LambData-Approval": approval.id } });
    expect(gone.status).toBe(200);

    const missing = await withToken(app, asker.secret, `/api/databases/${scratch.id}`, { method: "DELETE" });
    expect(missing.status).toBe(404);

    const cp = await withToken(app, asker.secret, `/api/databases/${target.id}/checkpoints`, { method: "POST", body: { message: "manual" } });
    expect(cp.status).toBe(202);
    const job = await waitJob(app, admin, (await cp.json()).job.id);
    expect(job.status).toBe("succeeded");
    const list = await (await withToken(app, asker.secret, `/api/databases/${target.id}/checkpoints`)).json();
    const manual = list.checkpoints.find((c: { trigger: string }) => c.trigger === "manual");
    const rollback = await withToken(app, asker.secret, `/api/databases/${target.id}/checkpoints/${manual.id}/restore`, { method: "POST", body: {} });
    expect(rollback.status).toBe(403);
    const rb = (await rollback.json()).approval as Approval;
    expect(rb).toMatchObject({ action: "checkpoint.rollback", summary: `Roll ${target.displayName} back to checkpoint ${manual.shortHash}.` });
    const del = await withToken(app, asker.secret, `/api/databases/${target.id}/checkpoints/${manual.id}`, { method: "DELETE" });
    expect(del.status).toBe(403);
    expect((await del.json()).approval.action).toBe("checkpoint.delete");
  }, 120_000);

  test("a token without ask first is not stopped", async () => {
    const made = await withToken(app, builder.secret, "/api/databases", { method: "POST", body: { displayName: `Plain ${RUN}` } });
    const plain = (await made.json()).database as Database;
    expect((await sql(builder.secret, plain.id, "CREATE TABLE x (id INT)")).status).toBe(200);
    const drop = await sql(builder.secret, plain.id, "DROP TABLE x");
    expect(drop.status).toBe(200);
    const res = await drop.json();
    expect(res).toMatchObject({ versioned: false, undo: null, truncated: false, maxRows: 500 });
  }, 60_000);

  test("undo points are saved once per window and roll back through the normal job", async () => {
    const made = await withToken(app, builder.secret, "/api/databases", {
      method: "POST",
      body: { displayName: `Versioned ${RUN}`, versioned: true },
    });
    const v = (await made.json()).database as Database;
    expect(v.versioned).toBe(true);
    const first = await (await sql(builder.secret, v.id, "CREATE TABLE notes (id INT PRIMARY KEY, body VARCHAR(20))")).json();
    expect(first.versioned).toBe(true);
    expect(first.undo.createdNow).toBe(true);
    const second = await (await sql(builder.secret, v.id, "INSERT INTO notes VALUES (1, 'one')")).json();
    expect(second.undo).toEqual({ ...first.undo, createdNow: false });
    const read = await (await sql(builder.secret, v.id, "SELECT * FROM notes")).json();
    expect(read.undo).toEqual({ ...first.undo, createdNow: false });
    const preAgent = db.query("SELECT COUNT(*) AS n FROM checkpoints WHERE database_id = ? AND trigger = 'pre-agent'").get(v.id) as { n: number };
    expect(preAgent.n).toBe(1);
    const cpRow = db.query("SELECT message FROM checkpoints WHERE id = ?").get(first.undo.checkpointId) as { message: string };
    expect(cpRow.message).toBe("Before changes by Fast builder");

    db.query("UPDATE access_token_undo_points SET last_change_at = ? WHERE token_id = ? AND database_id = ?").run(
      Date.now() - 31 * 60 * 1000,
      builder.id,
      v.id,
    );
    const quietRead = await (await sql(builder.secret, v.id, "SELECT 1")).json();
    expect(quietRead.undo).toBeNull();
    const later = await (await sql(builder.secret, v.id, "INSERT INTO notes VALUES (2, 'two')")).json();
    expect(later.undo.createdNow).toBe(true);
    expect(later.undo.checkpointId).not.toBe(first.undo.checkpointId);

    const undo = await (await withToken(app, builder.secret, `/api/databases/${v.id}/undo`)).json();
    expect(undo).toMatchObject({ versioned: true, undo: { checkpointId: later.undo.checkpointId, tokenId: builder.id, tokenName: "Fast builder" } });
    await sql(builder.secret, v.id, "INSERT INTO notes VALUES (3, 'three')");
    const rolled = await withToken(app, builder.secret, `/api/databases/${v.id}/undo`, { method: "POST", body: {} });
    expect(rolled.status).toBe(202);
    const job = await waitJob(app, admin, (await rolled.json()).job.id);
    expect(job.status).toBe("succeeded");
    const rows = await (await sql(builder.secret, v.id, "SELECT id FROM notes ORDER BY id")).json();
    expect(rows.rows).toEqual([[1]]);

    const askUndo = await withToken(app, asker.secret, `/api/databases/${v.id}/undo`, { method: "POST", body: {} });
    expect(askUndo.status).toBe(404);
    expect((await withToken(app, builder.secret, `/api/databases/${target.id}/undo`)).status).toBe(404);
  }, 180_000);

  test("an undo point that equals the last checkpoint is reused instead of saved again", async () => {
    const made = await withToken(app, builder.secret, "/api/databases", {
      method: "POST",
      body: { displayName: `Clean ${RUN}`, versioned: true },
    });
    const v = (await made.json()).database as Database;
    const cp = await withToken(app, builder.secret, `/api/databases/${v.id}/checkpoints`, { method: "POST", body: { message: "start" } });
    const job = await waitJob(app, admin, (await cp.json()).job.id);
    expect(job.status).toBe("succeeded");
    const base = (db.query("SELECT base_checkpoint_id AS id FROM databases WHERE id = ?").get(v.id) as { id: string }).id;
    const change = await (await sql(builder.secret, v.id, "CREATE TABLE t (id INT)")).json();
    expect(change.undo).toMatchObject({ checkpointId: base, createdNow: false });
    const preAgent = db.query("SELECT COUNT(*) AS n FROM checkpoints WHERE database_id = ? AND trigger = 'pre-agent'").get(v.id) as { n: number };
    expect(preAgent.n).toBe(0);
  }, 120_000);

  test("a change is refused when its undo point cannot be saved", async () => {
    const made = await withToken(app, builder.secret, "/api/databases", {
      method: "POST",
      body: { displayName: `Busy ${RUN}`, versioned: true },
    });
    const v = (await made.json()).database as Database;
    let release!: () => void;
    const held = new Promise<void>((r) => {
      release = r;
    });
    const busy = startJob({ kind: "checkpoint.create", databaseId: v.id, userId: admin.id }, async () => {
      await held;
      return { checkpointId: null, unchanged: true };
    });
    try {
      const refused = await sql(builder.secret, v.id, "CREATE TABLE never (id INT)");
      expect(refused.status).toBe(409);
      expect((await refused.json()).error).toContain("undo point could not be saved");
    } finally {
      release();
    }
    await waitJob(app, admin, busy.id);
    const tables = await (await sql(builder.secret, v.id, "SHOW TABLES")).json();
    expect(tables.rows).toEqual([]);
  }, 60_000);

  test("token SQL results are capped", async () => {
    const made = await withToken(app, builder.secret, "/api/databases", { method: "POST", body: { displayName: `Rows ${RUN}` } });
    const r = (await made.json()).database as Database;
    await sql(builder.secret, r.id, "CREATE TABLE n (v INT)");
    const filled = await sql(
      builder.secret,
      r.id,
      "INSERT INTO n SELECT x FROM (WITH RECURSIVE s(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM s WHERE x < 600) SELECT x FROM s) q",
    );
    expect(filled.status).toBe(200);
    const capped = await (await sql(builder.secret, r.id, "SELECT v FROM n ORDER BY v")).json();
    expect(capped).toMatchObject({ truncated: true, maxRows: 500, rowCount: 600 });
    expect(capped.rows).toHaveLength(500);
    const small = await (await sql(builder.secret, r.id, "SELECT v FROM n", {}, { maxRows: 10 })).json();
    expect(small.rows).toHaveLength(10);
    const all = await (await sql(builder.secret, r.id, "SELECT v FROM n", {}, { maxRows: 5000 })).json();
    expect(all).toMatchObject({ truncated: false, maxRows: 5000 });
    expect(all.rows).toHaveLength(600);
    expect((await sql(builder.secret, r.id, "SELECT v FROM n", {}, { maxRows: 5001 })).status).toBe(400);
    const console = await (await session(app, admin, `/api/databases/${r.id}/query`, "POST", { sql: "SELECT v FROM n" })).json();
    expect(console.rows).toHaveLength(600);
    expect(console.truncated).toBeUndefined();
  }, 60_000);
});
