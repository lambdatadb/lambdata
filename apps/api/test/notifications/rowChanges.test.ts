import { seedUser, useTempMetadata, type SeededUser, type TempMetadata } from "../harness/sqlite";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { Job, NotificationEventType, NotificationWebhookPayload, SyncChangeSummary, TableRowChange } from "@lambdata/shared";
import { savePublicUrls } from "../../src/network/config";
import { checkpoints, databases, users } from "../../src/db/queries";
import type { CheckpointEntryRecord } from "../../src/db/queries/checkpoints";
import { newId } from "../../src/util/id";
import { notificationsService } from "../../src/notifications/service";
import { notifyAudit } from "../../src/notifications/bus";
import { handleJobFinished } from "../../src/notifications/handlers";
import { catalog, defaultEventTypes } from "../../src/notifications/catalog";
import { createDestination, updateDestination } from "../../src/notifications/destinations";
import { actorLookup } from "../../src/notifications/emit";
import { clearNotifications, FakeDestination, installFakeNetwork, restoreFakeNetwork, routes, until } from "./helpers";

const HOSTILE = "@everyone [x](https://evil.example/y) <@1> riley@example.com";

function t(name: string, extra: Partial<TableRowChange>): TableRowChange {
  return {
    name,
    change: "modified",
    method: "exact",
    schemaChanged: false,
    rowsBefore: 10,
    rowsAfter: 10,
    added: 0,
    removed: 0,
    changed: 0,
    ...extra,
  };
}

function summary(tables: TableRowChange[], extra: Partial<SyncChangeSummary> = {}): SyncChangeSummary {
  return {
    tablesChanged: tables.length,
    tablesUnchanged: 0,
    exactTables: tables.filter((x) => x.method === "exact").length,
    netTables: tables.filter((x) => x.method === "net").length,
    rowsAdded: null,
    rowsRemoved: null,
    rowsChanged: null,
    rowDelta: 0,
    tables,
    truncated: false,
    ...extra,
  };
}

describe("row changes in notifications", () => {
  let meta: TempMetadata;
  let admin: SeededUser;
  let adminName: string;
  let hook: FakeDestination;
  let quiet: FakeDestination;
  let discord: FakeDestination;
  let databaseId: string;
  const originalToken = actorLookup.token;

  beforeAll(async () => {
    meta = useTempMetadata();
    installFakeNetwork();
    hook = new FakeDestination(4366);
    quiet = new FakeDestination(4367);
    discord = new FakeDestination(4368);
    routes.set("discord.com", { addresses: ["162.159.128.233"], port: 4368 });
    admin = seedUser("admin");
    adminName = users.byId(admin.id)!.displayName!;
    databaseId = newId("db");
    databases.insert({
      id: databaseId,
      name: "game_mirror",
      displayName: "Game mirror",
      ownerUserId: admin.id,
      kind: "mirror",
      mysqlUser: "u_game",
      mysqlPasswordEnc: "unused",
      connectionsFrom: "%",
      tailscaleExposed: false,
      lanExposed: false,
      versioned: true,
    });
    await notificationsService.start();
  });

  afterAll(async () => {
    await notificationsService.stop();
    for (const s of [hook, quiet, discord]) s?.stop();
    restoreFakeNetwork();
    meta?.cleanup();
  });

  beforeEach(() => {
    clearNotifications();
    for (const s of [hook, quiet, discord]) s.reset();
    savePublicUrls(["https://console.example.com"]);
  });

  afterEach(() => {
    actorLookup.token = originalToken;
  });

  async function webhook(server: FakeDestination, events: NotificationEventType[], skipUnchanged = false) {
    return createDestination({ kind: "webhook", name: `w${server.port}`, events, skipUnchanged, config: { url: server.url("/w") } }, admin.id);
  }

  function payloads(server: FakeDestination, type?: string): NotificationWebhookPayload[] {
    return server.requests.map((r) => JSON.parse(r.body) as NotificationWebhookPayload).filter((p) => !type || p.type === type);
  }

  function syncJob(result: Record<string, unknown>, extra: Partial<Job> = {}): Job {
    const now = Date.now();
    return {
      id: newId("job"),
      kind: "sync.run",
      databaseId,
      status: "succeeded",
      stage: null,
      progress: null,
      error: null,
      warnings: [],
      result: { status: "ok", tables: 129, outcome: "done", codeFailures: [], ...result },
      createdByUserId: null,
      createdAt: now,
      startedAt: now,
      finishedAt: now,
      ...extra,
    };
  }

  test("sync.finished says what changed, with exact and net tables, and carries the totals in data", async () => {
    await webhook(hook, ["sync.finished"]);
    const changes = summary(
      [
        t("matches", { rowsBefore: 9000, rowsAfter: 10_192, added: 1200, removed: 8, changed: 40 }),
        t("players", { method: "net", rowsBefore: 4310, rowsAfter: 5512, added: null, removed: null, changed: null, reason: "no-key" }),
        t("bans", { added: 4, removed: 4, changed: 0, schemaChanged: true }),
      ],
      { rowsAdded: 1204, rowsRemoved: 12, rowsChanged: 40, rowDelta: 2394, tablesUnchanged: 126 },
    );
    handleJobFinished(syncJob({ changes }, { createdByUserId: admin.id }));
    await until(() => hook.requests.length, 8000, "sync.finished");
    const p = payloads(hook)[0]!;
    expect(p.title).toBe("Sync finished: Game mirror");
    expect(p.message).toBe(
      `${adminName} synced Game mirror from its source and copied 129 tables. 3 tables changed: 1,204 rows added, 12 removed, 40 changed.` +
        "\n• matches: 1,200 added, 8 removed, 40 changed" +
        "\n• players: 4,310 → 5,512 rows" +
        "\n• bans: 4 added, 4 removed, 0 changed (structure changed)",
    );
    expect(p.data).toEqual({
      databaseId,
      tables: 129,
      outcome: "done",
      codeFailures: 0,
      jobId: expect.any(String),
      changesMeasured: true,
      tablesChanged: 3,
      tablesUnchanged: 126,
      rowsAdded: 1204,
      rowsRemoved: 12,
      rowsChanged: 40,
      rowDelta: 2394,
      tablesNotCompared: 0,
    });
    expect(p.changes!.truncated).toBe(false);
    expect(p.changes!.tables.map((x) => x.name)).toEqual(["matches", "players", "bans"]);
    expect(p.changes!.tables[1]).toMatchObject({ method: "net", rowsBefore: 4310, rowsAfter: 5512, added: null, reason: "no-key" });
  });

  test("only five tables are named, then 'and N more'; net-only totals read as a row difference", async () => {
    await webhook(hook, ["sync.finished"]);
    const tables = Array.from({ length: 8 }, (_, i) =>
      t(`t${i + 1}`, { method: "net", rowsBefore: 100, rowsAfter: 100 + (8 - i), added: null, removed: null, changed: null }),
    );
    handleJobFinished(syncJob({ changes: summary(tables, { rowDelta: 36 }) }));
    await until(() => hook.requests.length, 8000, "sync.finished");
    const p = payloads(hook)[0]!;
    const lines = p.message.split("\n");
    expect(lines[0]).toBe("Game mirror synced from its source and copied 129 tables. 8 tables changed: +36 rows in all.");
    expect(lines.slice(1, 6)).toEqual(["• t1: 100 → 108 rows", "• t2: 100 → 107 rows", "• t3: 100 → 106 rows", "• t4: 100 → 105 rows", "• t5: 100 → 104 rows"]);
    expect(lines[6]).toBe("and 3 more.");
    expect(lines).toHaveLength(7);

    hook.reset();
    const many = Array.from({ length: 60 }, (_, i) => t(`n${i}`, { change: "added", method: "net", rowsBefore: null, rowsAfter: 1, added: null, removed: null, changed: null }));
    handleJobFinished(syncJob({ changes: summary(many.slice(0, 50), { tablesChanged: 60, truncated: true, rowDelta: 60 }) }));
    await until(() => hook.requests.length, 8000, "sync.finished");
    const big = payloads(hook)[0]!;
    expect(big.message).toContain("\n• n0: new table, 1 row");
    expect(big.message.endsWith("\nand 55 more.")).toBe(true);
    expect(big.changes!.tables).toHaveLength(20);
    expect(big.changes!.truncated).toBe(true);
    expect(big.data).not.toHaveProperty("changedTables");
    expect(payloads(hook).every((x) => x.changes !== undefined)).toBe(true);
  });

  test("skipUnchanged drops a sync that changed nothing, and nothing else", async () => {
    await webhook(hook, ["sync.finished", "sync.failed"]);
    const skipper = await webhook(quiet, ["sync.finished", "sync.failed"], true);
    expect(skipper.skipUnchanged).toBe(true);

    handleJobFinished(syncJob({ changes: summary([], { tablesUnchanged: 129 }) }));
    await until(() => hook.requests.length, 8000, "unchanged sync");
    expect(payloads(hook)[0]!.message).toBe("Game mirror synced from its source and copied 129 tables. Nothing changed.");
    expect(payloads(hook)[0]!.data.tablesChanged).toBe(0);

    handleJobFinished(syncJob({ changes: summary([], { tablesUnchanged: 129 }), outcome: "done-with-errors", codeFailures: [{ kind: "VIEW", name: "v", error: "x" }] }));
    handleJobFinished(syncJob({ changes: null }));
    handleJobFinished(syncJob({ changes: summary([t("a", { added: 1 })], { rowsAdded: 1, rowsRemoved: 0, rowsChanged: 0, rowDelta: 1 }) }));
    handleJobFinished(syncJob({}, { status: "failed", result: null }));
    await until(() => quiet.requests.length >= 4, 8000, "quiet destination");
    await until(() => hook.requests.length >= 5, 8000, "loud destination");
    const got = payloads(quiet).map((p) => `${p.type}|${p.title}|${String(p.data.changesMeasured ?? "")}|${String(p.data.tablesChanged ?? "")}`);
    expect(got).toEqual([
      "sync.finished|Sync finished with errors: Game mirror|true|0",
      "sync.finished|Sync finished: Game mirror|false|",
      "sync.finished|Sync finished: Game mirror|true|1",
      "sync.failed|Sync failed: Game mirror||",
    ]);
    expect(payloads(quiet)[0]!.changes).toEqual({ tables: [], truncated: false });
    expect(payloads(quiet)[1]).not.toHaveProperty("changes");
    expect(payloads(quiet)[3]).not.toHaveProperty("changes");

    quiet.reset();
    hook.reset();
    handleJobFinished(syncJob({ changes: summary([], { tablesUnchanged: 117, tablesNotCompared: 12, rowDelta: null }) }));
    handleJobFinished(syncJob({ changes: summary([t("a", { added: 1 })], { rowsAdded: 1, rowsRemoved: 0, rowsChanged: 0, rowDelta: null, tablesNotCompared: 1 }) }));
    await until(() => quiet.requests.length >= 2, 8000, "partial comparisons reach a skipping destination");
    const [partial, partialChanged] = payloads(quiet);
    expect(partial!.message).toBe(
      "Game mirror synced from its source and copied 129 tables. No changes in the tables that were compared. 12 tables were not compared because the sync's time limit for comparing was reached.",
    );
    expect(partial!.data).toMatchObject({ tablesNotCompared: 12, rowDelta: null });
    expect(partialChanged!.message.endsWith("\n1 table was not compared because the sync's time limit for comparing was reached.")).toBe(true);

    const off = await updateDestination(skipper.id, { skipUnchanged: false });
    expect(off!.destination.skipUnchanged).toBe(false);
    quiet.reset();
    handleJobFinished(syncJob({ changes: summary([], { tablesUnchanged: 129 }) }));
    await until(() => quiet.requests.length, 8000, "after turning skip off");
    expect(payloads(quiet)[0]!.message).toContain("Nothing changed.");
  });

  function entries(rows: Record<string, number>, hashes: Record<string, string>): CheckpointEntryRecord[] {
    return Object.entries(rows).map(([name, rowCount]) => ({
      kind: "table",
      name,
      objectHash: hashes[name] ?? `h-${name}`,
      rowCount,
      logicalBytes: 10,
      storedBytes: 10,
      schemaHash: `s-${name}`,
      checksum: 1,
    }));
  }

  function checkpoint(parentId: string | null, list: CheckpointEntryRecord[], trigger: "sync" | "manual" = "sync"): string {
    const id = newId("cp");
    checkpoints.insert(
      {
        id,
        databaseId,
        hash: `${id}`.padEnd(40, "0").slice(0, 40),
        treeHash: null,
        parentId,
        message: trigger === "manual" ? "Before the season reset" : "Synced",
        trigger,
        format: "v1",
        createdByUserId: trigger === "manual" ? admin.id : null,
        createdAt: Date.now(),
        tableCount: list.length,
        rowCount: list.reduce((n, e) => n + (e.rowCount ?? 0), 0),
        logicalBytes: 10,
        storedBytes: 10,
        newBytes: 10,
      },
      list,
      false,
    );
    return id;
  }

  test("checkpoint events carry the net change since the previous checkpoint; an automatic one that saved nothing new is skipped", async () => {
    await webhook(hook, ["checkpoint.auto_created", "checkpoint.created"]);
    await webhook(quiet, ["checkpoint.auto_created", "checkpoint.created"], true);
    const startedAt = Date.now() - 1000;
    const first = checkpoint(null, entries({ players: 10, matches: 5 }, {}));
    const same = checkpoint(first, entries({ players: 10, matches: 5 }, {}));
    handleJobFinished(syncJob({ checkpointId: same, changes: summary([]) }, { createdAt: startedAt }));
    await until(() => payloads(hook, "checkpoint.auto_created").length, 8000, "auto checkpoint");
    const auto = payloads(hook, "checkpoint.auto_created")[0]!;
    const firstHash = checkpoints.byId(first)!.shortHash;
    expect(auto.message).toBe(`LambData recorded a checkpoint of Game mirror after syncing it. It holds 2 tables and 15 rows. Nothing changed since checkpoint ${firstHash}.`);
    expect(auto.data).toMatchObject({ tablesChanged: 0, rowDelta: 0, previousCheckpointId: first });
    expect(auto).not.toHaveProperty("changes");

    const changed = checkpoint(same, entries({ players: 15, matches: 5, bans: 2 }, { players: "h-players-2" }));
    handleJobFinished(syncJob({ checkpointId: changed, changes: summary([t("players", { added: 5 })]) }, { createdAt: startedAt }));
    await until(() => payloads(quiet, "checkpoint.auto_created").length, 8000, "changed auto checkpoint");
    const sameHash = checkpoints.byId(same)!.shortHash;
    expect(payloads(quiet, "checkpoint.auto_created")[0]!.message).toContain(`Since checkpoint ${sameHash}: 2 tables changed, +7 rows.`);
    expect(payloads(quiet, "checkpoint.auto_created")).toHaveLength(1);

    const manual = checkpoint(changed, entries({ players: 15, matches: 4, bans: 2 }, { players: "h-players-2", matches: "h-matches-2" }), "manual");
    notifyAudit(admin.id, "checkpoint.create", databaseId, { checkpointId: manual, unchanged: false, verified: false });
    await until(() => payloads(hook, "checkpoint.created").length, 8000, "manual checkpoint");
    const made = payloads(hook, "checkpoint.created")[0]!;
    expect(made.message).toBe(`${adminName} made a checkpoint of Game mirror. It holds 3 tables and 21 rows. Since checkpoint ${checkpoints.byId(changed)!.shortHash}: 1 table changed, -1 row.`);
    expect(made.data).toMatchObject({ tablesChanged: 1, rowDelta: -1 });
  });

  test("the access token group and its three events are in the catalog with the right defaults", () => {
    const c = catalog();
    expect(c.groups.find((g) => g.group === "agents")).toEqual({ group: "agents", label: "Access tokens" });
    const byType = new Map(c.events.map((e) => [e.type, e]));
    expect(byType.get("token.created")).toMatchObject({ group: "agents", defaultOn: false });
    expect(byType.get("token.revoked")).toMatchObject({ group: "agents", defaultOn: false });
    expect(byType.get("approval.requested")).toMatchObject({ group: "agents", defaultOn: true, severity: "warning" });
    const defaults = defaultEventTypes();
    expect(defaults).toContain("approval.requested");
    expect(defaults).not.toContain("token.created");
    expect(defaults).not.toContain("token.revoked");
  });

  test("token created, token revoked and approval requested map from the audit log", async () => {
    await webhook(hook, ["token.created", "token.revoked", "approval.requested"]);
    const tokenUser = newId("u");
    actorLookup.token = (id) => (id === tokenUser ? { id: "tok_build", name: "Build bot" } : null);
    notifyAudit(admin.id, "access_token.create", "tok_build", { name: "Build bot", preset: "builder" });
    notifyAudit(admin.id, "access_token.revoke", "tok_build", { name: "Build bot" });
    notifyAudit(tokenUser, "approval.request", "apr_1", {
      tokenId: "tok_build",
      tokenName: "Build bot",
      action: "database.delete",
      summary: "Delete the database Game mirror",
      databaseId,
    });
    notifyAudit(admin.id, "access_token.update", "tok_build", { name: "x" });
    await until(() => hook.requests.length >= 3, 8000, "token events");
    await Bun.sleep(100);
    const [created, revoked, approval] = payloads(hook);
    expect(hook.requests).toHaveLength(3);
    expect(created).toMatchObject({ type: "token.created", group: "agents", title: "Access token created: Build bot", link: "https://console.example.com/access-tokens/tok_build" });
    expect(created!.message).toBe(`${adminName} created the access token Build bot with the Builder preset. Whatever holds it can now use the management API within what that allows.`);
    expect(revoked).toMatchObject({ type: "token.revoked", title: "Access token revoked: Build bot", severity: "warning" });
    expect(revoked!.message).toContain(`${adminName} revoked the access token Build bot.`);
    expect(approval).toMatchObject({
      type: "approval.requested",
      severity: "warning",
      title: "Approval needed: Delete the database Game mirror",
      link: "https://console.example.com/access-tokens/approvals",
      actor: { displayName: "Build bot (access token)" },
    });
    expect(approval!.message).toBe(
      "Build bot (access token) is waiting for approval to do this: Delete the database Game mirror (database Game mirror). Nothing happens until an admin approves or declines it in the console.",
    );
    expect(approval!.data).toMatchObject({ approvalId: "apr_1", tokenId: "tok_build", action: "database.delete", databaseId });
    for (const p of [created, revoked, approval]) expect(p).not.toHaveProperty("changes");
  });

  test("an event done by an access token names the token, not a person", async () => {
    await webhook(hook, ["sync.finished"]);
    const tokenUser = newId("u");
    actorLookup.token = (id) => (id === tokenUser ? { id: "tok_ci", name: "CI deploy" } : null);
    handleJobFinished(syncJob({ changes: summary([]) }, { createdByUserId: tokenUser }));
    await until(() => hook.requests.length, 8000, "token sync");
    const p = payloads(hook)[0]!;
    expect(p.actor).toEqual({ displayName: "CI deploy (access token)" });
    expect(p.message).toBe("CI deploy (access token) synced Game mirror from its source and copied 129 tables. Nothing changed.");
    actorLookup.token = () => {
      throw new Error("lookup broke");
    };
    hook.reset();
    handleJobFinished(syncJob({ changes: summary([]) }, { createdByUserId: admin.id }));
    await until(() => hook.requests.length, 8000, "fallback actor");
    expect(payloads(hook)[0]!.actor).toEqual({ displayName: adminName });
  });

  test("table and token names are user text: no pings, links, formatting or email addresses", async () => {
    await createDestination({ kind: "discord", name: "D", events: ["sync.finished", "approval.requested"], config: { url: "https://discord.com/api/webhooks/1/1" } }, admin.id);
    await webhook(hook, ["sync.finished", "approval.requested"]);
    const tokenUser = newId("u");
    actorLookup.token = (id) => (id === tokenUser ? { id: "tok_x", name: HOSTILE } : null);
    handleJobFinished(
      syncJob({ changes: summary([t(HOSTILE, { added: 1 }), t(`${"z".repeat(300)}\n\u0000tail`, { method: "net", added: null, removed: null, changed: null, rowsAfter: 11 })]) }),
    );
    notifyAudit(tokenUser, "approval.request", "apr_2", { tokenId: "tok_x", tokenName: HOSTILE, action: "x", summary: HOSTILE, databaseId: null });
    await until(() => discord.requests.length >= 2 && hook.requests.length >= 2, 8000, "hostile events");
    for (const r of discord.requests) {
      const body = JSON.parse(r.body) as { allowed_mentions: unknown; embeds: { title: string; description: string; fields: { value: string }[] }[] };
      expect(body.allowed_mentions).toEqual({ parse: [] });
      const e = body.embeds[0]!;
      for (const text of [e.title, e.description, ...e.fields.map((f) => f.value)]) {
        expect(text).not.toMatch(/@everyone|@here/);
        expect(text).not.toContain("](");
        expect(text).not.toContain("<@1>");
        expect(text).not.toContain("https://evil");
        expect(text).not.toContain("riley@example.com");
      }
    }
    const sync = payloads(hook, "sync.finished")[0]!;
    expect(sync.message).toContain("[email]");
    expect(sync.message).not.toContain("riley@example.com");
    expect(sync.message).not.toMatch(/[\u0000]/);
    const longLine = sync.message.split("\n").find((l) => l.startsWith("• zzz"))!;
    expect(longLine.length).toBeLessThan(100);
    expect(JSON.stringify(sync.changes)).not.toContain("riley@example.com");
    expect(sync.changes!.tables[0]!.name).toContain("[email]");
    expect(sync.changes!.tables[1]!.name.length).toBeLessThanOrEqual(64);
    expect(sync.changes!.tables[1]!.name).not.toMatch(/[\u0000\n]/);
    const approval = payloads(hook, "approval.requested")[0]!;
    expect(approval.title.length).toBeLessThanOrEqual("Approval needed: ".length + 150);
    expect(approval.actor!.displayName).not.toContain("riley@example.com");
  });
});
