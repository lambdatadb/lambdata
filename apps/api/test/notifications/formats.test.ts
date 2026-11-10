import { authHeaders, seedUser, useTempMetadata, type SeededUser, type TempMetadata } from "../harness/sqlite";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import type { NotificationDestinationResponse, NotificationWebhookPayload } from "@lambdata/shared";
import { buildApp } from "../../src/server";
import { savePublicUrls } from "../../src/network/config";
import { users } from "../../src/db/queries";
import { notificationsService } from "../../src/notifications/service";
import { DEFAULT_ICON_URL } from "../../src/notifications/catalog";
import { cleanUserText, discordText, slackText } from "../../src/notifications/format";
import { clearNotifications, deliveryRows, FakeDestination, installFakeNetwork, json, restoreFakeNetwork, routes, until } from "./helpers";

const HOSTILE = "@everyone [click me](https://evil.example/x) <!channel> <@123> **bold** @here";

describe("notification formats", () => {
  let meta: TempMetadata;
  let app: ReturnType<typeof buildApp>;
  let admin: SeededUser;
  let discord: FakeDestination;
  let slack: FakeDestination;
  let webhook: FakeDestination;
  let ntfy: FakeDestination;

  async function call(method: string, path: string, body?: unknown): Promise<Response> {
    return app.request(path, {
      method,
      headers: await authHeaders(admin, { "Content-Type": "application/json" }),
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }

  async function create(body: Record<string, unknown>) {
    return (await json<NotificationDestinationResponse>(await call("POST", "/api/notifications/destinations", body), 201)).destination;
  }

  beforeAll(async () => {
    meta = useTempMetadata();
    installFakeNetwork();
    discord = new FakeDestination(4366);
    slack = new FakeDestination(4367);
    webhook = new FakeDestination(4368);
    ntfy = new FakeDestination(4369);
    routes.set("discord.com", { addresses: ["162.159.128.233"], port: 4366 });
    routes.set("hooks.slack.example", { addresses: ["203.0.113.10"], port: 4367 });
    routes.set("ntfy.example", { addresses: ["203.0.113.11"], port: 4369 });
    app = buildApp();
    admin = seedUser("admin");
    await notificationsService.start();
  });

  afterAll(async () => {
    await notificationsService.stop();
    for (const s of [discord, slack, webhook, ntfy]) s?.stop();
    restoreFakeNetwork();
    meta?.cleanup();
  });

  beforeEach(() => {
    clearNotifications();
    for (const s of [discord, slack, webhook, ntfy]) s.reset();
    savePublicUrls(["https://console.example.com"]);
  });

  async function addUser(displayName: string): Promise<string> {
    const res = await call("POST", "/api/users", {
      email: `riley-${Math.random().toString(36).slice(2, 8)}@example.com`,
      password: "correct horse battery",
      displayName,
      role: "viewer",
    });
    return (await json<{ user: { id: string } }>(res)).user.id;
  }

  test("each destination kind gets its exact request shape", async () => {
    await create({ kind: "discord", name: "Ops Discord", events: ["user.created"], config: { url: "https://discord.com/api/webhooks/123456/tok-abc" } });
    await create({ kind: "slack", name: "Ops Slack", events: ["user.created"], config: { url: "https://hooks.slack.example/services/T1/B2/xyz" } });
    await create({
      kind: "ntfy",
      name: "Phone",
      events: ["user.created"],
      config: { server: "https://ntfy.example", topic: "lambda-ops-7f3k", token: "tk_test_token" },
    });
    await create({
      kind: "webhook",
      name: "Home Assistant",
      events: ["user.created"],
      config: { url: webhook.url("/api/webhook/ld"), secret: "shared-signing-secret", headers: { "X-Team": "blue" } },
    });
    const before = Math.floor(Date.now() / 1000);
    await addUser("Riley Park");
    await until(() => discord.requests.length && slack.requests.length && ntfy.requests.length && webhook.requests.length, 8000, "all four");

    const d = discord.requests[0]!;
    expect(d.method).toBe("POST");
    expect(d.path).toBe("/api/webhooks/123456/tok-abc");
    expect(d.headers["content-type"]).toBe("application/json");
    expect(d.headers["user-agent"]).toBe("LambData");
    const dBody = discord.json<Record<string, any>>();
    expect(Object.keys(dBody).sort()).toEqual(["allowed_mentions", "avatar_url", "embeds", "username"]);
    expect(dBody.username).toBe("LambData");
    expect(dBody.avatar_url).toBe(DEFAULT_ICON_URL);
    expect(dBody.allowed_mentions).toEqual({ parse: [] });
    expect(dBody.embeds).toHaveLength(1);
    const embed = dBody.embeds[0];
    expect(embed.title).toBe("User added: Riley Park");
    expect(embed.color).toBe(0xc6f24e);
    expect(embed.url).toBe("https://console.example.com/users");
    expect(Date.parse(embed.timestamp)).toBeGreaterThan(0);
    expect(embed.description).toContain("Riley Park");
    expect(embed.fields.map((f: { name: string }) => f.name)).toEqual(["User", "Role", "By"]);
    expect(embed.fields.every((f: { inline: boolean }) => f.inline === true)).toBe(true);

    const s = slack.requests[0]!;
    expect(s.path).toBe("/services/T1/B2/xyz");
    const sBody = slack.json<Record<string, any>>();
    expect(Object.keys(sBody).sort()).toEqual(["attachments", "icon_url", "text", "username"]);
    expect(sBody.text).toBe("User added: Riley Park");
    expect(sBody.username).toBe("LambData");
    expect(sBody.icon_url).toBe(DEFAULT_ICON_URL);
    const att = sBody.attachments[0];
    expect(Object.keys(att).sort()).toEqual(["color", "fallback", "fields", "text", "title", "title_link", "ts"]);
    expect(att.color).toBe("#C6F24E");
    expect(att.title).toBe("User added: Riley Park");
    expect(att.title_link).toBe("https://console.example.com/users");
    expect(typeof att.ts).toBe("number");
    expect(att.fields[0]).toEqual({ title: "User", value: "Riley Park", short: true });

    const n = ntfy.requests[0]!;
    expect(n.path).toBe("/");
    expect(n.headers.authorization).toBe("Bearer tk_test_token");
    const nBody = ntfy.json<Record<string, any>>();
    expect(Object.keys(nBody).sort()).toEqual(["click", "icon", "message", "priority", "tags", "title", "topic"]);
    expect(nBody.topic).toBe("lambda-ops-7f3k");
    expect(nBody.title).toBe("User added: Riley Park");
    expect(nBody.priority).toBe(3);
    expect(nBody.tags).toEqual(["information_source"]);
    expect(nBody.click).toBe("https://console.example.com/users");
    expect(nBody.icon).toBe(DEFAULT_ICON_URL);

    const w = webhook.requests[0]!;
    expect(w.path).toBe("/api/webhook/ld");
    expect(w.headers["content-type"]).toBe("application/json");
    expect(w.headers["user-agent"]).toBe("LambData");
    expect(w.headers["x-team"]).toBe("blue");
    expect(w.headers["x-lambdata-event"]).toBe("user.created");
    const [row] = deliveryRows().filter((r) => r.title === "User added: Riley Park" && w.headers["x-lambdata-delivery"] === r.id);
    expect(row).toBeDefined();
    const ts = Number(w.headers["x-lambdata-timestamp"]);
    expect(ts).toBeGreaterThanOrEqual(before);
    expect(ts).toBeLessThanOrEqual(Math.floor(Date.now() / 1000));
    const expected = `sha256=${createHmac("sha256", "shared-signing-secret").update(`${ts}.${w.body}`).digest("hex")}`;
    expect(w.headers["x-lambdata-signature"]).toBe(expected);
    const forged = `sha256=${createHmac("sha256", "wrong-secret").update(`${ts}.${w.body}`).digest("hex")}`;
    expect(w.headers["x-lambdata-signature"]).not.toBe(forged);
    const payload = webhook.json<NotificationWebhookPayload>();
    expect(Object.keys(payload).sort()).toEqual(
      ["actor", "data", "database", "group", "iconUrl", "id", "link", "message", "occurredAt", "product", "severity", "title", "type", "version"].sort(),
    );
    expect(payload.version).toBe(1);
    expect(payload.product).toBe("lambdata");
    expect(payload.type).toBe("user.created");
    expect(payload.group).toBe("access");
    expect(payload.severity).toBe("info");
    expect(Date.parse(payload.occurredAt)).toBeGreaterThan(0);
    expect(payload.actor?.displayName).toBe(users.byId(admin.id)!.displayName!);
    expect(payload.database).toBeNull();
    expect(payload.data.role).toBe("viewer");
    expect(payload.link).toBe("https://console.example.com/users");
    expect(payload.iconUrl).toBe(DEFAULT_ICON_URL);
    for (const r of [d, s, n, w]) expect(r.body).not.toContain("@example.com");
  });

  test("a webhook without a secret is not signed, and a destination's icon and ntfy priority overrides apply", async () => {
    await create({ kind: "webhook", name: "Plain", events: ["user.created"], config: { url: webhook.url("/plain") } });
    await create({
      kind: "discord",
      name: "Custom icon",
      events: ["user.created"],
      iconUrl: "https://cdn.example.com/icon.png",
      config: { url: "https://discord.com/api/webhooks/1/2" },
    });
    await create({ kind: "ntfy", name: "Loud", events: ["user.created"], config: { server: "https://ntfy.example", topic: "loud-topic", priority: 5 } });
    await addUser("Jordan Lee");
    await until(() => webhook.requests.length && discord.requests.length && ntfy.requests.length, 8000, "three");
    expect(webhook.requests[0]!.headers["x-lambdata-signature"]).toBeUndefined();
    expect(discord.json<{ avatar_url: string }>().avatar_url).toBe("https://cdn.example.com/icon.png");
    expect(webhook.json<NotificationWebhookPayload>().iconUrl).toBe(DEFAULT_ICON_URL);
    expect(ntfy.json<{ priority: number }>().priority).toBe(5);
    expect(ntfy.requests[0]!.headers.authorization).toBeUndefined();
  });

  test("hostile names cannot ping, link or format in any chat destination", async () => {
    await create({ kind: "discord", name: "D", events: ["user.created"], config: { url: "https://discord.com/api/webhooks/9/9" } });
    await create({ kind: "slack", name: "S", events: ["user.created"], config: { url: "https://hooks.slack.example/services/x" } });
    await create({ kind: "ntfy", name: "N", events: ["user.created"], config: { server: "https://ntfy.example", topic: "hostile" } });
    await create({ kind: "webhook", name: "W", events: ["user.created"], config: { url: webhook.url("/w") } });
    await addUser(HOSTILE);
    await until(() => discord.requests.length && slack.requests.length && ntfy.requests.length && webhook.requests.length, 8000, "all");

    const dBody = discord.json<Record<string, any>>();
    expect(dBody.allowed_mentions).toEqual({ parse: [] });
    const embed = dBody.embeds[0];
    const discordTexts = [embed.title, embed.description, ...embed.fields.map((f: { value: string }) => f.value)];
    for (const t of discordTexts) {
      expect(t).not.toMatch(/@everyone|@here/);
      expect(t).not.toContain("](");
      expect(t).not.toContain("<@123>");
      expect(t).not.toContain("<!channel>");
      expect(t).not.toContain("https://evil");
    }
    expect(embed.description).toContain("\\*\\*bold\\*\\*");
    expect(embed.description).toContain("\\[click me\\]");

    const att = slack.json<Record<string, any>>().attachments[0];
    const slackTexts = [slack.json<{ text: string }>().text, att.title, att.text, ...att.fields.map((f: { value: string }) => f.value)];
    for (const t of slackTexts) {
      expect(t).not.toContain("<!channel>");
      expect(t).not.toContain("<@123>");
      expect(t).not.toMatch(/@everyone|@here/);
      expect(t).not.toContain("](");
      expect(t).not.toContain("https://evil");
      expect(t).not.toMatch(/<[^&]/);
    }
    expect(att.text).toContain("&lt;!channel&gt;");

    const nBody = ntfy.json<{ title: string; message: string }>();
    for (const t of [nBody.title, nBody.message]) {
      expect(t).not.toContain("](");
      expect(t).not.toContain("https://evil");
    }

    const payload = webhook.json<NotificationWebhookPayload>();
    expect(payload.title).toBe(`User added: ${HOSTILE}`);
  });

  test("user text is length-limited and stripped of control characters", () => {
    const long = `${"x".repeat(500)}\n\u0000tail`;
    const cleaned = cleanUserText(long);
    expect(cleaned.length).toBeLessThanOrEqual(200);
    expect(cleaned).not.toMatch(/[\u0000-\u001f]/);
    expect(cleanUserText("ask riley@example.com before mysql://app:hunter2@db.lan/x")).toBe("ask [email] before mysql://app:***@db.lan/x");
    expect(discordText("a_b*c")).toBe("a\\_b\\*c");
    expect(slackText("a & <b>")).toBe("a &amp; &lt;b&gt;");
  });

  test("severity picks the colour: a removed user is a warning", async () => {
    await create({ kind: "discord", name: "D", events: ["user.removed"], config: { url: "https://discord.com/api/webhooks/5/5" } });
    const id = await addUser("Casey Moss");
    const res = await call("DELETE", `/api/users/${id}`);
    expect(res.status).toBe(200);
    await until(() => discord.requests.length, 8000, "discord");
    const embed = discord.json<Record<string, any>>().embeds[0];
    expect(embed.title).toBe("User removed: Casey Moss");
    expect(embed.color).toBe(0xf2b84e);
  });

  test("without a public URL there is no console link", async () => {
    savePublicUrls([]);
    await create({ kind: "webhook", name: "W", events: ["user.created"], config: { url: webhook.url("/nolink") } });
    await create({ kind: "discord", name: "D", events: ["user.created"], config: { url: "https://discord.com/api/webhooks/7/7" } });
    await addUser("Morgan Diaz");
    await until(() => webhook.requests.length && discord.requests.length, 8000, "both");
    expect(webhook.json<NotificationWebhookPayload>().link).toBeNull();
    expect(discord.json<Record<string, any>>().embeds[0].url).toBeUndefined();
  });
});
