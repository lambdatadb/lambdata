import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { authHeaders, seedUser, useTempMetadata, type SeededUser, type TempMetadata } from "../harness/sqlite";
import { buildApp } from "../../src/server";
import { audit, settings, users } from "../../src/db/queries";
import { db } from "../../src/db/client";
import { COOKIE_NAME, signJwt } from "../../src/auth/jwt";
import { resetAccessTokenRateLimits } from "../../src/accessTokens/gate";
import { accessTokenForUser, scrubSecrets } from "../../src/accessTokens/index";
import { CAPABILITIES, allPresetInfo, hasTriedSummary, matchCapability } from "../../src/accessTokens/capabilities";
import { LAN, LOOPBACK, TAILNET, createToken, session, withToken, type App } from "./helpers";

let md: TempMetadata;
let app: App;
let admin: SeededUser;

beforeAll(() => {
  md = useTempMetadata();
  app = buildApp();
  admin = seedUser("admin");
  settings.set("setup_complete", "1");
});

afterAll(() => md.cleanup());

beforeEach(() => {
  resetAccessTokenRateLimits();
  settings.set("access_tokens_paused", "0");
});

function allText(): string {
  const tables = db.query("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[];
  const parts: string[] = [];
  for (const { name } of tables) {
    for (const row of db.query(`SELECT * FROM "${name}"`).all() as Record<string, unknown>[]) {
      parts.push(JSON.stringify(row));
    }
  }
  return parts.join("\n");
}

describe("token creation", () => {
  test("the secret is shown once and only its hash is stored", async () => {
    const { token, secret } = await createToken(app, admin, { name: "Nightly report", preset: "read_only" });
    expect(secret).toMatch(/^ld_[A-Za-z0-9]{40,}$/);
    expect(token.prefix).toBe(secret.slice(0, 9));
    expect(token.status).toBe("active");
    expect(token.allowedFrom).toEqual(["loopback", "lan", "tailnet"]);
    expect(token.limits).toEqual({ maxDatabases: null, requestsPerMinute: 120 });
    expect(token.revealCredentials).toBe(false);
    const read = await session(app, admin, `/api/access-tokens/${token.id}`);
    expect(JSON.stringify(await read.json())).not.toContain(secret);
    const list = await session(app, admin, "/api/access-tokens");
    const listed = await list.json();
    expect(JSON.stringify(listed)).not.toContain(secret);
    expect(listed.presets.map((p: { preset: string }) => p.preset)).toEqual(["read_only", "builder", "admin"]);
    await withToken(app, secret, "/api/databases", { headers: { "X-LambData-Note": `leaking ${secret} here` } });
    expect(allText()).not.toContain(secret.slice(3));
  });

  test("preset defaults follow the brief", async () => {
    const presets = allPresetInfo();
    const by = Object.fromEntries(presets.map((p) => [p.preset, p]));
    expect(by.read_only!.canRevealCredentials).toBe(false);
    expect(by.builder!.defaults).toMatchObject({ revealCredentials: true, askFirst: false, limits: { maxDatabases: 10, requestsPerMinute: 120 } });
    expect(by.admin!.defaults).toMatchObject({ revealCredentials: false, askFirst: true, limits: { maxDatabases: null } });
    const builder = await createToken(app, admin, { name: "Builder defaults", preset: "builder" });
    expect(builder.token).toMatchObject({ revealCredentials: true, askFirst: false, limits: { maxDatabases: 10 } });
    const adminToken = await createToken(app, admin, { name: "Admin defaults", preset: "admin" });
    expect(adminToken.token).toMatchObject({ revealCredentials: false, askFirst: true, limits: { maxDatabases: null } });
  });

  test("a read only token can never see passwords and a preset cannot change", async () => {
    const bad = await session(app, admin, "/api/access-tokens", "POST", { name: "x", preset: "read_only", revealCredentials: true });
    expect(bad.status).toBe(400);
    const { token } = await createToken(app, admin, { name: "Fixed preset", preset: "builder" });
    const patch = await session(app, admin, `/api/access-tokens/${token.id}`, "PATCH", { preset: "admin" });
    expect(patch.status).toBe(400);
    expect((await patch.json()).error).toContain("cannot change");
  });

  test("only admin sessions manage tokens", async () => {
    const owner = seedUser("db_owner");
    expect((await session(app, owner, "/api/access-tokens")).status).toBe(403);
    expect((await session(app, owner, "/api/access-tokens", "POST", { name: "x", preset: "admin" })).status).toBe(403);
    const { secret } = await createToken(app, admin, { name: "Self manager", preset: "admin" });
    for (const [method, path, body] of [
      ["GET", "/api/access-tokens", undefined],
      ["POST", "/api/access-tokens", { name: "child", preset: "admin" }],
      ["PUT", "/api/access-tokens/pause-all", { paused: false }],
    ] as const) {
      const res = await withToken(app, secret, path, { method, body });
      expect(res.status).toBe(403);
    }
  });

  test("audit actions are written for create, update, revoke and pause all", async () => {
    const { token } = await createToken(app, admin, { name: "Audited", preset: "builder" });
    await session(app, admin, `/api/access-tokens/${token.id}`, "PATCH", { name: "Audited two", askFirst: true });
    await session(app, admin, `/api/access-tokens/${token.id}`, "DELETE");
    await session(app, admin, "/api/access-tokens/pause-all", "PUT", { paused: true });
    await session(app, admin, "/api/access-tokens/pause-all", "PUT", { paused: false });
    const entries = audit.list(50);
    const actions = entries.filter((e) => e.target === token.id || e.action === "access_token.pause_all").map((e) => e.action);
    expect(actions).toContain("access_token.create");
    expect(actions).toContain("access_token.update");
    expect(actions).toContain("access_token.revoke");
    expect(actions).toContain("access_token.pause_all");
    const create = entries.find((e) => e.action === "access_token.create" && e.target === token.id)!;
    expect(JSON.parse(create.details!)).toEqual({ name: "Audited", preset: "builder" });
    const revoked = await session(app, admin, `/api/access-tokens/${token.id}`);
    expect((await revoked.json()).token).toMatchObject({ status: "revoked", name: "Audited two" });
  });
});

describe("the gate", () => {
  test("a bearer that is not an access token is left alone", async () => {
    const plain = await app.request("/api/databases", { headers: { Authorization: "Bearer not-a-token" } }, LOOPBACK);
    expect(plain.status).toBe(401);
    expect((await plain.json()).error).toBe("not authenticated");
    const withCookie = await app.request(
      "/api/databases",
      { headers: await authHeaders(admin, { Authorization: "Bearer eyJhbGciOiJIUzI1NiJ9.e30.x" }) },
      LOOPBACK,
    );
    expect(withCookie.status).toBe(200);
    const garbled = await app.request(
      "/api/databases",
      { headers: await authHeaders(admin, { Authorization: "Bearer ld_abc extra" }) },
      LOOPBACK,
    );
    expect(garbled.status).toBe(401);
  });

  test("app-facing addresses refuse access tokens", async () => {
    const { secret } = await createToken(app, admin, { name: "App facing", preset: "admin" });
    for (const path of ["/api/data/shop/items", "/functions/v1/hello", "/api/app-auth/user", "/api/realtime/broadcast"]) {
      const res = await withToken(app, secret, path, { method: path.includes("broadcast") ? "POST" : "GET", body: path.includes("broadcast") ? {} : undefined });
      expect(res.status).toBe(401);
      expect((await res.json()).error).toContain("not accepted here");
    }
  });

  test("unknown, revoked and expired tokens get 401", async () => {
    const unknown = await withToken(app, `ld_${"x".repeat(43)}`, "/api/databases");
    expect(unknown.status).toBe(401);
    expect(unknown.headers.get("WWW-Authenticate")).toContain("Bearer");
    expect((await unknown.json()).error).toEndWith("An admin creates access tokens in the console under Access tokens.");
    const { token, secret } = await createToken(app, admin, { name: "Soon revoked", preset: "read_only" });
    expect((await withToken(app, secret, "/api/databases")).status).toBe(200);
    await session(app, admin, `/api/access-tokens/${token.id}`, "DELETE");
    const revoked = await withToken(app, secret, "/api/databases");
    expect(revoked.status).toBe(401);
    expect((await revoked.json()).error).toContain("revoked");

    const soon = await createToken(app, admin, { name: "Expiring", preset: "read_only", expiresAt: Date.now() + 60_000 });
    expect((await withToken(app, soon.secret, "/api/databases")).status).toBe(200);
    db.query("UPDATE access_tokens SET expires_at = ? WHERE id = ?").run(Date.UTC(2026, 0, 2, 3, 4), soon.token.id);
    const expired = await withToken(app, soon.secret, "/api/databases");
    expect(expired.status).toBe(401);
    expect((await expired.json()).error).toContain("expired on 2026-01-02 03:04 UTC");
    const past = await session(app, admin, "/api/access-tokens", "POST", { name: "past", preset: "read_only", expiresAt: Date.now() - 1000 });
    expect(past.status).toBe(400);
  });

  test("paused tokens and pause all answer 403", async () => {
    const { token, secret } = await createToken(app, admin, { name: "Pausable", preset: "read_only" });
    await session(app, admin, `/api/access-tokens/${token.id}`, "PATCH", { paused: true });
    const paused = await withToken(app, secret, "/api/databases");
    expect(paused.status).toBe(403);
    expect((await paused.json()).error).toContain("paused");
    const current = await withToken(app, secret, "/api/access-tokens/current");
    expect(current.status).toBe(200);
    expect((await current.json()).token.status).toBe("paused");
    await session(app, admin, `/api/access-tokens/${token.id}`, "PATCH", { paused: false });
    expect((await withToken(app, secret, "/api/databases")).status).toBe(200);

    await session(app, admin, "/api/access-tokens/pause-all", "PUT", { paused: true });
    const all = await withToken(app, secret, "/api/databases");
    expect(all.status).toBe(403);
    expect((await all.json()).error).toContain("All access tokens are paused");
    const identity = await (await withToken(app, secret, "/api/access-tokens/current")).json();
    expect(identity.allPaused).toBe(true);
    await session(app, admin, "/api/access-tokens/pause-all", "PUT", { paused: false });
    expect((await withToken(app, secret, "/api/databases")).status).toBe(200);
  });

  test("a connection group outside allowedFrom is refused with its name", async () => {
    const { secret } = await createToken(app, admin, { name: "Loopback only", preset: "read_only", allowedFrom: ["loopback"] });
    expect((await withToken(app, secret, "/api/databases", { env: LOOPBACK })).status).toBe(200);
    const lan = await withToken(app, secret, "/api/databases", { env: LAN });
    expect(lan.status).toBe(403);
    expect((await lan.json()).error).toContain("the local network (LAN)");
    const tail = await withToken(app, secret, "/api/databases", { env: TAILNET });
    expect(tail.status).toBe(403);
    expect((await tail.json()).error).toContain("your tailnet");
    const cf = await withToken(app, secret, "/api/databases", { env: LOOPBACK, headers: { "cf-ray": "8a1b2c3d4e5f-AMS", "cf-connecting-ip": "203.0.113.50" } });
    expect(cf.status).toBe(403);
  });

  test("the rate limit answers 429 with Retry-After", async () => {
    const { secret } = await createToken(app, admin, { name: "Slow", preset: "read_only", limits: { requestsPerMinute: 3 } });
    for (let i = 0; i < 3; i++) expect((await withToken(app, secret, "/api/databases")).status).toBe(200);
    const limited = await withToken(app, secret, "/api/databases");
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get("Retry-After"))).toBeGreaterThan(0);
  });

  test("nothing on the never list is reachable with an admin token", async () => {
    const { secret } = await createToken(app, admin, { name: "Never", preset: "admin", revealCredentials: true, askFirst: false });
    const never: [string, string][] = [
      ["GET", "/api/users"],
      ["POST", "/api/users"],
      ["PATCH", `/api/users/${admin.id}`],
      ["DELETE", `/api/users/${admin.id}`],
      ["POST", "/api/auth/login"],
      ["POST", "/api/auth/logout"],
      ["POST", "/api/auth/logout-all"],
      ["GET", "/api/auth/me"],
      ["GET", "/api/setup/state"],
      ["POST", "/api/setup/complete"],
      ["POST", "/api/setup/data-dir"],
      ["GET", "/api/settings"],
      ["PATCH", "/api/settings"],
      ["POST", "/api/settings/data-dir"],
      ["GET", "/api/system/audit-logs"],
      ["POST", "/api/system/pick-folder"],
      ["POST", "/api/system/validate-path"],
      ["GET", "/api/network/status"],
      ["PUT", "/api/network/policy"],
      ["POST", "/api/network/tailscale/serve"],
      ["PUT", "/api/network/cloudflare/tunnel"],
      ["GET", "/api/network/rejected-connections"],
      ["GET", "/api/tailscale/status"],
      ["POST", "/api/tailscale/up"],
      ["POST", "/api/tailscale/down"],
      ["GET", "/api/notifications/destinations"],
      ["POST", "/api/notifications/destinations"],
      ["GET", "/api/storage/buckets"],
      ["POST", "/api/storage/buckets"],
      ["GET", "/api/functions"],
      ["POST", "/api/functions"],
      ["GET", "/api/functions/secrets"],
      ["GET", "/api/app-auth/settings"],
      ["GET", "/api/app-auth/users"],
      ["GET", "/api/realtime/status"],
      ["GET", "/api/dashboard/summary"],
      ["GET", "/api/dashboard/vitals"],
      ["GET", "/api/data-access"],
      ["GET", "/api/databases/db_x/checkpoints/cp_y/download"],
      ["PATCH", "/api/databases/db_x/checkpoints/cp_y"],
      ["GET", "/api/databases/db_x/rejected-connections"],
      ["DELETE", "/api/data-access/shop/denials"],
      ["GET", "/api/access-tokens"],
      ["POST", "/api/access-tokens"],
      ["GET", "/api/access-tokens/tok_x"],
      ["PATCH", "/api/access-tokens/tok_x"],
      ["DELETE", "/api/access-tokens/tok_x"],
      ["GET", "/api/access-tokens/tok_x/activity"],
      ["PUT", "/api/access-tokens/pause-all"],
      ["POST", "/api/approvals/ap_x/decision"],
      ["GET", "/api/health/deep"],
      ["GET", "/"],
      ["GET", "/api/databases/db_x/%2e%2e/%2e%2e/users"],
      ["GET", "/api//users"],
    ];
    for (const [method, path] of never) {
      const res = await withToken(app, secret, path, { method, body: ["POST", "PUT", "PATCH"].includes(method) ? {} : undefined });
      expect({ method, path, status: res.status }).toEqual({ method, path, status: 403 });
    }
    for (const c of CAPABILITIES) {
      expect(c.path.startsWith("/api/users") || c.path.startsWith("/api/settings") || c.path.startsWith("/api/network")).toBe(false);
    }
  });

  test("a session cookie on the same request is ignored", async () => {
    const { secret } = await createToken(app, admin, { name: "Cookie mix", preset: "read_only" });
    const res = await app.request(
      "/api/users",
      { headers: await authHeaders(admin, { Authorization: `Bearer ${secret}` }) },
      LOOPBACK,
    );
    expect(res.status).toBe(403);
    const me = await app.request(
      "/api/access-tokens/current",
      { headers: await authHeaders(admin, { Authorization: `Bearer ${secret}` }) },
      LOOPBACK,
    );
    expect((await me.json()).token.name).toBe("Cookie mix");
  });

  test("GET /api/access-tokens/current describes the token", async () => {
    const { token, secret } = await createToken(app, admin, { name: "Who am I", preset: "builder" });
    const res = await withToken(app, secret, "/api/access-tokens/current");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.token.id).toBe(token.id);
    expect(body.can.length).toBeGreaterThan(3);
    expect(body.cannot.join(" ")).toContain("Manage access tokens");
    expect(body.allPaused).toBe(false);
    const viaSession = await session(app, admin, "/api/access-tokens/current");
    expect(viaSession.status).toBe(401);
  });

  test("activity is recorded with a cleaned note and no secret", async () => {
    const { token, secret } = await createToken(app, admin, { name: "Diary", preset: "read_only" });
    const long = `why\t\t ${"a".repeat(300)}`;
    await withToken(app, secret, "/api/databases", { headers: { "X-LambData-Note": long } });
    await withToken(app, secret, "/api/users");
    await withToken(app, secret, "/api/databases/db_missing");
    const res = await session(app, admin, `/api/access-tokens/${token.id}/activity?limit=2`);
    const page = await res.json();
    expect(page.entries).toHaveLength(2);
    expect(page.nextBefore).toBe(page.entries[1].id);
    const rest = await (await session(app, admin, `/api/access-tokens/${token.id}/activity?before=${page.nextBefore}`)).json();
    const all = [...page.entries, ...rest.entries];
    expect(all.map((e: { action: string }) => e.action)).toEqual(["database.read", "request.refused", "database.list"]);
    const listed = all[2];
    expect(listed).toMatchObject({ via: "api", outcome: "ok", status: 200, summary: "Listed databases.", from: "127.0.0.1" });
    expect(listed.note.startsWith("why a")).toBe(true);
    expect(listed.note.length).toBe(200);
    expect(all[1]).toMatchObject({ outcome: "refused", status: 403 });
    expect(all[0]).toMatchObject({ outcome: "refused", status: 404, summary: "Tried to read the details of a database." });
    expect(all[1].summary).toBe("Tried GET /api/users.");
    expect(JSON.stringify(all)).not.toContain(secret);
    const fresh = await (await session(app, admin, `/api/access-tokens/${token.id}`)).json();
    expect(fresh.token.lastUsedAt).toBeGreaterThan(0);
    expect(fresh.token).toMatchObject({ lastUsedFrom: "127.0.0.1", lastUsedVia: "api" });
  });

  test("notes may be percent-encoded UTF-8", async () => {
    const { token, secret } = await createToken(app, admin, { name: "Polyglot", preset: "read_only" });
    const text = "Δοκιμή σημείωσης: 日本語のメモ";
    await withToken(app, secret, "/api/databases", { headers: { "X-LambData-Note": encodeURIComponent(text) } });
    await withToken(app, secret, "/api/databases", { headers: { "X-LambData-Note": "50% done, %E0%A4%A broken" } });
    await withToken(app, secret, "/api/databases", { headers: { "X-LambData-Note": encodeURIComponent(`${"€".repeat(250)}\n`) } });
    const { entries } = await (await session(app, admin, `/api/access-tokens/${token.id}/activity`)).json();
    expect(entries[2].note).toBe(text);
    expect(entries[1].note).toBe("50% done, %E0%A4%A broken");
    expect(entries[0].note).toBe("€".repeat(200));
  });

  test("the scrubber hides secrets but not database user names", () => {
    const secret = `ld_${"aB3".repeat(15)}`;
    expect(scrubSecrets(`user ld_garden_planner_ab12cd34 failed`)).toBe("user ld_garden_planner_ab12cd34 failed");
    expect(scrubSecrets(`token ${secret} leaked`)).toBe("token ld_[hidden] leaked");
    expect(scrubSecrets(`ld_${"a".repeat(39)}`)).toBe(`ld_${"a".repeat(39)}`);
    expect(scrubSecrets(`Bearer ${secret}.`)).toBe("Bearer ld_[hidden].");
  });

  test("every capability has a wording for a request that did not succeed", () => {
    for (const c of CAPABILITIES) expect({ action: c.action, tried: hasTriedSummary(c) }).toEqual({ action: c.action, tried: true });
  });

  test("the capability table matches paths exactly", () => {
    expect(matchCapability("GET", "/api/databases/db_1")?.params).toEqual({ id: "db_1" });
    expect(matchCapability("GET", "/api/databases/db_1/checkpoints/status")?.capability.action).toBe("checkpoint.status");
    expect(matchCapability("GET", "/api/databases/db_1/checkpoints/cp_1")?.capability.action).toBe("checkpoint.read");
    expect(matchCapability("HEAD", "/api/databases")?.capability.action).toBe("database.list");
    expect(matchCapability("GET", "/api/databases/db_1/checkpoints/cp_1/download")).toBeNull();
    expect(matchCapability("POST", "/api/users")).toBeNull();
  });
});

describe("the token actor", () => {
  test("cannot sign in, is not listed and cannot be edited or removed", async () => {
    const { token } = await createToken(app, admin, { name: "Hidden actor", preset: "admin" });
    const row = db.query("SELECT actor_user_id AS id FROM access_tokens WHERE id = ?").get(token.id) as { id: string };
    const actor = users.byId(row.id)!;
    expect(actor.kind).toBe("token");
    expect(actor.displayName).toBe("Hidden actor");
    const login = await app.request(
      "/api/auth/login",
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: actor.email, password: "!" }) },
      LOOPBACK,
    );
    expect(login.status).toBe(401);
    const list = await (await session(app, admin, "/api/users")).json();
    expect(list.users.some((u: { id: string }) => u.id === actor.id)).toBe(false);
    expect((await session(app, admin, `/api/users/${actor.id}`, "PATCH", { displayName: "x" })).status).toBe(404);
    expect((await session(app, admin, `/api/users/${actor.id}`, "DELETE")).status).toBe(404);
    const forged = await app.request(
      "/api/auth/me",
      { headers: { Cookie: `${COOKIE_NAME}=${await signJwt(actor.id, "admin")}` } },
      LOOPBACK,
    );
    expect(forged.status).toBe(401);
    const taken = await session(app, admin, "/api/users", "POST", { email: actor.email, password: "password123", role: "admin" });
    expect(taken.status).toBe(409);
    expect(accessTokenForUser(actor.id)).toEqual({ id: token.id, name: "Hidden actor" });
    expect(accessTokenForUser(admin.id)).toBeNull();
    await session(app, admin, `/api/access-tokens/${token.id}`, "PATCH", { name: "Renamed actor" });
    expect(users.byId(row.id)!.displayName).toBe("Renamed actor");
  });

  test("removing the admin who created a token revokes it", async () => {
    const second = seedUser("admin");
    const res = await session(app, second, "/api/access-tokens", "POST", { name: "Orphan", preset: "read_only" });
    const { token, secret } = await res.json();
    expect((await withToken(app, secret, "/api/databases")).status).toBe(200);
    expect((await session(app, admin, `/api/users/${second.id}`, "DELETE")).status).toBe(200);
    const after = await withToken(app, secret, "/api/databases");
    expect(after.status).toBe(401);
    const stored = await (await session(app, admin, `/api/access-tokens/${token.id}`)).json();
    expect(stored.token.status).toBe("revoked");
    expect(stored.token.createdByDisplayName).toMatch(/^admin \d+$/);
    expect(audit.list(10).some((e) => e.action === "access_token.revoke" && e.target === token.id)).toBe(true);
  });

  test("a token stops working when its creator is no longer an admin", async () => {
    const third = seedUser("admin");
    const res = await session(app, third, "/api/access-tokens", "POST", { name: "Demoted", preset: "read_only" });
    const { secret } = await res.json();
    users.updateRole(third.id, "viewer");
    const after = await withToken(app, secret, "/api/databases");
    expect(after.status).toBe(401);
    expect((await after.json()).error).toContain("no longer an admin");
  });
});
