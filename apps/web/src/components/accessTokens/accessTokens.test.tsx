import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StaticRouter } from "react-router-dom/server";
import type { AccessTokenListResponse, AccessTokenPresetInfo, AuditLogEntry, TokenActivityResponse } from "@lambdata/shared";
import {
  FIXTURE_SECRET,
  fixtureActivity,
  fixtureApprovalList,
  fixtureApprovals,
  fixturePresets,
  fixtureTokenList,
  fixtureTokens,
} from "../../pages/accessTokens/fixtures";
import {
  activityPath,
  applyPreset,
  connectSnippets,
  createAccessToken,
  createRequest,
  decideApproval,
  effectiveApprovalStatus,
  fetchActivity,
  mergeActivityPages,
  newDraft,
  pauseAllAccessTokens,
  pendingCount,
  presetInfo,
  splitApprovals,
  updateRequest,
  validateDraft,
  draftFromToken,
} from "../../lib/accessTokens";
import { ApiError } from "../../lib/api";
import { NavGroups } from "../layout/Sidebar";
import { commands as tokenCommands } from "../../commands/accessTokens";
import { commands as coreCommands } from "../../commands/core";
import { ApprovalsWaitingAlert } from "../../pages/dashboard/ApprovalsBanner";
import { ApprovalConfirmBody, approvedMessage } from "../../pages/accessTokens/ApprovalsPage";
import { PauseAllControl, pauseAllCopy } from "../../pages/AccessTokens";
import { TokenSettings, TokenStateAlert } from "../../pages/accessTokens/TokenPage";
import { ActorCell, tokenTarget } from "../../pages/Activity";
import { DatabaseOwner } from "../../pages/database";
import { triggerMeta, isAutomatic } from "../checkpoints/meta";
import { operationSuccess } from "../checkpoints/OperationPanel";
import { ActivityList, ActivityRow } from "./ActivityList";
import { DecidedApprovalList, PendingApprovalCard } from "./ApprovalList";
import { ConnectAgent, type ConnectTab } from "./ConnectAgent";
import { CreateTokenForm, CreatedTokenPanel, createFlow, type CreateFlowState } from "./CreateTokenDialog";
import { TokenTable, TokensEmpty, visibleTokens } from "./TokenList";

declare const test: (name: string, fn: () => void | Promise<void>) => void;
declare const expect: (value: unknown) => {
  toBe(expected: unknown): void;
  toEqual(expected: unknown): void;
  toContain(expected: unknown): void;
  toBeNull(): void;
  toBeGreaterThan(expected: number): void;
  not: { toContain(expected: unknown): void; toBe(expected: unknown): void; toBeNull(): void };
};

const ORIGIN = "https://lambdata.example.com";

function render(node: ReactElement, location = "/access-tokens"): string {
  const client = new QueryClient();
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <StaticRouter location={location}>{node}</StaticRouter>
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

interface Captured {
  url: string;
  init: RequestInit;
}

async function withFetch<T>(responses: unknown[], run: (calls: Captured[]) => Promise<T>, status = 200): Promise<T> {
  const original = globalThis.fetch;
  const calls: Captured[] = [];
  let i = 0;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} });
    const body = responses[Math.min(i++, responses.length - 1)];
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  try {
    return await run(calls);
  } finally {
    globalThis.fetch = original;
  }
}

const NOW = Date.now();
const tokens = fixtureTokens(NOW);
const [builder, reader, expired, revoked] = tokens as [(typeof tokens)[0], (typeof tokens)[0], (typeof tokens)[0], (typeof tokens)[0]];
const databases = [
  { id: "db_fixture_store", displayName: "Storefront", name: "storefront" },
  { id: "db_fixture_ledger", displayName: "Ledger", name: "ledger" },
];

function form(draft = newDraft(fixturePresets), presets: AccessTokenPresetInfo[] = fixturePresets, serverError?: unknown): string {
  return render(
    <CreateTokenForm
      draft={draft}
      patch={() => undefined}
      onPreset={() => undefined}
      errors={validateDraft(draft)}
      presets={presets}
      databases={databases}
      serverError={serverError}
    />,
  );
}

test("the created panel shows the secret once with a copy button and the warning", () => {
  const t = text(render(<CreatedTokenPanel token={builder} secret={FIXTURE_SECRET} origin={ORIGIN} />));
  expect(t).toContain("Copy token");
  expect(t).toContain("This is the only time the secret is shown");
  expect(t).toContain("revoke this token and create a new one");
  expect(t).toContain("Connect an agent");
  expect(render(<CreatedTokenPanel token={builder} secret={FIXTURE_SECRET} origin={ORIGIN} />)).toContain(FIXTURE_SECRET);
});

test("closing the created panel forgets the secret, and nothing keeps it in the query cache", async () => {
  const created: CreateFlowState = createFlow({ phase: "form" }, { type: "created", token: builder, secret: FIXTURE_SECRET });
  expect(created.phase).toBe("created");
  const closed = createFlow(created, { type: "reset" });
  expect(JSON.stringify(closed)).not.toContain(FIXTURE_SECRET);
  expect(closed.phase).toBe("form");

  const qc = new QueryClient();
  const before: AccessTokenListResponse = fixtureTokenList(NOW, { tokens: [reader] });
  qc.setQueryData(["access-tokens", "list"], before);
  const newToken = { ...builder, id: "tok_new", name: "New bot" };
  const res = await withFetch([{ token: newToken, secret: FIXTURE_SECRET }, fixtureTokenList(NOW)], async (calls) => {
    const out = await createAccessToken(qc, createRequest(newDraft(fixturePresets), presetInfo(fixturePresets, "builder")));
    expect(calls[0]!.url).toBe("/api/access-tokens");
    expect(calls[0]!.init.method).toBe("POST");
    expect(String(calls[0]!.init.body)).not.toContain(FIXTURE_SECRET);
    return out;
  });
  expect(res.secret).toBe(FIXTURE_SECRET);
  const cached = JSON.stringify([
    ...qc.getQueryCache().getAll().map((q) => q.state.data),
    ...qc.getMutationCache().getAll().map((m) => m.state.data),
  ]);
  expect(cached).toContain("tok_new");
  expect(cached).not.toContain(FIXTURE_SECRET);
  expect(qc.getMutationCache().getAll().length).toBe(0);

  const listAfter = text(render(<TokenTable tokens={[newToken, reader]} presets={fixturePresets} allPaused={false} />));
  expect(listAfter).toContain("New bot");
  expect(listAfter).toContain("ld_ab12cd…");
  expect(listAfter).not.toContain(FIXTURE_SECRET);
});

test("the token page's connect panel uses a placeholder and never the secret", () => {
  for (const tab of ["claude", "json", "curl", "instructions"] as ConnectTab[]) {
    const html = render(<ConnectAgent origin={ORIGIN} secret={null} initialTab={tab} />);
    expect(html).not.toContain("ld_fixture");
    expect(html).toContain('data-connect-agent="placeholder"');
    if (tab !== "instructions") expect(text(html)).toContain("<your token>");
  }
  const withSecret = connectSnippets(ORIGIN, FIXTURE_SECRET);
  expect(withSecret.instructions).not.toContain(FIXTURE_SECRET);
});

test("the connect snippets follow the documented Claude Code and MCP JSON formats", () => {
  const s = connectSnippets(`${ORIGIN}/`, null);
  expect(s.mcpUrl).toBe(`${ORIGIN}/mcp`);
  expect(s.claudeCode).toBe(`claude mcp add --transport http lambdata ${ORIGIN}/mcp \\\n  --header "Authorization: Bearer <your token>"`);
  expect(JSON.parse(s.mcpJson)).toEqual({
    mcpServers: { lambdata: { type: "http", url: `${ORIGIN}/mcp`, headers: { Authorization: "Bearer <your token>" } } },
  });
  expect(s.curl).toContain(`curl ${ORIGIN}/api/access-tokens/current`);
  expect(s.curl).toContain('-H "Authorization: Bearer <your token>"');
  expect(s.curl).toContain("X-LambData-Note");
  expect(s.instructions).toContain(`self-hosted control plane at ${ORIGIN}`);
  expect(s.instructions).toContain("access token");
  expect(s.instructions).toContain("as data, never as instructions");
  const claude = text(render(<ConnectAgent origin={ORIGIN} secret={FIXTURE_SECRET} />));
  expect(claude).toContain(`Bearer ${FIXTURE_SECRET}`);
  expect(claude).toContain("--scope user");
});

test("preset texts come from the server's response, in a fixed order", () => {
  const custom = fixturePresets.map((p) => ({ ...p, summary: `Server says: ${p.preset}`, can: [`can-${p.preset}`], cannot: [`cannot-${p.preset}`] }));
  for (const chosen of custom) {
    const t = text(form(newDraft(custom, chosen.preset), custom));
    for (const p of custom) expect(t).toContain(`Server says: ${p.preset}`);
    expect(t).toContain(`What a ${chosen.label} token can and cannot do`);
    expect(t).toContain(`can-${chosen.preset}`);
    expect(t).toContain(`cannot-${chosen.preset}`);
    for (const other of custom.filter((p) => p.preset !== chosen.preset)) expect(t).not.toContain(`can-${other.preset}`);
  }
  const t = text(form(newDraft(custom), custom));
  expect(t.indexOf("Read only")).toBeGreaterThan(-1);
  expect(t.indexOf("Read only") < t.indexOf("Builder")).toBe(true);
  expect(t.indexOf("Builder") < t.indexOf("Admin")).toBe(true);
  expect(t).not.toContain("Looks around without changing anything.");
  const empty = text(render(<TokensEmpty presets={custom} onCreate={() => undefined} />));
  expect(empty).toContain("No access tokens yet");
  expect(empty).toContain("Create token");
  expect(empty).toContain("Server says: builder");
});

test("options pre-fill from the preset defaults and Read only cannot see passwords", () => {
  const b = newDraft(fixturePresets, "builder");
  expect(b.revealCredentials).toBe(true);
  expect(b.askFirst).toBe(false);
  expect(b.maxDatabases).toBe("10");
  expect(b.requestsPerMinute).toBe("120");
  expect(b.allowedFrom).toEqual(["loopback", "lan", "tailnet"]);
  const a = applyPreset(b, presetInfo(fixturePresets, "admin")!);
  expect(a.askFirst).toBe(true);
  expect(a.revealCredentials).toBe(false);
  expect(a.maxDatabases).toBe("");
  const r = applyPreset({ ...b, revealCredentials: true }, presetInfo(fixturePresets, "read_only")!);
  expect(r.revealCredentials).toBe(false);
  expect(createRequest({ ...r, name: "x", revealCredentials: true }, presetInfo(fixturePresets, "read_only")).revealCredentials).toBe(false);

  const readOnly = text(form({ ...r, name: "Reporter" }));
  expect(readOnly).not.toContain("Can see database passwords");
  expect(readOnly).toContain("Read only tokens can never see database passwords.");
  expect(readOnly).not.toContain("Most databases it may create");
  expect(readOnly).toContain("Only the databases I pick");

  const builderForm = text(form({ ...b, name: "Build bot" }));
  expect(builderForm).toContain("Can see database passwords");
  expect(builderForm).toContain("can only ever see and control the databases it creates");
  expect(builderForm).not.toContain("Only the databases I pick");
  expect(builderForm).toContain("Ask me first before deleting or rolling back");
  expect(builderForm).toContain("Reachable from the internet through your Cloudflare tunnel.");
  expect(builderForm).toContain("Anything that reaches the console's port directly. If that port is forwarded on your router, this includes the internet.");
  expect(form({ ...b, name: "x" })).toContain('value="10"');

  const settings = text(render(<TokenSettings token={builder} info={presetInfo(fixturePresets, "builder")} databases={databases} />));
  expect(settings).toContain("If that port is forwarded on your router, this includes the internet.");
  expect(settings).toContain("Reachable from the internet through your Cloudflare tunnel.");

  const withCloudflare = form({ ...b, name: "x", allowedFrom: ["cloudflare"] });
  expect(withCloudflare).toContain("data-cloudflare-warning");
});

test("validation and a server refusal are shown in the create form", () => {
  const draft = { ...newDraft(fixturePresets), name: " ", expiry: "date" as const, expiryDate: "2001-01-01", allowedFrom: [], requestsPerMinute: "abc" };
  const errors = validateDraft(draft, NOW);
  expect(errors.name).toContain("Give the token a name");
  expect(errors.expiryDate).toBe("Pick a day in the future.");
  expect(errors.allowedFrom).toContain("at least one place");
  expect(errors.requestsPerMinute).toContain("whole number");
  const t = text(form(draft));
  expect(t).toContain("Pick a day in the future.");
  expect(t).toContain("Pick at least one place the token may be used from.");
  const limited = validateDraft({ ...newDraft(fixturePresets, "admin"), name: "x", limitDatabases: true, databaseIds: [] });
  expect(limited.databaseIds).toContain("Pick at least one database");
  const refused = text(form({ ...newDraft(fixturePresets), name: "Build bot" }, fixturePresets, new ApiError("A token with this name already exists.", 400)));
  expect(refused).toContain("The token was not created");
  expect(refused).toContain("A token with this name already exists.");
});

test("create and update requests carry only what they should", () => {
  const draft = { ...newDraft(fixturePresets, "admin"), name: "  Ops  ", expiry: "30" as const, limitDatabases: true, databaseIds: ["db_fixture_store"] };
  const req = createRequest(draft, presetInfo(fixturePresets, "admin"), NOW);
  expect(req.name).toBe("Ops");
  expect(req.expiresAt).toBe(NOW + 30 * 24 * 60 * 60 * 1000);
  expect(req.databaseIds).toEqual(["db_fixture_store"]);
  expect(req.limits).toEqual({ maxDatabases: null, requestsPerMinute: 120 });
  expect(createRequest({ ...newDraft(fixturePresets, "builder"), name: "b", limitDatabases: true, databaseIds: ["x"] }, undefined).databaseIds).toBeNull();

  const info = presetInfo(fixturePresets, "builder");
  expect(updateRequest(builder, draftFromToken(builder), info)).toEqual({});
  const changed = updateRequest(builder, { ...draftFromToken(builder), name: "Build bot 2", askFirst: false, requestsPerMinute: "30" }, info);
  expect(changed).toEqual({ name: "Build bot 2", askFirst: false, limits: { requestsPerMinute: 30 } });
  expect(updateRequest(builder, { ...draftFromToken(builder), expiry: "never", expiryDate: "" }, info)).toEqual({});
});

test("the list shows status, preset, prefix and last use; revoked tokens are quiet and can be hidden", () => {
  const html = render(<TokenTable tokens={tokens} presets={fixturePresets} allPaused={false} />);
  const t = text(html);
  expect(t).toContain("Build bot");
  expect(t).toContain("Builder");
  expect(t).toContain("ld_ab12cd…");
  expect(t).toContain("from 203.0.113.7");
  expect(t).toContain("1 waiting");
  expect(t).toContain("Never used");
  expect(html).toContain('data-token-status="paused"');
  expect(html).toContain('data-token-status="expired"');
  expect(html).toContain('data-token-status="revoked"');
  expect(html).toContain('href="/access-tokens/tok_builder"');
  expect(visibleTokens(tokens, false).map((x) => x.id)).toEqual(["tok_builder", "tok_reader", "tok_old"]);
  expect(visibleTokens(tokens, true).length).toBe(4);
  const all = text(render(<TokenTable tokens={[builder]} presets={fixturePresets} allPaused />));
  expect(all).toContain("paused (all)");
});

test("pause all asks first and says what happens", () => {
  const off = text(render(<PauseAllControl allPaused={false} onToggle={() => undefined} />));
  expect(off).toContain("Pause all tokens");
  expect(off).toContain("tokens work");
  const on = render(<PauseAllControl allPaused onToggle={() => undefined} />);
  expect(on).toContain('data-pause-all="on"');
  expect(text(on)).toContain("Every token is refused right now.");
  expect(pauseAllCopy(true).title).toBe("Pause every access token?");
  expect(pauseAllCopy(true).description).toContain("refused until you turn this off");
  expect(pauseAllCopy(false).confirmLabel).toBe("Resume tokens");
});

test("pause all, approve and deny send the contract's requests", async () => {
  await withFetch([{ allPaused: true }], async (calls) => {
    expect((await pauseAllAccessTokens(true)).allPaused).toBe(true);
    expect(calls[0]!.url).toBe("/api/access-tokens/pause-all");
    expect(calls[0]!.init.method).toBe("PUT");
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ paused: true });
  });
  const [first] = fixtureApprovals(NOW);
  await withFetch([{ approval: { ...first, status: "approved" } }, { approval: { ...first, status: "denied" } }], async (calls) => {
    expect((await decideApproval("apr_drop", "approve")).approval.status).toBe("approved");
    expect((await decideApproval("apr_drop", "deny")).approval.status).toBe("denied");
    expect(calls[0]!.url).toBe("/api/approvals/apr_drop/decision");
    expect(calls[0]!.init.method).toBe("POST");
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ decision: "approve" });
    expect(JSON.parse(String(calls[1]!.init.body))).toEqual({ decision: "deny" });
  });
});

test("approvals list pending first with approve and deny, and handle expiry while open", () => {
  const all = fixtureApprovals(NOW);
  const { pending, decided } = splitApprovals(all, NOW);
  expect(pending.map((a) => a.id)).toEqual(["apr_drop"]);
  expect(decided.map((a) => a.id)).toEqual(["apr_late", "apr_used", "apr_denied"]);

  const card = render(<PendingApprovalCard approval={all[0]!} now={NOW} onApprove={() => undefined} onDeny={() => undefined} />);
  const t = text(card);
  expect(t).toContain("Run DROP or TRUNCATE");
  expect(t).toContain("Run DROP TABLE staging_orders on Storefront");
  expect(t).toContain("Build bot");
  expect(t).toContain("Cleaning up the staging table after the migration test");
  expect(t).toContain("expires in 23 hours");
  expect(t).toContain("Approve");
  expect(t).toContain("Deny");
  expect(t).toContain("Show the exact request");
  expect(card).not.toContain("disabled=\"\"");

  const later = NOW + 24 * 60 * 60 * 1000;
  expect(effectiveApprovalStatus(all[0]!, later)).toBe("expired");
  const stale = render(<PendingApprovalCard approval={all[0]!} now={later} onApprove={() => undefined} onDeny={() => undefined} />);
  expect(stale).toContain('data-approval-state="expired"');
  expect(stale).toContain("disabled=\"\"");
  expect(text(stale)).toContain("This request expired before anyone decided.");

  const confirm = text(render(<ApprovalConfirmBody approval={all[0]!} />));
  expect(confirm).toContain("Run DROP TABLE staging_orders on Storefront");
  expect(confirm).toContain("Asked by Build bot on Storefront.");
  expect(approvedMessage(all[0]!).description).toBe("Build bot has 60 minutes to carry it out. After that it has to ask again.");
  expect(approvedMessage({ ...all[0]!, approvedUntil: null }).description).toContain("has 60 minutes");
  const timed = approvedMessage({ ...all[0]!, approvedUntil: NOW + 45 * 60_000 }, NOW).description;
  expect(timed).toContain("Build bot may carry it out until");
  expect(timed).toContain("(45 minutes)");
  const approvedLine = text(render(<DecidedApprovalList approvals={[{ ...all[0]!, status: "approved", decidedAt: NOW, approvedUntil: NOW + 60 * 60_000 }]} now={NOW} />));
  expect(approvedLine).toContain("the agent may carry it out until");

  const history = render(<DecidedApprovalList approvals={decided} now={NOW} />);
  expect(history).toContain('data-approval-state="used"');
  expect(history).toContain('data-approval-state="denied"');
  expect(history).toContain('data-approval-state="expired"');
  expect(text(history)).toContain("Approved by Avery Chen, carried out");
  expect(text(history)).toContain("Nobody decided in time");
});

test("activity pages with before, newest first, and expands the detail", async () => {
  expect(activityPath("tok_builder", null)).toBe("/access-tokens/tok_builder/activity?limit=50");
  expect(activityPath("tok_builder", 950)).toBe("/access-tokens/tok_builder/activity?before=950&limit=50");
  const page1: TokenActivityResponse = { entries: fixtureActivity(NOW, 1000, 50), nextBefore: 951 };
  const page2: TokenActivityResponse = { entries: fixtureActivity(NOW, 951, 20), nextBefore: null };
  await withFetch([page1, page2], async (calls) => {
    await fetchActivity("tok_builder", null);
    await fetchActivity("tok_builder", 951);
    expect(calls[0]!.url).toBe("/api/access-tokens/tok_builder/activity?limit=50");
    expect(calls[1]!.url).toBe("/api/access-tokens/tok_builder/activity?before=951&limit=50");
  });
  const merged = mergeActivityPages([page1, page2]);
  expect(merged.length).toBe(69);
  expect(merged[0]!.id).toBe(1000);
  expect(merged[merged.length - 1]!.id).toBe(932);

  const more = text(render(<ActivityList entries={merged.slice(0, 4)} hasMore />));
  expect(more).toContain("Show older activity");
  expect(more).toContain("ok");
  expect(more).toContain("error");
  expect(more).toContain("waiting for approval");
  expect(more).toContain("refused");
  expect(more).toContain("MCP");
  expect(more).toContain("API");
  expect(more).toContain("203.0.113.7");
  expect(more).toContain("Checking the order totals");
  expect(text(render(<ActivityList entries={merged.slice(0, 4)} hasMore={false} />))).not.toContain("Show older activity");
  expect(text(render(<ActivityList entries={[]} hasMore={false} />))).toContain("Every request this token makes appears here.");

  const sql = merged.find((e) => e.detail)!;
  expect(text(render(<ActivityRow entry={sql} />))).not.toContain("SELECT count(*)");
  expect(text(render(<ActivityRow entry={sql} initiallyOpen />))).toContain("SELECT count(*) FROM orders");
});

test("the dashboard banner appears only while approvals are waiting", () => {
  const data = fixtureApprovalList(NOW);
  expect(pendingCount(data, NOW)).toBe(1);
  const one = render(<ApprovalsWaitingAlert data={data} now={NOW} />);
  expect(one).toContain('data-approvals-waiting="1"');
  expect(text(one)).toContain("An agent is waiting for your approval");
  expect(text(one)).toContain("Build bot: Run DROP TABLE staging_orders on Storefront");
  expect(one).toContain('href="/access-tokens/approvals"');
  const two = { ...data, approvals: [data.approvals[0]!, { ...data.approvals[0]!, id: "apr_2" }] };
  expect(text(render(<ApprovalsWaitingAlert data={two} now={NOW} />))).toContain("2 agent requests are waiting for your approval");
  expect(render(<ApprovalsWaitingAlert data={{ approvals: [], pending: 0 }} now={NOW} />)).toBe("");
  expect(render(<ApprovalsWaitingAlert data={undefined} now={NOW} />)).toBe("");
});

test("navigation shows Access tokens to admins with a count badge, and the palette can create one", () => {
  const html = render(<NavGroups role="admin" pathname="/access-tokens/approvals" badges={{ approvals: 3 }} />);
  expect(text(html)).toContain("Access tokens");
  expect(html).toContain('data-nav-badge="approvals"');
  expect(text(html)).toContain("3 approvals waiting");
  expect(html).toContain('aria-current="page"');
  expect(render(<NavGroups role="admin" pathname="/" badges={{ approvals: 0 }} />)).not.toContain("data-nav-badge");
  expect(text(render(<NavGroups role="viewer" pathname="/" badges={{ approvals: 3 }} />))).not.toContain("Access tokens");

  const admin = { role: "admin" } as never;
  const owner = { role: "db_owner" } as never;
  const create = tokenCommands.find((c) => c.id === "access-tokens:create")!;
  expect(create.when!({ user: admin } as never)).toBe(true);
  expect(create.when!({ user: owner } as never)).toBe(false);
  let to = "";
  void create.run({ navigate: (p: string) => (to = p) } as never);
  expect(to).toBe("/access-tokens?create=");
  const nav = coreCommands.find((c) => c.id === "nav:/access-tokens")!;
  expect(nav.when!({ user: admin } as never)).toBe(true);
  expect(nav.when!({ user: owner } as never)).toBe(false);
});

test("activity entries by a token show its name with a tag and link to it", () => {
  const log: AuditLogEntry = {
    id: 1,
    user_id: "usr_token_actor",
    action: "database.create",
    target: "db_fixture_store",
    details: null,
    at: NOW,
    user_email: null,
    user_display_name: "Build bot",
    actor_kind: "token",
    token_id: "tok_builder",
  };
  expect(tokenTarget("apr_123")).toEqual({ label: "An approval request", href: "/access-tokens/approvals" });
  expect(tokenTarget("tok_builder")!.href).toBe("/access-tokens/tok_builder");
  expect(tokenTarget("db_fixture_store")).toBeNull();
  const html = render(<ActorCell log={log} />, "/activity");
  expect(html).toContain('data-actor="token"');
  expect(html).toContain('href="/access-tokens/tok_builder"');
  expect(text(html)).toContain("Build bot token");
  const person = render(<ActorCell log={{ ...log, actor_kind: "user", token_id: null, user_display_name: "Avery Chen", user_email: "admin@example.com" }} />);
  expect(person).toContain('data-actor="user"');
  expect(text(person)).toContain("admin@example.com");
});

test("a database created by a token says so where the owner is shown", () => {
  const html = render(<DatabaseOwner db={{ ownerDisplayName: "Build bot", createdByTokenId: "tok_builder", createdByTokenName: "Build bot" }} linkTokens />);
  expect(text(html)).toContain("created by token Build bot");
  expect(html).toContain('href="/access-tokens/tok_builder"');
  expect(render(<DatabaseOwner db={{ ownerDisplayName: "Build bot", createdByTokenId: "tok_builder", createdByTokenName: "Build bot" }} linkTokens={false} />)).not.toContain("href");
  expect(text(render(<DatabaseOwner db={{ ownerDisplayName: "Avery Chen", createdByTokenId: null, createdByTokenName: null }} linkTokens />))).toBe("· owned by Avery Chen");
});

test("token page alerts for revoked, expired and all-paused tokens, and the undo point badge", () => {
  expect(render(<TokenStateAlert token={revoked} allPaused={false} />)).toContain('data-token-alert="revoked"');
  expect(text(render(<TokenStateAlert token={revoked} allPaused={false} />))).toContain("can never be used again");
  expect(text(render(<TokenStateAlert token={expired} allPaused={false} />))).toContain("Pick a new expiry below");
  expect(render(<TokenStateAlert token={reader} allPaused={false} />)).toContain('data-token-alert="paused"');
  expect(render(<TokenStateAlert token={builder} allPaused />)).toContain('data-token-alert="all-paused"');
  expect(render(<TokenStateAlert token={builder} allPaused={false} />)).toBe("");
  expect(triggerMeta("pre-agent").label).toBe("undo point");
  expect(triggerMeta("pre-agent").hint).toContain("before an access token changed data");
  expect(isAutomatic("pre-agent")).toBe(true);
});

test("a finished mirror sync in History says what changed", () => {
  const job = {
    id: "job_sync",
    kind: "sync.run",
    status: "succeeded",
    result: {
      checkpointId: null,
      unchanged: false,
      changes: { tablesChanged: 0, tablesUnchanged: 4, exactTables: 4, netTables: 0, rowsAdded: 0, rowsRemoved: 0, rowsChanged: 0, rowDelta: 0, tables: [], truncated: false },
    },
  } as never;
  const html = render(<div>{operationSuccess(job, null, new Map())}</div>);
  expect(html).toContain('data-sync-changes="none"');
  expect(text(html)).toContain("Nothing changed in 4 tables.");
  const unknown = render(<div>{operationSuccess({ ...(job as object), result: { checkpointId: null, unchanged: false } } as never, null, new Map())}</div>);
  expect(unknown).toContain('data-sync-changes="unknown"');
});
