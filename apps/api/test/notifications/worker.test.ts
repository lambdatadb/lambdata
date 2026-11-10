import { authHeaders, seedUser, useTempMetadata, type SeededUser, type TempMetadata } from "../harness/sqlite";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { NotificationDestination, NotificationDestinationResponse, NotificationEventType } from "@lambdata/shared";
import { buildApp } from "../../src/server";
import { db } from "../../src/db/client";
import { notificationDeliveries, notificationDestinations, notificationState } from "../../src/db/queries/notifications";
import { notificationsService, runHousekeeping } from "../../src/notifications/service";
import { emit } from "../../src/notifications/emit";
import { notificationTuning, parseRetryAfter } from "../../src/notifications/send";
import { COALESCED_REASON, pruneAllDeliveries } from "../../src/notifications/worker";
import { checkDisk, handleAudit } from "../../src/notifications/handlers";
import { diskProbe } from "../../src/util/disk";
import {
  clearNotifications,
  deliveryRows,
  FakeDestination,
  installFakeNetwork,
  json,
  restoreFakeNetwork,
  restoreTuning,
  until,
} from "./helpers";

const GB = 1024 ** 3;

describe("notification delivery worker", () => {
  let meta: TempMetadata;
  let app: ReturnType<typeof buildApp>;
  let admin: SeededUser;
  let slow: FakeDestination;
  let fast: FakeDestination;
  let counter = 0;

  async function call(method: string, path: string, body?: unknown): Promise<Response> {
    return app.request(path, {
      method,
      headers: await authHeaders(admin, { "Content-Type": "application/json" }),
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }

  async function destination(server: FakeDestination, events: NotificationEventType[] = ["user.created"], path = "/hook", enabled = true) {
    return (
      await json<NotificationDestinationResponse>(
        await call("POST", "/api/notifications/destinations", { kind: "webhook", name: `Hook ${path}`, events, enabled, config: { url: server.url(path) } }),
        201,
      )
    ).destination;
  }

  function fire(type: NotificationEventType = "user.created", title = `Event ${++counter}`): number {
    return emit(type, null, () => ({ title, message: `${title} happened.` }));
  }

  function current(id: string): NotificationDestination {
    return notificationDestinations.byId(id)!;
  }

  beforeAll(async () => {
    meta = useTempMetadata();
    installFakeNetwork();
    slow = new FakeDestination(4366);
    fast = new FakeDestination(4367);
    app = buildApp();
    admin = seedUser("admin");
    await notificationsService.start();
  });

  afterAll(async () => {
    await notificationsService.stop();
    slow?.stop();
    fast?.stop();
    restoreFakeNetwork();
    meta?.cleanup();
  });

  beforeEach(async () => {
    restoreTuning();
    await notificationsService.stop();
    clearNotifications();
    slow.reset();
    fast.reset();
    await notificationsService.start();
  });

  test("with no destination, events write nothing and send nothing", async () => {
    const res = await call("POST", "/api/users", { email: "quinn@example.com", password: "long enough pw", displayName: "Quinn", role: "viewer" });
    expect(res.status).toBe(200);
    expect(fire()).toBe(0);
    await Bun.sleep(150);
    expect(deliveryRows()).toHaveLength(0);
    expect(slow.requests.length + fast.requests.length).toBe(0);
    const off = await destination(fast, ["user.created"], "/off", false);
    expect(fire()).toBe(0);
    await call("POST", "/api/users", { email: "quinn2@example.com", password: "long enough pw", displayName: "Quinn Two", role: "viewer" });
    await Bun.sleep(150);
    expect(deliveryRows(off.id)).toHaveLength(0);
    expect(fast.requests).toHaveLength(0);
  });

  test("selection by event type: only destinations that chose the type receive it", async () => {
    const wantsUsers = await destination(fast, ["user.created"], "/users");
    const wantsDisk = await destination(slow, ["disk.low"], "/disk");
    expect(fire("user.created")).toBe(1);
    await until(() => fast.requests.length === 1, 5000, "delivery");
    await Bun.sleep(100);
    expect(slow.requests).toHaveLength(0);
    expect(deliveryRows(wantsUsers.id)).toHaveLength(1);
    expect(deliveryRows(wantsDisk.id)).toHaveLength(0);
  });

  test("a slow destination does not delay the request that caused the event", async () => {
    slow.reset(async () => {
      await Bun.sleep(3000);
      return new Response("ok");
    });
    const d = await destination(slow, ["user.created"], "/slow");
    const started = performance.now();
    const res = await call("POST", "/api/users", { email: "drew@example.com", password: "long enough pw", displayName: "Drew Hale", role: "viewer" });
    const elapsed = performance.now() - started;
    expect(res.status).toBe(200);
    expect(elapsed).toBeLessThan(1000);
    await until(() => slow.requests.length === 1, 5000, "slow request started");
    await until(() => deliveryRows(d.id)[0]?.status === "sent", 8000, "slow delivery sent");
  }, 15_000);

  test("deliveries are sequential per destination and concurrent across destinations", async () => {
    slow.reset(async () => {
      await Bun.sleep(400);
      return new Response("ok");
    });
    await destination(slow, ["user.created"], "/a");
    await destination(fast, ["user.created"], "/b");
    for (let i = 1; i <= 4; i++) fire("user.created", `Ordered ${i}`);
    await until(() => fast.requests.length === 4, 5000, "fast lane");
    expect(slow.requests.length).toBeLessThan(4);
    await until(() => slow.requests.length === 4, 5000, "slow lane");
    const titles = slow.requests.map((r) => (JSON.parse(r.body) as { title: string }).title);
    expect(titles).toEqual(["Ordered 1", "Ordered 2", "Ordered 3", "Ordered 4"]);
    for (let i = 1; i < 4; i++) expect(slow.requests[i]!.at - slow.requests[i - 1]!.at).toBeGreaterThanOrEqual(350);
  }, 15_000);

  test("network errors and 5xx are retried with backoff, then the delivery is sent", async () => {
    notificationTuning.backoffMs = [200, 400, 800, 1600, 3200];
    fast.reset((_req, n) => (n <= 2 ? new Response("busy", { status: 503 }) : new Response("ok")));
    const d = await destination(fast);
    fire();
    await until(() => deliveryRows(d.id)[0]?.status === "sent", 8000, "sent after retries");
    const [row] = deliveryRows(d.id);
    expect(row!.attempts).toBe(3);
    expect(fast.requests).toHaveLength(3);
    expect(fast.requests[1]!.at - fast.requests[0]!.at).toBeGreaterThanOrEqual(180);
    expect(fast.requests[2]!.at - fast.requests[1]!.at).toBeGreaterThanOrEqual(380);
    expect(new Set(fast.requests.map((r) => r.headers["x-lambdata-delivery"])).size).toBe(1);
    expect(current(d.id).health).toBe("ok");
  }, 15_000);

  test("a refused connection is retried too", async () => {
    notificationTuning.backoffMs = [150, 150, 150, 150, 150];
    const d = (
      await json<NotificationDestinationResponse>(
        await call("POST", "/api/notifications/destinations", {
          kind: "webhook",
          name: "Nobody home",
          events: ["user.created"],
          config: { url: "http://127.0.0.1:4369/none" },
        }),
        201,
      )
    ).destination;
    fire();
    await until(() => deliveryRows(d.id)[0]?.status === "failed", 8000, "gave up");
    const [row] = deliveryRows(d.id);
    expect(row!.attempts).toBe(6);
    expect(row!.lastError).toBe("connection refused");
    expect(current(d.id).consecutiveFailures).toBe(1);
  }, 15_000);

  test("Retry-After is honoured instead of the backoff, and capped at 15 minutes", async () => {
    notificationTuning.backoffMs = [30_000, 30_000, 30_000, 30_000, 30_000];
    fast.reset((_req, n) => (n === 1 ? new Response("slow down", { status: 429, headers: { "Retry-After": "1" } }) : new Response("ok")));
    const d = await destination(fast);
    fire();
    await until(() => deliveryRows(d.id)[0]?.status === "sent", 6000, "sent after Retry-After");
    const gap = fast.requests[1]!.at - fast.requests[0]!.at;
    expect(gap).toBeGreaterThanOrEqual(950);
    expect(gap).toBeLessThan(5000);
    expect(parseRetryAfter("100000")).toBe(15 * 60_000);
    expect(parseRetryAfter("0")).toBe(1000);
    expect(parseRetryAfter(new Date(Date.now() + 120_000).toUTCString())).toBeGreaterThan(100_000);
    expect(parseRetryAfter("soon")).toBeNull();
  }, 15_000);

  test("other 4xx responses fail at once", async () => {
    fast.reset(() => new Response("gone", { status: 404 }));
    const d = await destination(fast);
    fire();
    await until(() => deliveryRows(d.id)[0]?.status === "failed", 5000, "failed");
    const [row] = deliveryRows(d.id);
    expect(row).toMatchObject({ attempts: 1, responseStatus: 404, lastError: "HTTP 404 Not Found", nextAttemptAt: null });
    await Bun.sleep(200);
    expect(fast.requests).toHaveLength(1);
  });

  test("health goes new, ok, failing after three failed deliveries, and back to ok", async () => {
    let status = 200;
    fast.reset(() => new Response("x", { status }));
    const d = await destination(fast);
    expect(current(d.id).health).toBe("new");
    fire();
    await until(() => current(d.id).health === "ok", 5000, "ok");
    status = 410;
    for (let i = 1; i <= 2; i++) {
      fire();
      await until(() => current(d.id).consecutiveFailures === i, 5000, `failure ${i}`);
      expect(current(d.id).health).toBe("ok");
    }
    fire();
    await until(() => current(d.id).health === "failing", 5000, "failing");
    expect(current(d.id)).toMatchObject({ consecutiveFailures: 3, lastError: "HTTP 410 Gone" });
    expect(current(d.id).lastFailureAt).not.toBeNull();
    status = 200;
    const before = fast.requests.length;
    fire();
    await until(() => current(d.id).health === "ok", 5000, "ok again");
    expect(fast.requests.length).toBe(before + 1);
    expect(current(d.id).consecutiveFailures).toBe(0);
  }, 20_000);

  test("flood control coalesces the overflow into one summary per minute", async () => {
    notificationTuning.maxPerWindow = 3;
    notificationTuning.windowMs = 1500;
    notificationTuning.summaryGatherMs = 150;
    const d = await destination(fast, ["user.created", "user.removed"]);
    for (let i = 1; i <= 8; i++) fire(i === 5 ? "user.removed" : "user.created", `Burst ${i}`);
    await until(() => fast.requests.length === 4, 5000, "3 messages and a summary");
    await Bun.sleep(300);
    expect(fast.requests).toHaveLength(4);
    const bodies = fast.requests.map(
      (r) => JSON.parse(r.body) as { type: string; group: string; title: string; message: string; data: Record<string, unknown> },
    );
    expect(bodies.slice(0, 3).map((b) => b.title)).toEqual(["Burst 1", "Burst 2", "Burst 3"]);
    expect(bodies[3]!.title).toBe("And 5 more events");
    expect(bodies[3]!.message).toContain("Burst 4");
    expect(bodies[3]).toMatchObject({ type: "summary", group: "summary", severity: "info" });
    expect(bodies[3]!.data).toEqual({ count: 5, types: "user.created,user.removed" });
    expect(fast.requests[3]!.headers["x-lambdata-event"]).toBe("summary");
    const rows = deliveryRows(d.id);
    expect(rows.filter((r) => r.status === "sent")).toHaveLength(3);
    const dropped = rows.filter((r) => r.status === "dropped");
    expect(dropped).toHaveLength(5);
    expect(dropped.every((r) => r.lastError === COALESCED_REASON)).toBe(true);
    for (let i = 1; i <= 3; i++) fire("user.created", `Second ${i}`);
    await until(() => fast.requests.length === 5, 3000, "second summary");
    expect((JSON.parse(fast.requests[4]!.body) as { title: string }).title).toBe("And 3 more events");
    expect(fast.requests[4]!.at - fast.requests[3]!.at).toBeGreaterThanOrEqual(1400);
    await Bun.sleep(1700);
    fire("user.created", "After the window");
    await until(() => fast.requests.some((r) => (JSON.parse(r.body) as { title: string }).title === "After the window"), 5000, "after window");
  }, 20_000);

  test("retention keeps at most 200 deliveries per destination and nothing older than 14 days", async () => {
    const d = await destination(fast, ["user.created"], "/retention", false);
    const now = Date.now();
    for (let i = 0; i < 230; i++) {
      notificationDeliveries.insertFinished({
        id: `ndl_r${i}`,
        destinationId: d.id,
        eventType: "user.created",
        title: `Old ${i}`,
        payload: "{}",
        createdAt: i < 5 ? now - 20 * 24 * 60 * 60_000 : now - (230 - i) * 1000,
        status: "sent",
        attempts: 1,
        responseStatus: 200,
        lastError: null,
        sentAt: now,
      });
    }
    pruneAllDeliveries();
    const rows = deliveryRows(d.id);
    expect(rows).toHaveLength(200);
    expect(rows.every((r) => r.createdAt > now - 14 * 24 * 60 * 60_000)).toBe(true);
    expect(rows[rows.length - 1]!.title).toBe("Old 229");
    const fresh = await destination(fast, ["user.created"], "/fresh-old");
    notificationDeliveries.insertFinished({
      id: "ndl_ancient",
      destinationId: fresh.id,
      eventType: "user.created",
      title: "Ancient",
      payload: "{}",
      createdAt: now - 15 * 24 * 60 * 60_000,
      status: "sent",
      attempts: 1,
      responseStatus: 200,
      lastError: null,
      sentAt: now,
    });
    runHousekeeping();
    expect(deliveryRows(fresh.id)).toHaveLength(0);
  });

  test("pending deliveries survive a restart and are sent when the worker starts again", async () => {
    const d = await destination(fast, ["user.created"], "/restart");
    await notificationsService.stop();
    fire("user.created", "Queued while down 1");
    fire("user.created", "Queued while down 2");
    const [first] = deliveryRows(d.id);
    db.query("UPDATE notification_deliveries SET status = 'sending', attempts = 1 WHERE id = ?").run(first!.id);
    await Bun.sleep(150);
    expect(fast.requests).toHaveLength(0);
    await notificationsService.start();
    await until(() => deliveryRows(d.id).every((r) => r.status === "sent"), 5000, "sent after restart");
    expect(fast.requests.map((r) => (JSON.parse(r.body) as { title: string }).title)).toEqual(["Queued while down 1", "Queued while down 2"]);
  });

  test("stopping the worker is prompt and does not wait for a slow request or retries", async () => {
    notificationTuning.backoffMs = [60_000, 60_000, 60_000, 60_000, 60_000];
    slow.reset(async () => {
      await Bun.sleep(5000);
      return new Response("ok");
    });
    const d = await destination(slow, ["user.created"], "/hang");
    const r = await destination(fast, ["user.created"], "/retrying");
    fast.reset(() => new Response("down", { status: 500 }));
    fire();
    await until(() => slow.requests.length === 1 && deliveryRows(r.id)[0]?.nextAttemptAt, 5000, "in flight and waiting");
    const started = performance.now();
    await notificationsService.stop();
    expect(performance.now() - started).toBeLessThan(1500);
    expect(deliveryRows(d.id)[0]!.status).toBe("queued");
    expect(deliveryRows(r.id)[0]!.status).toBe("queued");
  }, 15_000);

  test("an access policy change is reported only when the policy really changed", async () => {
    await destination(fast, ["network.policy_changed"], "/policy");
    const open = { allowLan: true, allowTailnet: true, allowCloudflare: true, requireCloudflareAccess: false, restrictAppApis: false };
    handleAudit({ userId: admin.id, action: "network.policy.update", target: null, details: { from: open, to: open }, at: Date.now() });
    handleAudit({
      userId: admin.id,
      action: "network.policy.update",
      target: null,
      details: { from: open, to: { ...open, allowCloudflare: false } },
      at: Date.now(),
    });
    await until(() => fast.requests.length === 1, 3000, "policy change");
    await Bun.sleep(100);
    expect(fast.requests).toHaveLength(1);
    const body = JSON.parse(fast.requests[0]!.body) as { title: string; message: string; data: Record<string, unknown> };
    expect(body.title).toBe("Access policy changed");
    expect(body.message).toContain("LAN allowed, tailnet allowed, Cloudflare blocked");
    expect(body.data).toMatchObject({ allowCloudflare: false, resetByEnvironment: false });
  });

  test("disk low is sent once per crossing and recovery once when space is back", async () => {
    const d = await destination(fast, ["disk.low", "disk.recovered"], "/disk");
    const original = diskProbe.space;
    try {
      let free = 2 * GB;
      diskProbe.space = () => ({ freeBytes: free, totalBytes: 100 * GB });
      checkDisk();
      checkDisk();
      checkDisk();
      await until(() => fast.requests.length === 1, 3000, "disk.low");
      await Bun.sleep(100);
      expect(fast.requests).toHaveLength(1);
      expect(JSON.parse(fast.requests[0]!.body)).toMatchObject({ type: "disk.low", severity: "error" });
      expect(fast.requests[0]!.body).not.toContain(meta.dataDir);
      free = 5 * GB + 1;
      checkDisk();
      await Bun.sleep(100);
      expect(fast.requests).toHaveLength(1);
      free = 50 * GB;
      checkDisk();
      checkDisk();
      await until(() => fast.requests.length === 2, 3000, "disk.recovered");
      await Bun.sleep(100);
      expect(fast.requests).toHaveLength(2);
      expect(JSON.parse(fast.requests[1]!.body)).toMatchObject({ type: "disk.recovered" });
      expect(notificationState.get("disk.low")).toBeNull();
      expect(deliveryRows(d.id)).toHaveLength(2);
    } finally {
      diskProbe.space = original;
    }
  });
});
