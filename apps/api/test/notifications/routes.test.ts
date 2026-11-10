import { authHeaders, seedUser, useTempMetadata, type SeededUser, type TempMetadata } from "../harness/sqlite";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type {
  NotificationCatalogResponse,
  NotificationDeliveryListResponse,
  NotificationDestination,
  NotificationDestinationListResponse,
  NotificationDestinationResponse,
  NotificationTestResponse,
} from "@lambdata/shared";
import { buildApp } from "../../src/server";
import { db } from "../../src/db/client";
import { notificationDeliveries } from "../../src/db/queries/notifications";
import { notificationsService } from "../../src/notifications/service";
import { DEFAULT_ICON_URL } from "../../src/notifications/catalog";
import { clearNotifications, deliveryRows, FakeDestination, installFakeNetwork, json, OWN_API_PORT, restoreFakeNetwork, routes, until } from "./helpers";

describe("notification routes", () => {
  let meta: TempMetadata;
  let app: ReturnType<typeof buildApp>;
  let admin: SeededUser;
  let owner: SeededUser;
  let viewer: SeededUser;
  let hook: FakeDestination;
  let other: FakeDestination;
  const bodies: string[] = [];

  async function call(method: string, path: string, body?: unknown, who: SeededUser = admin): Promise<Response> {
    const res = await app.request(path, {
      method,
      headers: await authHeaders(who, { "Content-Type": "application/json" }),
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const copy = res.clone();
    bodies.push(await copy.text());
    return res;
  }

  async function create(body: Record<string, unknown>): Promise<NotificationDestination> {
    return (await json<NotificationDestinationResponse>(await call("POST", "/api/notifications/destinations", body), 201)).destination;
  }

  async function refused(body: Record<string, unknown>): Promise<string> {
    const res = await call("POST", "/api/notifications/destinations", body);
    const text = await res.text();
    expect(res.status).toBe(400);
    return (JSON.parse(text) as { error: string }).error;
  }

  function webhook(url: string, extra: Record<string, unknown> = {}) {
    return { kind: "webhook", name: "Hook", events: ["user.created"], config: { url, ...extra } };
  }

  beforeAll(async () => {
    meta = useTempMetadata();
    installFakeNetwork();
    hook = new FakeDestination(4368);
    other = new FakeDestination(4369);
    routes.set("discord.com", { addresses: ["162.159.128.233"], port: 4366 });
    routes.set("metadata.example", { addresses: ["169.254.169.254"] });
    routes.set("lan-box.example", { addresses: ["192.168.1.40"] });
    routes.set("public.example", { addresses: ["203.0.113.5"] });
    app = buildApp();
    admin = seedUser("admin");
    owner = seedUser("db_owner");
    viewer = seedUser("viewer");
    await notificationsService.start();
  });

  afterAll(async () => {
    await notificationsService.stop();
    hook?.stop();
    other?.stop();
    restoreFakeNetwork();
    meta?.cleanup();
  });

  beforeEach(() => {
    clearNotifications();
    hook.reset();
    other.reset();
  });

  test("the catalog lists every group and event with defaults and the default icon", async () => {
    const res = await json<NotificationCatalogResponse>(await call("GET", "/api/notifications/events"));
    expect(res.groups.map((g) => g.group)).toEqual(["databases", "checkpoints", "mirrors", "imports", "access", "health"]);
    expect(res.events).toHaveLength(25);
    expect(res.events.filter((e) => !e.defaultOn).map((e) => e.type).sort()).toEqual(["checkpoint.auto_created", "disk.recovered", "sync.finished"]);
    expect(res.defaultIconUrl).toBe(DEFAULT_ICON_URL);
    for (const e of res.events) {
      expect(e.label.length).toBeGreaterThan(0);
      expect(e.description.length).toBeGreaterThan(0);
      expect(["info", "success", "warning", "error"]).toContain(e.severity);
      expect(res.groups.some((g) => g.group === e.group)).toBe(true);
    }
    expect(res.events.find((e) => e.type === "sync.finished")!.description).toContain("every five minutes");
    expect(res.events.find((e) => e.type === "user.created")!.perDatabase).toBe(false);
    expect(res.events.find((e) => e.type === "database.created")!.perDatabase).toBe(true);
  });

  test("only admins can see or manage destinations", async () => {
    for (const who of [owner, viewer]) {
      expect((await call("GET", "/api/notifications/destinations", undefined, who)).status).toBe(403);
      expect((await call("GET", "/api/notifications/events", undefined, who)).status).toBe(403);
      expect((await call("POST", "/api/notifications/destinations", webhook(hook.url()), who)).status).toBe(403);
    }
    expect((await app.request("/api/notifications/destinations")).status).toBe(401);
  });

  test("create, read, update and delete a destination; the target is masked", async () => {
    const created = await create({
      kind: "discord",
      name: "Ops channel",
      events: ["database.created", "database.created", "checkpoint.created"],
      config: { url: "https://discord.com/api/webhooks/1122334455/AbCdEfGh-Wxyz" },
    });
    expect(created).toMatchObject({
      name: "Ops channel",
      kind: "discord",
      enabled: true,
      target: "discord.com/…Wxyz",
      hasSecret: false,
      headerNames: [],
      ntfyPriority: null,
      events: ["database.created", "checkpoint.created"],
      databaseIds: null,
      iconUrl: null,
      health: "new",
      lastSuccessAt: null,
      lastFailureAt: null,
      lastError: null,
      consecutiveFailures: 0,
      createdByUserId: admin.id,
    });
    const list = await json<NotificationDestinationListResponse>(await call("GET", "/api/notifications/destinations"));
    expect(list.destinations.map((d) => d.id)).toEqual([created.id]);
    const one = await json<NotificationDestinationResponse>(await call("GET", `/api/notifications/destinations/${created.id}`));
    expect(one.destination.id).toBe(created.id);

    const patched = await json<NotificationDestinationResponse>(
      await call("PATCH", `/api/notifications/destinations/${created.id}`, { name: "Renamed", enabled: false, events: ["user.created"] }),
    );
    expect(patched.destination).toMatchObject({ name: "Renamed", enabled: false, events: ["user.created"], target: "discord.com/…Wxyz" });
    const moved = await json<NotificationDestinationResponse>(
      await call("PATCH", `/api/notifications/destinations/${created.id}`, { config: { url: "https://discordapp.com/api/webhooks/9/zz-Q1w2" } }),
    );
    expect(moved.destination.target).toBe("discordapp.com/…Q1w2");

    const ntfy = await create({ kind: "ntfy", name: "Phone", events: [], config: { topic: "abcdef-secret-topic", token: "tk_1", priority: 4 } });
    expect(ntfy).toMatchObject({ target: "ntfy.sh/ab…", hasSecret: true, ntfyPriority: 4 });
    const slack = await create({ kind: "slack", name: "LAN Mattermost", events: [], enabled: false, config: { url: "http://192.168.1.20:8065/hooks/abc123" } });
    expect(slack.target).toBe("192.168.1.20:8065/…c123");
    const hookDest = await create(webhook(hook.url("/api/webhook/abc"), { secret: "s3cr3t", headers: { Authorization: "Bearer x", "X-Env": "lab" } }));
    expect(hookDest).toMatchObject({ target: "http://127.0.0.1:4368", hasSecret: true, headerNames: ["Authorization", "X-Env"] });

    const del = await call("DELETE", `/api/notifications/destinations/${created.id}`);
    expect(del.status).toBe(204);
    expect((await call("GET", `/api/notifications/destinations/${created.id}`)).status).toBe(404);
    expect((await call("DELETE", `/api/notifications/destinations/${created.id}`)).status).toBe(404);
    expect((await call("PATCH", `/api/notifications/destinations/nd_missing`, { name: "x" })).status).toBe(404);
  });

  test("webhook secret and headers: null clears, omitted keeps, an empty header value keeps the stored one", async () => {
    const d = await create(webhook(hook.url("/keep"), { secret: "first-secret", headers: { "X-Token": "hv-1" } }));
    const keep = await json<NotificationDestinationResponse>(
      await call("PATCH", `/api/notifications/destinations/${d.id}`, { config: { url: hook.url("/moved") } }),
    );
    expect(keep.destination).toMatchObject({ hasSecret: true, headerNames: ["X-Token"] });
    const addOne = await json<NotificationDestinationResponse>(
      await call("PATCH", `/api/notifications/destinations/${d.id}`, { config: { headers: { "X-Token": "", "X-Extra": "e" } } }),
    );
    expect(addOne.destination.headerNames).toEqual(["X-Token", "X-Extra"]);
    await json<NotificationTestResponse>(await call("POST", `/api/notifications/destinations/${d.id}/test`));
    expect(hook.requests[0]!.path).toBe("/moved");
    expect(hook.requests[0]!.headers["x-token"]).toBe("hv-1");
    expect(hook.requests[0]!.headers["x-extra"]).toBe("e");
    expect(hook.requests[0]!.headers["x-lambdata-signature"]).toMatch(/^sha256=[0-9a-f]{64}$/);
    const cleared = await json<NotificationDestinationResponse>(
      await call("PATCH", `/api/notifications/destinations/${d.id}`, { config: { secret: null, headers: {} } }),
    );
    expect(cleared.destination).toMatchObject({ hasSecret: false, headerNames: [] });
    await json<NotificationTestResponse>(await call("POST", `/api/notifications/destinations/${d.id}/test`));
    expect(hook.requests[1]!.headers["x-lambdata-signature"]).toBeUndefined();
    expect(hook.requests[1]!.headers["x-token"]).toBeUndefined();
    expect((await call("PATCH", `/api/notifications/destinations/${d.id}`, { config: { topic: "nope" } })).status).toBe(400);
    expect((await call("PATCH", `/api/notifications/destinations/${d.id}`, { config: { headers: { "X-New": "" } } })).status).toBe(400);
  });

  test("validation refuses bad kinds, URLs, headers, icons and databases", async () => {
    expect(await refused({ kind: "teams", name: "x", events: [], config: { url: hook.url() } })).toMatch(/invalid/);
    expect(await refused({ kind: "discord", name: "x", events: [], config: { url: "https://example.com/api/webhooks/1/2" } })).toMatch(/Discord/);
    expect(await refused({ kind: "discord", name: "x", events: [], config: { url: "http://discord.com/api/webhooks/1/2" } })).toMatch(/Discord/);
    expect(await refused({ kind: "discord", name: "x", events: [], config: { url: "https://discord.com/channels/1/2" } })).toMatch(/Discord/);
    expect(await refused({ kind: "slack", name: "x", events: [], config: { url: "http://public.example/hooks/1" } })).toMatch(/https/);
    expect(await refused({ kind: "slack", name: "x", events: [], config: { url: "http://hooks.unknown.example/x" } })).toMatch(/https/);
    const lan = await create({ kind: "slack", name: "LAN", enabled: false, events: [], config: { url: "http://lan-box.example/hooks/x" } });
    expect(lan.target).toBe("lan-box.example/…ks/x");
    expect(await refused({ kind: "ntfy", name: "x", events: [], config: { topic: "has spaces" } })).toMatch(/topic/);
    expect(await refused({ kind: "ntfy", name: "x", events: [], config: { topic: "ok", server: "https://ntfy.example/?q=1" } })).toMatch(/query/);
    expect(await refused({ kind: "ntfy", name: "x", events: [], config: { topic: "ok", priority: 9 } })).toMatch(/invalid/);
    expect(await refused({ ...webhook(hook.url()), name: "" })).toMatch(/name/);
    expect(await refused({ ...webhook(hook.url()), events: ["database.exploded"] })).toMatch(/invalid/);
    expect(await refused({ ...webhook(hook.url()), iconUrl: "http://cdn.example/icon.png" })).toMatch(/https/);
    expect(await refused({ ...webhook(hook.url()), databaseIds: ["db_missing"] })).toMatch(/unknown database/);
    expect(await refused(webhook("ftp://files.example/x"))).toMatch(/http/);
    expect(await refused(webhook("http://user:pw@127.0.0.1:4368/x"))).toMatch(/user name or password/);
    expect(await refused(webhook("not a url"))).toMatch(/not a valid/);
    const eleven = Object.fromEntries(Array.from({ length: 11 }, (_, i) => [`X-H${i}`, "v"]));
    expect(await refused(webhook(hook.url(), { headers: eleven }))).toMatch(/at most 10/);
    for (const name of ["Host", "content-length", "Content-Type", "X-LambData-Event", "x-lambdata-anything", "User-Agent", "Bad Name", ""]) {
      expect(await refused(webhook(hook.url(), { headers: { [name]: "v" } }))).toMatch(/header/i);
    }
    expect(await refused(webhook(hook.url(), { headers: { "X-Ok": "line\nbreak" } }))).toMatch(/not allowed/);
    expect(await refused({ ...webhook(hook.url()), config: { url: hook.url(), extra: 1 } })).toMatch(/invalid/);
  });

  test("refused addresses: link-local, metadata, unspecified, multicast and the API's own port", async () => {
    const bad = [
      "http://169.254.169.254/latest/meta-data",
      "http://[fe80::1]/x",
      "http://0.0.0.0:8080/x",
      "http://[::]/x",
      "http://224.0.0.1/x",
      "http://[ff02::1]/x",
      "http://[::ffff:169.254.169.254]/x",
      "http://[64:ff9b::a9fe:a9fe]/x",
      "http://100.100.100.200/x",
      `http://127.0.0.1:${OWN_API_PORT}/api/health`,
      `http://localhost:${OWN_API_PORT}/x`,
      `http://[::1]:${OWN_API_PORT}/x`,
      "http://metadata.example/x",
    ];
    for (const url of bad) expect(await refused(webhook(url))).toMatch(/not allowed|own API port/);
    expect(await refused({ kind: "ntfy", name: "n", events: [], config: { topic: "t", server: "http://169.254.1.1" } })).toMatch(/not allowed/);
    for (const url of ["http://127.0.0.1:4368/ok", "http://192.168.1.40:8123/api/webhook/x", "http://10.0.0.5/x", "http://100.101.102.103/x"]) {
      await create({ ...webhook(url), enabled: false });
    }
  });

  test("the test endpoint sends one labelled message, records it, and never returns the response body", async () => {
    const d = await create({ ...webhook(hook.url("/t")), enabled: false });
    hook.reset(() => new Response("ok", { status: 200 }));
    const ok = await json<NotificationTestResponse>(await call("POST", `/api/notifications/destinations/${d.id}/test`));
    expect(ok).toMatchObject({ ok: true, responseStatus: 200, error: null });
    expect(ok.durationMs).toBeGreaterThanOrEqual(0);
    expect(hook.requests).toHaveLength(1);
    expect(hook.requests[0]!.headers["x-lambdata-event"]).toBe("test");
    const body = JSON.parse(hook.requests[0]!.body);
    expect(body).toMatchObject({ type: "test", group: "test", title: "Test message from LambData" });

    hook.reset(() => new Response("SECRET-BODY-DETAIL leaking internal stuff", { status: 500, statusText: "Kaboom SECRET-REASON" }));
    const failed = await json<NotificationTestResponse>(await call("POST", `/api/notifications/destinations/${d.id}/test`));
    expect(failed).toMatchObject({ ok: false, responseStatus: 500, error: "HTTP 500 Internal Server Error" });
    expect(JSON.stringify(failed)).not.toContain("SECRET");

    const list = await json<NotificationDeliveryListResponse>(await call("GET", `/api/notifications/destinations/${d.id}/deliveries`));
    expect(list.deliveries.map((x) => [x.eventType, x.status, x.responseStatus])).toEqual([
      ["test", "failed", 500],
      ["test", "sent", 200],
    ]);
    expect(JSON.stringify(list)).not.toContain("SECRET");
    const after = await json<NotificationDestinationResponse>(await call("GET", `/api/notifications/destinations/${d.id}`));
    expect(after.destination.lastError).toBe("HTTP 500 Internal Server Error");
    expect((await call("POST", "/api/notifications/destinations/nd_missing/test")).status).toBe(404);
  });

  test("redirects are not followed", async () => {
    const d = await create(webhook(hook.url("/redirect")));
    hook.reset((req) =>
      new URL(req.url).pathname === "/redirect"
        ? new Response(null, { status: 302, headers: { Location: other.url("/elsewhere") } })
        : new Response("ok"),
    );
    const res = await json<NotificationTestResponse>(await call("POST", `/api/notifications/destinations/${d.id}/test`));
    expect(res.ok).toBe(false);
    expect(res.responseStatus).toBe(302);
    expect(res.error).toContain("redirect not followed");
    await Bun.sleep(100);
    expect(other.requests).toHaveLength(0);
  });

  test("an address that resolves to a refused range at send time is not contacted", async () => {
    let flip = false;
    routes.set("rebind.example", { addresses: () => (flip ? ["169.254.169.254"] : ["127.0.0.1"]), port: 4368 });
    const d = await create(webhook("http://rebind.example:4368/rebind"));
    flip = true;
    const res = await json<NotificationTestResponse>(await call("POST", `/api/notifications/destinations/${d.id}/test`));
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/^refused: /);
    expect(res.error).toContain("link-local");
    expect(res.error).not.toContain("rebind.example");
    expect(hook.requests).toHaveLength(0);
  });

  test("deliveries are listed newest first with a limit of at most 100", async () => {
    const d = await create(webhook(hook.url("/many")));
    for (let i = 0; i < 5; i++) {
      notificationDeliveries.insertFinished({
        id: `ndl_${i}`,
        destinationId: d.id,
        eventType: "user.created",
        title: `Event ${i}`,
        payload: "{}",
        createdAt: Date.now() - (5 - i) * 1000,
        status: "sent",
        attempts: 1,
        responseStatus: 200,
        lastError: null,
        sentAt: Date.now(),
      });
    }
    const all = await json<NotificationDeliveryListResponse>(await call("GET", `/api/notifications/destinations/${d.id}/deliveries`));
    expect(all.deliveries.map((x) => x.title)).toEqual(["Event 4", "Event 3", "Event 2", "Event 1", "Event 0"]);
    const two = await json<NotificationDeliveryListResponse>(await call("GET", `/api/notifications/destinations/${d.id}/deliveries?limit=2`));
    expect(two.deliveries).toHaveLength(2);
    expect(Object.keys(two.deliveries[0]!).sort()).toEqual(
      ["attempts", "createdAt", "destinationId", "eventType", "id", "lastError", "nextAttemptAt", "responseStatus", "sentAt", "status", "title"].sort(),
    );
    expect((await call("GET", `/api/notifications/destinations/${d.id}/deliveries?limit=101`)).status).toBe(400);
    expect((await call("GET", `/api/notifications/destinations/nd_missing/deliveries`)).status).toBe(404);
    expect((await call("DELETE", `/api/notifications/destinations/${d.id}`)).status).toBe(204);
    expect(deliveryRows(d.id)).toHaveLength(0);
  });

  test("own audit entries carry name and kind only and never trigger notifications", async () => {
    const all = (await json<NotificationCatalogResponse>(await call("GET", "/api/notifications/events"))).events.map((e) => e.type);
    const d = await create({ ...webhook(hook.url("/loop"), { secret: "loop-secret" }), events: all });
    await call("PATCH", `/api/notifications/destinations/${d.id}`, { name: "Loop check" });
    await call("POST", `/api/notifications/destinations/${d.id}/test`);
    const second = await create({ ...webhook(hook.url("/loop2")), events: all });
    await call("DELETE", `/api/notifications/destinations/${second.id}`);
    await Bun.sleep(300);
    expect(deliveryRows(d.id).map((r) => r.eventType)).toEqual(["test"]);
    const rows = db
      .query("SELECT action, details FROM audit_log WHERE action LIKE 'notification.%' AND target IN (?, ?) ORDER BY id ASC")
      .all(d.id, second.id) as { action: string; details: string }[];
    expect(rows.map((r) => r.action)).toEqual([
      "notification.destination.create",
      "notification.destination.update",
      "notification.destination.test",
      "notification.destination.create",
      "notification.destination.delete",
    ]);
    expect(JSON.parse(rows[0]!.details)).toEqual({ name: "Hook", kind: "webhook" });
    expect(JSON.parse(rows[2]!.details)).toEqual({ name: "Loop check", kind: "webhook", ok: true });
  });

  test("secrets never appear in API responses, audit entries, deliveries or logs", async () => {
    const secrets = ["URLTOKEN-7731", "whsec-SUPERSECRET-1", "HDR-SECRET-2", "tk_NTFYSECRET4", "DISCORDTOKEN5", "topicsecret99"];
    const captured: string[] = [];
    const originals = { log: console.log, warn: console.warn, error: console.error, info: console.info };
    for (const k of Object.keys(originals) as (keyof typeof originals)[]) {
      console[k] = (...args: unknown[]) => {
        captured.push(args.map((a) => (a instanceof Error ? `${a.message} ${a.stack}` : typeof a === "string" ? a : JSON.stringify(a))).join(" "));
        originals[k](...args);
      };
    }
    bodies.length = 0;
    try {
      hook.reset((_req, n) => (n === 1 ? new Response("nope URLTOKEN-7731 HDR-SECRET-2", { status: 503 }) : new Response("ok")));
      const w = await create(
        webhook(hook.url("/hook/URLTOKEN-7731"), { secret: "whsec-SUPERSECRET-1", headers: { Authorization: "Bearer HDR-SECRET-2" } }),
      );
      const n = await create({
        kind: "ntfy",
        name: "Phone",
        events: ["user.created"],
        config: { server: "http://127.0.0.1:4369", topic: "topicsecret99", token: "tk_NTFYSECRET4" },
      });
      const dsc = await create({
        kind: "discord",
        name: "Disc",
        events: ["user.created"],
        config: { url: "https://discord.com/api/webhooks/42/DISCORDTOKEN5" },
      });
      other.reset(() => new Response("bad", { status: 400 }));
      await call("POST", `/api/notifications/destinations/${w.id}/test`);
      await call("POST", `/api/notifications/destinations/${w.id}/test`);
      await call("POST", `/api/notifications/destinations/${n.id}/test`);
      await call("POST", `/api/notifications/destinations/${dsc.id}/test`);
      await call("PATCH", `/api/notifications/destinations/${w.id}`, { config: { secret: "whsec-SUPERSECRET-1", headers: { Authorization: "" } } });
      await call("PATCH", `/api/notifications/destinations/${n.id}`, { config: { topic: "topicsecret99", token: "tk_NTFYSECRET4" } });
      await call("POST", "/api/users", { email: "sam@example.com", password: "long enough pw", displayName: "Sam Ortiz", role: "viewer" });
      await until(() => deliveryRows(w.id).some((r) => r.eventType === "user.created" && r.status === "sent"), 8000, "user.created sent");
      await until(() => deliveryRows(n.id).some((r) => r.eventType === "user.created" && r.status !== "queued"), 8000, "ntfy attempted");
      await call("GET", "/api/notifications/destinations");
      await call("GET", `/api/notifications/destinations/${w.id}`);
      await call("GET", `/api/notifications/destinations/${w.id}/deliveries`);
      await call("GET", `/api/notifications/destinations/${n.id}/deliveries`);
      await call("POST", "/api/notifications/destinations", webhook("http://169.254.169.254/URLTOKEN-7731"));
      await call("POST", "/api/notifications/destinations", { kind: "discord", name: "x", events: [], config: { url: "https://evil.example/DISCORDTOKEN5" } });
    } finally {
      Object.assign(console, originals);
    }
    expect(hook.requests.some((r) => r.path === "/hook/URLTOKEN-7731")).toBe(true);
    expect(other.requests.some((r) => r.headers.authorization === "Bearer tk_NTFYSECRET4")).toBe(true);
    const audit = (db.query("SELECT action, target, details FROM audit_log").all() as Record<string, unknown>[]).map((r) => JSON.stringify(r));
    const deliveries = (db.query("SELECT * FROM notification_deliveries").all() as Record<string, unknown>[]).map((r) => JSON.stringify(r));
    const destinations = (db.query("SELECT * FROM notification_destinations").all() as Record<string, unknown>[]).map((r) => JSON.stringify(r));
    const haystacks: [string, string[]][] = [
      ["API responses", bodies],
      ["audit entries", audit],
      ["deliveries", deliveries],
      ["stored destinations", destinations],
      ["logs", captured],
    ];
    expect(bodies.length).toBeGreaterThan(5);
    expect(deliveries.some((d) => d.includes("sam@example.com"))).toBe(false);
    expect(deliveries.length).toBeGreaterThan(3);
    for (const [label, hay] of haystacks) {
      for (const secret of secrets) {
        const hit = hay.find((h) => h.includes(secret));
        expect(hit === undefined ? `${label}: clean` : `${label}: leaked ${secret}`).toBe(`${label}: clean`);
      }
    }
  });
});
