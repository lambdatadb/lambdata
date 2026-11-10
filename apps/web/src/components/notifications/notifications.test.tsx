import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StaticRouter } from "react-router-dom/server";
import type { NotificationDestination } from "@lambdata/shared";
import {
  FIXTURE_DATABASES,
  fixtureCatalog,
  fixtureDefaultEvents,
  fixtureDeliveries,
  fixtureDestinations,
  fixtureTestNotFound,
  fixtureTestOk,
  fixtureTestTimeout,
} from "../../pages/dev/notificationFixtures";
import { NotificationsFailingAlert, failingDestinations } from "../../pages/dashboard/NotificationsBanner";
import { NAV_ITEMS, visibleNavItems } from "../layout/nav";
import { commands as notificationCommands } from "../../commands/notifications";
import { DatabaseScope } from "./DatabaseScope";
import { DeliveryList, deliveryWhen, retryText } from "./Deliveries";
import { DestinationCard, TestResult, eventsText, scopeText } from "./DestinationCard";
import { DestinationForm } from "./DestinationDialog";
import { EventPicker } from "./EventPicker";
import { GetStarted } from "./GetStarted";
import {
  createDestination,
  createRequest,
  deleteDestination,
  draftFrom,
  fetchCatalog,
  headerRow,
  healthView,
  newDraft,
  overallState,
  testDestination,
  testOutcome,
  updateDestination,
  updateRequest,
  validateDraft,
  type DestinationDraft,
  type DraftErrors,
} from "./model";

declare const test: (name: string, fn: () => void | Promise<void>) => void;
declare const expect: (value: unknown) => {
  toBe(expected: unknown): void;
  toEqual(expected: unknown): void;
  toContain(expected: unknown): void;
  toBeNull(): void;
  toBeUndefined(): void;
  not: { toContain(expected: unknown): void; toBeNull(): void; toBe(expected: unknown): void; toBeUndefined(): void };
};

function render(node: ReactElement): string {
  const client = new QueryClient();
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <StaticRouter location="/notifications">{node}</StaticRouter>
    </QueryClientProvider>,
  );
}

function text(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
}

const NOW = Date.now();
const [ops, home, phone, team] = fixtureDestinations(NOW) as [NotificationDestination, NotificationDestination, NotificationDestination, NotificationDestination];
const names = new Map(FIXTURE_DATABASES.map((d) => [d.id, d.displayName]));
const dbs = FIXTURE_DATABASES.map((d) => ({ ...d, kind: d.id.includes("mirror") ? ("mirror" as const) : ("standard" as const) }));

function form(draft: DestinationDraft, options: { mode?: "add" | "edit"; original?: NotificationDestination | null; errors?: DraftErrors; serverError?: unknown } = {}): string {
  return render(
    <DestinationForm
      draft={draft}
      patch={() => undefined}
      onKind={() => undefined}
      errors={options.errors ?? {}}
      mode={options.mode ?? "add"}
      original={options.original ?? null}
      catalog={fixtureCatalog}
      databases={dbs}
      serverError={options.serverError}
    />,
  );
}

function card(dest: NotificationDestination, extra: Partial<Parameters<typeof DestinationCard>[0]> = {}): string {
  return render(
    <ul>
      <DestinationCard
        dest={dest}
        catalog={fixtureCatalog}
        databaseNames={names}
        onTest={() => undefined}
        onDismissTest={() => undefined}
        onToggle={() => undefined}
        onEdit={() => undefined}
        onDelete={() => undefined}
        {...extra}
      />
    </ul>,
  );
}

test("the empty state explains the feature, says nothing is sent yet and offers the four kinds", () => {
  const t = text(render(<GetStarted onPick={() => undefined} />));
  expect(t).toContain("Get a message when something happens");
  expect(t).toContain("Nothing is sent until you add a destination, and each destination gets only the events you pick.");
  for (const label of ["Discord", "Slack or Mattermost", "ntfy", "Webhook"]) expect(t).toContain(label);
  expect(t).toContain("Add your first destination");
  expect(t).toContain("Never row data, passwords, connection strings or email addresses.");
  expect(t).toContain("Checkpoint made: Before the wipe (a41f9c2)");
});

test("the add dialog asks for a kind first and shows nothing else until one is picked", () => {
  const t = text(form(newDraft(null, fixtureCatalog)));
  expect(t).toContain("Where to send");
  expect(t).toContain("A channel in your server");
  expect(t).toContain("Push to your phone");
  expect(t).not.toContain("Webhook URL");
  expect(t).not.toContain("Events");
});

test("the Discord dialog explains where the URL comes from, with the events, databases and icon", () => {
  const html = form(newDraft("discord", fixtureCatalog));
  const t = text(html);
  expect(t).toContain("Where do I get this?");
  expect(t).toContain("Edit Channel");
  expect(t).toContain("Integrations → Webhooks → New Webhook");
  expect(t).toContain("Manage Webhooks");
  expect(t).toContain("Copy Webhook URL");
  expect(t).toContain("Webhook URL");
  expect(html).toContain('placeholder="https://discord.com/api/webhooks/…"');
  expect(t).toContain(`${fixtureDefaultEvents.length} of ${fixtureCatalog.events.length} events`);
  expect(t).toContain("the defaults");
  expect(t).toContain("a mirror that syncs every five minutes sends a message every five minutes");
  expect(t).toContain("All databases");
  expect(t).toContain("LambData icon");
  expect(t).toContain("default");
  expect(html).toContain('value="Discord"');
});

test("the Slack dialog covers Slack and says Mattermost works too", () => {
  const t = text(form(newDraft("slack", fixtureCatalog)));
  expect(t).toContain("Incoming Webhooks");
  expect(t).toContain("Add New Webhook to Workspace");
  expect(t).toContain("https://hooks.slack.com/services/");
  expect(t).toContain("Mattermost");
  expect(t).toContain("Works with Slack, Mattermost and other Slack-compatible chats.");
});

test("the ntfy dialog explains topics, the default server, the token and the priority", () => {
  const t = text(form(newDraft("ntfy", fixtureCatalog)));
  expect(t).toContain("The topic is the address");
  expect(t).toContain("hard to guess");
  expect(t).toContain("Suggest one");
  expect(t).toContain("Leave empty for ntfy.sh");
  expect(t).toContain("Access token");
  expect(t).toContain("tk_");
  expect(t).toContain("Priority");
  expect(t).toContain("How loudly your phone announces it.");
  expect(t).toContain("Shown on the notification");
});

test("the webhook dialog has the signature header, custom headers and the payload reference", () => {
  const draft = { ...newDraft("webhook", fixtureCatalog), headers: [headerRow("X-Team", "ops")] };
  const html = form(draft);
  const t = text(html);
  expect(t).toContain("X-LambData-Signature carries an HMAC-SHA256 of the timestamp, a dot and the body.");
  expect(t).toContain("Generate");
  expect(t).toContain("Custom headers");
  expect(t).toContain("Add header");
  expect(html).toContain('value="X-Team"');
  expect(t).toContain("Payload reference");
  expect(html).toContain('href="https://github.com/lambdatadb/lambdata/blob/main/docs/notifications.md"');
  expect(t).toContain("localhost is the container itself");
  expect(t).toContain("Sent as iconUrl in the payload");
});

test("validation explains each problem in plain words", () => {
  const discord = { ...newDraft("discord", fixtureCatalog), url: "https://example.com/not-a-discord-hook", name: " " };
  const errors = validateDraft(discord, fixtureCatalog);
  expect(errors.url).toBe("That is not a Discord webhook URL. It starts with https://discord.com/api/webhooks/.");
  expect(errors.name).toBe("Give it a name you will recognise in this list.");
  expect(validateDraft({ ...discord, url: "https://discord.com/api/webhooks/1/abc", name: "Ops" }, fixtureCatalog)).toEqual({});

  expect(validateDraft(newDraft(null, fixtureCatalog), fixtureCatalog).kind).toBe("Choose where the messages should go.");
  const none = validateDraft({ ...newDraft("slack", fixtureCatalog), url: "https://hooks.slack.com/services/x", events: [] }, fixtureCatalog);
  expect(none.events).toBe("Pick at least one event, or nothing will be sent.");
  expect(validateDraft({ ...newDraft("slack", fixtureCatalog), url: "http://203.0.113.9/hook" }, fixtureCatalog).url).toContain("Use https");
  expect(validateDraft({ ...newDraft("slack", fixtureCatalog), url: "http://192.168.1.20:8065/hooks/x" }, fixtureCatalog).url).toBeUndefined();

  const webhook = validateDraft(
    { ...newDraft("webhook", fixtureCatalog), url: "http://169.254.169.254/latest", headers: [headerRow("Content-Type", "x"), headerRow("X-Ok", "")] },
    fixtureCatalog,
  );
  expect(webhook.url).toContain("reserved");
  expect(webhook.headers).toBe("LambData sets Content-Type itself.");
  expect(validateDraft({ ...newDraft("webhook", fixtureCatalog), url: "https://user:pw@example.com/h" }, fixtureCatalog).url).toContain("user name and password");
  expect(validateDraft({ ...newDraft("webhook", fixtureCatalog), url: "https://example.com/h", headers: [headerRow("User-Agent", "x")] }, fixtureCatalog).headers).toBe(
    "LambData sets User-Agent itself.",
  );
  expect(validateDraft({ ...draftFrom(home) }, fixtureCatalog).headers).toBeUndefined();
  expect(validateDraft({ ...newDraft("discord", fixtureCatalog), url: "https://discord.com/api/webhooks/123" }, fixtureCatalog).url).toContain("not a Discord");
  expect(validateDraft({ ...newDraft("webhook", fixtureCatalog), url: "ftp://example.com" }, fixtureCatalog).url).toBe(
    "Use an address that starts with http:// or https://.",
  );
  expect(validateDraft({ ...newDraft("webhook", fixtureCatalog), url: "https://example.com/h", headers: [headerRow("X-Ok", "")] }, fixtureCatalog).headers).toBe(
    "Give X-Ok a value.",
  );

  const ntfy = validateDraft({ ...newDraft("ntfy", fixtureCatalog), topic: "has spaces" }, fixtureCatalog);
  expect(ntfy.topic).toBe("Use letters, numbers, - and _ only, up to 64 characters.");
  expect(validateDraft({ ...newDraft("ntfy", fixtureCatalog), topic: "" }, fixtureCatalog).topic).toContain("Pick a topic name");

  const scoped = validateDraft(
    { ...newDraft("discord", fixtureCatalog), url: "https://discord.com/api/webhooks/1/a", scope: "some", databaseIds: [] },
    fixtureCatalog,
  );
  expect(scoped.databases).toBe("Pick at least one database, or choose all databases.");
  const icon = validateDraft(
    { ...newDraft("discord", fixtureCatalog), url: "https://discord.com/api/webhooks/1/a", iconMode: "custom", iconUrl: "http://example.com/i.png" },
    fixtureCatalog,
  );
  expect(icon.iconUrl).toContain("https://");
});

test("validation errors are shown next to their fields", () => {
  const draft = { ...newDraft("discord", fixtureCatalog), url: "https://example.com/not-a-discord-hook", events: [] };
  const errors = validateDraft(draft, fixtureCatalog);
  const html = form(draft, { errors });
  const t = text(html);
  expect(t).toContain("That is not a Discord webhook URL.");
  expect(t).toContain("Pick at least one event, or nothing will be sent.");
  expect(html).toContain('aria-invalid="true"');
  expect(html).toContain("data-invalid");
  const server = text(form(draft, { serverError: new Error("Discord webhook URLs must use https://discord.com/api/webhooks/") }));
  expect(server).toContain("Not saved");
  expect(server).toContain("Discord webhook URLs must use");
});

test("editing never shows a stored secret: each one is saved, with replace instead", () => {
  const html = form(draftFrom(home), { mode: "edit", original: home });
  const t = text(html);
  expect(t).toContain("https://automation.example.com");
  expect(t).toContain("Stored encrypted and never shown again. Replace it to change it.");
  expect(html).toContain('data-saved="address"');
  expect(html).toContain('data-saved="signing secret"');
  expect(html).toContain('aria-label="Replace the address"');
  expect(html).toContain('aria-label="Remove the signing secret"');
  expect(html).toContain('value="X-Team"');
  expect(html).toContain('placeholder="keep saved"');
  expect(html).toContain('data-header-row="saved"');
  expect(t).toContain("Leave a value empty to keep it");
  expect(t).not.toContain("Generate");
  expect(t).not.toContain("Where do I get this?");

  const replacing = text(form({ ...draftFrom(home), addressMode: "replace" }, { mode: "edit", original: home }));
  expect(replacing).toContain("Keep the saved one");
  expect(replacing).toContain("Where do I get this?");
  const removing = text(form({ ...draftFrom(home), secretMode: "remove" }, { mode: "edit", original: home }));
  expect(removing).toContain("Removed when you save: messages will no longer be signed.");
  expect(removing).toContain("Keep it");

  const tokened = { ...phone, hasSecret: true };
  const ntfy = form(draftFrom(tokened), { mode: "edit", original: tokened });
  expect(ntfy).toContain('data-saved="access token"');
  expect(ntfy).toContain('data-saved="server and topic"');
  expect(text(ntfy)).toContain("ntfy.sh/la…");
  expect(form(draftFrom(phone), { mode: "edit", original: phone })).not.toContain('data-saved="access token"');
  const custom = { ...phone, target: "ntfy.example.com/la…" };
  expect(text(form({ ...draftFrom(custom), addressMode: "replace" }, { mode: "edit", original: custom }))).toContain(
    "Leave empty to keep ntfy.example.com.",
  );
  const discord = text(form(draftFrom(ops), { mode: "edit", original: ops }));
  expect(discord).toContain("discord.com/…k3Qz");
  expect(discord).not.toContain("https://discord.com/api/webhooks/1");
});

test("create requests carry exactly the chosen config for each kind", () => {
  const discord = createRequest({ ...newDraft("discord", fixtureCatalog), url: " https://discord.com/api/webhooks/1/a ", name: " Ops " });
  expect(discord).toEqual({
    kind: "discord",
    config: { url: "https://discord.com/api/webhooks/1/a" },
    name: "Ops",
    enabled: true,
    events: fixtureDefaultEvents,
    databaseIds: null,
    iconUrl: null,
  });
  const webhook = createRequest({
    ...newDraft("webhook", fixtureCatalog),
    url: "https://example.com/h",
    secret: "s3cret",
    headers: [headerRow("X-Team", "ops"), headerRow("", "")],
    scope: "some",
    databaseIds: ["db_fixture_ledger"],
    iconMode: "custom",
    iconUrl: "https://example.com/icon.png",
  });
  expect(webhook.config).toEqual({ url: "https://example.com/h", secret: "s3cret", headers: { "X-Team": "ops" } });
  expect(webhook.databaseIds).toEqual(["db_fixture_ledger"]);
  expect(webhook.iconUrl).toBe("https://example.com/icon.png");
  const bare = createRequest({ ...newDraft("webhook", fixtureCatalog), url: "https://example.com/h" });
  expect(bare.config).toEqual({ url: "https://example.com/h" });
  const ntfy = createRequest({ ...newDraft("ntfy", fixtureCatalog), topic: "lambdata-x", server: "https://ntfy.example.com/", priority: "4", token: "tk_abc" });
  expect(ntfy.config).toEqual({ topic: "lambdata-x", server: "https://ntfy.example.com", priority: 4, token: "tk_abc" });
  expect(createRequest({ ...newDraft("ntfy", fixtureCatalog), topic: "lambdata-x" }).config).toEqual({ topic: "lambdata-x" });
});

test("update requests send only what changed and keep stored secrets unless told otherwise", () => {
  expect(updateRequest(draftFrom(home), home)).toEqual({});
  expect(updateRequest({ ...draftFrom(home), name: "Home" }, home)).toEqual({ name: "Home" });
  expect(updateRequest({ ...draftFrom(ops), scope: "some", databaseIds: ["db_fixture_ledger"] }, ops)).toEqual({ databaseIds: ["db_fixture_ledger"] });
  expect(updateRequest({ ...draftFrom(home), scope: "all" }, home)).toEqual({ databaseIds: null });
  expect(updateRequest({ ...draftFrom(home), events: [...home.events].reverse() }, home)).toEqual({});
  expect(updateRequest({ ...draftFrom(home), iconMode: "custom", iconUrl: "https://example.com/i.png" }, home)).toEqual({ iconUrl: "https://example.com/i.png" });

  const keep = updateRequest({ ...draftFrom(home), addressMode: "replace", url: "https://example.com/new" }, home);
  expect(keep).toEqual({ config: { url: "https://example.com/new" } });
  expect(updateRequest({ ...draftFrom(home), secretMode: "remove", headers: [] }, home)).toEqual({ config: { secret: null, headers: {} } });
  expect(updateRequest({ ...draftFrom(home), secretMode: "new", secret: "fresh" }, home)).toEqual({ config: { secret: "fresh" } });
  expect(updateRequest({ ...draftFrom(home), secretMode: "new", secret: "" }, home)).toEqual({});
  const extra = { ...draftFrom(home), headers: [...draftFrom(home).headers, headerRow("X-Env", "prod")] };
  expect(updateRequest(extra, home)).toEqual({ config: { headers: { "X-Team": "", "X-Env": "prod" } } });
  const renamed = { ...draftFrom(home), headers: [{ ...draftFrom(home).headers[0]!, name: "X-Group", saved: false, value: "ops" }] };
  expect(updateRequest(renamed, home)).toEqual({ config: { headers: { "X-Group": "ops" } } });

  expect(updateRequest({ ...draftFrom(phone), priority: "event" }, phone)).toEqual({ config: { priority: null } });
  expect(updateRequest({ ...draftFrom(phone), addressMode: "replace", topic: "lambdata-y" }, phone)).toEqual({ config: { topic: "lambdata-y" } });
  expect(updateRequest({ ...draftFrom(phone), addressMode: "replace", topic: "lambdata-y", server: "https://ntfy.example.com/" }, phone)).toEqual({
    config: { topic: "lambdata-y", server: "https://ntfy.example.com" },
  });
  const tokened = { ...phone, hasSecret: true };
  expect(updateRequest({ ...draftFrom(tokened), tokenMode: "remove" }, tokened)).toEqual({ config: { token: null } });
  expect(updateRequest({ ...draftFrom(ops), addressMode: "replace", url: "https://discord.com/api/webhooks/2/b" }, ops)).toEqual({
    config: { url: "https://discord.com/api/webhooks/2/b" },
  });
});

test("a failing destination is marked amber with its last error, a new one invites a test", () => {
  const html = card(home);
  const t = text(html);
  expect(html).toContain('data-health="failing"');
  expect(html).toContain("border-warn/45");
  expect(html).toContain("bg-warn");
  expect(html).not.toContain("text-danger");
  expect(t).toContain("failing");
  expect(t).toContain("Failing · 4 in a row");
  expect(t).toContain("HTTP 404 Not Found");
  expect(t).toContain("last tried 12m ago");
  expect(t).toContain("Storefront, Ledger");
  expect(t).toContain("Signed · 1 header");
  expect(t).toContain("6 of 25 events");

  const fresh = text(card(phone));
  expect(fresh).toContain("Nothing delivered yet. Send a test to check that messages arrive.");
  const tried = text(card({ ...phone, consecutiveFailures: 2, lastFailureAt: NOW - 120_000, lastError: "HTTP 404 Not Found" }));
  expect(tried).toContain("Last 2 attempts failed 2m ago · HTTP 404 Not Found");
  expect(tried).not.toContain("Nothing delivered yet");
  expect(card({ ...phone, consecutiveFailures: 2, lastFailureAt: NOW - 120_000 })).not.toContain("border-warn/45");
  expect(fresh).toContain("priority 4 · high");
  const paused = card(team);
  expect(text(paused)).toContain("paused");
  expect(paused).not.toContain("border-warn/45");
  expect(text(card(ops))).toContain("Delivered 4m ago");
  expect(text(card(ops))).toContain("All databases");
});

test("send test shows the outcome inline: sent, refused with a reason, or no answer", () => {
  const ok = render(<TestResult state={{ status: "done", result: fixtureTestOk }} onDismiss={() => undefined} />);
  expect(ok).toContain('data-test-result="ok"');
  expect(text(ok)).toContain("Test message sent");
  expect(text(ok)).toContain("HTTP 204 in 312 ms");

  const failed = render(<TestResult state={{ status: "done", result: fixtureTestNotFound }} onDismiss={() => undefined} />);
  expect(failed).toContain('data-test-result="failed"');
  expect(failed).not.toContain("border-danger");
  expect(text(failed)).toContain("The test was not delivered");
  expect(text(failed)).toContain("HTTP 404 Not Found");
  expect(text(failed)).toContain("The webhook may have been deleted");

  expect(testOutcome(fixtureTestTimeout).hint).toContain("No answer within 10 seconds");
  expect(testOutcome({ ok: false, responseStatus: 401, error: "HTTP 401 Unauthorized", durationMs: 5 }).hint).toContain("Check the token");
  expect(testOutcome({ ok: false, responseStatus: null, error: "connection refused", durationMs: 5 }).hint).toContain("localhost is the container itself");
  expect(text(render(<TestResult state={{ status: "running" }} onDismiss={() => undefined} />))).toContain("Sending a test message");

  const inCard = text(card(ops, { test: { status: "done", result: fixtureTestNotFound } }));
  expect(inCard).toContain("The test was not delivered");
});

test("recent deliveries list status, event, title, time, attempts and error", () => {
  const html = render(<DeliveryList deliveries={fixtureDeliveries(NOW)} catalog={fixtureCatalog} />);
  const t = text(html);
  expect(html).toContain('data-delivery-status="queued"');
  expect(html).toContain('data-delivery-status="failed"');
  expect(html).toContain('data-delivery-status="dropped"');
  expect(t).toContain("Queued");
  expect(t).toContain("Sync failed: Game Mirror");
  expect(t).toContain("Sync failed · 2 attempts");
  expect(t).toContain("HTTP 503 Service Unavailable");
  expect(t).toContain("Test message · 1 attempt");
  expect(t).toContain("Sent");
  expect(t).toContain("HTTP 204");
  expect(t).toContain("Dropped");
  expect(t).toContain("Folded into a summary");
  expect(text(render(<DeliveryList deliveries={[]} catalog={fixtureCatalog} />))).toContain("Nothing sent yet.");

  expect(retryText(NOW + 45_000, NOW)).toBe("retry in 45s");
  expect(retryText(NOW + 5 * 60_000, NOW)).toBe("retry in 5m");
  expect(retryText(NOW - 1, NOW)).toBe("retrying now");
  expect(deliveryWhen(fixtureDeliveries(NOW)[0]!, NOW).text).toBe("retry in 45s");
});

test("the event picker groups the catalog, selects whole groups and marks routine events", () => {
  const some = render(<EventPicker catalog={fixtureCatalog} value={["checkpoint.created"]} onChange={() => undefined} initiallyOpen={["checkpoints"]} />);
  const t = text(some);
  for (const g of fixtureCatalog.groups) expect(t).toContain(g.label);
  expect(some).toContain('data-state="indeterminate"');
  expect(t).toContain("1/7");
  expect(t).toContain("routine");
  expect(t).toContain("Scheduled checkpoints send one message per database every time they run.");
  expect(t).toContain("Use defaults");
  const all = render(<EventPicker catalog={fixtureCatalog} value={fixtureCatalog.events.map((e) => e.type)} onChange={() => undefined} />);
  expect(text(all)).toContain("25 of 25 events");
  expect(text(all)).toContain("3/3");
});

test("the database scope only matters for per-database events", () => {
  const draft = { ...newDraft("discord", fixtureCatalog), events: ["user.created", "disk.low"] as DestinationDraft["events"] };
  const t = text(render(<DatabaseScope catalog={fixtureCatalog} draft={draft} patch={() => undefined} databases={dbs} />));
  expect(t).toContain("does not apply");
  const some = { ...newDraft("discord", fixtureCatalog), scope: "some" as const, databaseIds: ["db_fixture_ledger", "db_gone"] };
  const list = text(render(<DatabaseScope catalog={fixtureCatalog} draft={some} patch={() => undefined} databases={dbs} />));
  expect(list).toContain("Only the databases I pick");
  expect(list).toContain("Game Mirror");
  expect(list).toContain("mirror");
  expect(list).toContain("A deleted database");
  expect(scopeText(home, names, fixtureCatalog)).toBe("Storefront, Ledger");
  expect(scopeText({ ...ops, events: ["user.created"] }, names, fixtureCatalog)).toBe("No database events");
  expect(eventsText({ ...ops, events: fixtureCatalog.events.map((e) => e.type) }, fixtureCatalog)).toBe("All events");
});

test("the dashboard names failing destinations and stays quiet otherwise", () => {
  const all = fixtureDestinations(NOW);
  const failing = failingDestinations(all);
  expect(failing.map((d) => d.id)).toEqual(["nd_home"]);
  const one = text(render(<NotificationsFailingAlert failing={failing} />));
  expect(one).toContain("Notifications to Home automation are failing");
  expect(one).toContain("HTTP 404 Not Found");
  expect(one).toContain("Review");
  const two = text(render(<NotificationsFailingAlert failing={[home, { ...ops, health: "failing" }]} />));
  expect(two).toContain("2 notification destinations are failing");
  expect(render(<NotificationsFailingAlert failing={[]} />)).toBe("");
  expect(failingDestinations([{ ...home, enabled: false }])).toEqual([]);
});

test("health, overall state and the page entry points", () => {
  expect(healthView(home).tone).toBe("warn");
  expect(healthView(phone).label).toBe("Nothing delivered yet");
  expect(healthView({ ...ops, consecutiveFailures: 1, lastFailureAt: NOW, lastSuccessAt: NOW - 60_000 }).label).toBe("Last attempt failed");
  expect(testOutcome({ ok: true, responseStatus: 204, error: null, durationMs: 0 }).detail).toContain("under 1 ms");
  expect(overallState([])).toBe("off");
  expect(overallState([team])).toBe("paused");
  expect(overallState([team, ops])).toBe("on");
  const item = NAV_ITEMS.find((i) => i.to === "/notifications");
  expect(item?.label).toBe("Notifications");
  expect(visibleNavItems(NAV_ITEMS, "admin").some((i) => i.to === "/notifications")).toBe(true);
  expect(visibleNavItems(NAV_ITEMS, "db_owner").some((i) => i.to === "/notifications")).toBe(false);
  expect(visibleNavItems(NAV_ITEMS, "viewer").some((i) => i.to === "/notifications")).toBe(false);
  const network = NAV_ITEMS.findIndex((i) => i.to === "/network");
  expect(NAV_ITEMS[network + 1]?.to).toBe("/notifications");
  const command = notificationCommands.find((c) => c.id === "notifications:add")!;
  const ctx = (role: "admin" | "viewer") => ({ user: { role } }) as unknown as Parameters<NonNullable<typeof command.when>>[0];
  expect(command.when!(ctx("admin"))).toBe(true);
  expect(command.when!(ctx("viewer"))).toBe(false);
});

async function capture(run: () => Promise<unknown>, response: unknown, status = 200): Promise<{ url: string; init: RequestInit }> {
  const original = globalThis.fetch;
  let seen: { url: string; init: RequestInit } | null = null;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    seen = { url: String(input), init: init ?? {} };
    if (status === 204) return new Response(null, { status });
    return new Response(JSON.stringify(response), { status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  try {
    await run();
  } catch {
    return seen!;
  } finally {
    globalThis.fetch = original;
  }
  if (!seen) throw new Error("no request was sent");
  return seen;
}

test("requests go to the contract's routes as JSON", async () => {
  const body = createRequest({ ...newDraft("webhook", fixtureCatalog), url: "https://example.com/h" });
  const created = await capture(() => createDestination(body), { destination: home }, 201);
  expect(created.url).toBe("/api/notifications/destinations");
  expect(created.init.method).toBe("POST");
  expect(new Headers(created.init.headers).get("Content-Type")).toBe("application/json");
  expect(JSON.parse(String(created.init.body))).toEqual(body);

  const patched = await capture(() => updateDestination("nd/1", { enabled: false }), { destination: home });
  expect(patched.url).toBe("/api/notifications/destinations/nd%2F1");
  expect(patched.init.method).toBe("PATCH");
  expect(new Headers(patched.init.headers).get("Content-Type")).toBe("application/json");
  expect(patched.init.body).toBe('{"enabled":false}');

  const tested = await capture(() => testDestination("nd_1"), fixtureTestOk);
  expect(tested.url).toBe("/api/notifications/destinations/nd_1/test");
  expect(tested.init.method).toBe("POST");
  expect(new Headers(tested.init.headers).get("Content-Type")).toBe("application/json");

  const removed = await capture(() => deleteDestination("nd_1"), null, 204);
  expect(removed.url).toBe("/api/notifications/destinations/nd_1");
  expect(removed.init.method).toBe("DELETE");

  const original = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ error: "Not found" }), { status: 404, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
  try {
    expect(await fetchCatalog()).toBeNull();
  } finally {
    globalThis.fetch = original;
  }
});
