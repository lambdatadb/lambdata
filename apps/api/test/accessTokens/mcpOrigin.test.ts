import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { seedUser, useTempMetadata, type SeededUser, type TempMetadata } from "../harness/sqlite";
import { buildApp } from "../../src/server";
import { settings } from "../../src/db/queries";
import { savePolicy } from "../../src/network/config";
import { accessGuard } from "../../src/network/guard";
import { accessTokenGate, resetAccessTokenRateLimits } from "../../src/accessTokens/gate";
import { markMcpRequest } from "../../src/accessTokens/index";
import { TAILNET, createToken, session, type App } from "./helpers";

let md: TempMetadata;
let app: App;
let admin: SeededUser;
let secret: string;
let tokenId: string;

function outerApp(mark: boolean): Hono {
  const outer = new Hono();
  outer.use("*", accessGuard);
  outer.use("*", accessTokenGate);
  outer.post("/mcp", async (c) => {
    const inner = new Request("http://localhost/api/databases", { headers: { Authorization: `Bearer ${secret}` } });
    if (mark) markMcpRequest(inner, c);
    const res = await app.fetch(inner);
    return c.json({ status: res.status, body: await res.json() });
  });
  return outer;
}

function callOuter(outer: Hono): Promise<Response> {
  return Promise.resolve(
    outer.request(
      "/mcp",
      { method: "POST", headers: { Authorization: `Bearer ${secret}`, "Content-Type": "application/json" }, body: "{}" },
      TAILNET as never,
    ),
  );
}

beforeAll(async () => {
  md = useTempMetadata();
  app = buildApp();
  admin = seedUser("admin");
  settings.set("setup_complete", "1");
  const made = await createToken(app, admin, { name: "MCP client", preset: "read_only" });
  secret = made.secret;
  tokenId = made.token.id;
});

afterAll(() => {
  savePolicy({ allowLan: true, allowTailnet: true, allowCloudflare: true, requireCloudflareAccess: false, restrictAppApis: false });
  md.cleanup();
});

beforeEach(() => {
  resetAccessTokenRateLimits();
  savePolicy({ allowLan: false, allowTailnet: true, allowCloudflare: false, requireCloudflareAccess: false, restrictAppApis: false });
});

describe("in-process MCP requests", () => {
  test("a marked inner request is judged as the outer connection", async () => {
    const res = await callOuter(outerApp(true));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe(200);
    expect(Array.isArray(body.body.databases)).toBe(true);
    const activity = await (await session(app, admin, `/api/access-tokens/${tokenId}/activity?limit=5`)).json();
    expect(activity.entries[0]).toMatchObject({ via: "mcp", action: "database.list", from: "100.101.102.103", outcome: "ok" });
  });

  test("an unmarked request without a peer gains nothing", async () => {
    const res = await callOuter(outerApp(false));
    const body = await res.json();
    expect(body.status).toBe(403);
    const direct = await app.fetch(
      new Request("http://localhost/api/databases", { headers: { Authorization: `Bearer ${secret}`, "X-LambData-Via": "mcp" } }),
    );
    expect(direct.status).toBe(403);
    expect((await direct.json()).error).toContain("local network");
  });

  test("a marked request still needs the same token, and only a token request can mark", async () => {
    const other = await createToken(app, admin, { name: "Other client", preset: "read_only" });
    const outer = new Hono();
    outer.use("*", accessGuard);
    outer.use("*", accessTokenGate);
    outer.post("/mcp", async (c) => {
      const inner = new Request("http://localhost/api/databases", { headers: { Authorization: `Bearer ${other.secret}` } });
      markMcpRequest(inner, c);
      const res = await app.fetch(inner);
      return c.json({ status: res.status });
    });
    expect((await (await callOuter(outer)).json()).status).toBe(401);
    const plain = new Hono();
    plain.post("/mcp", (c) => {
      try {
        markMcpRequest(new Request("http://localhost/api/databases"), c);
        return c.json({ marked: true });
      } catch {
        return c.json({ marked: false });
      }
    });
    expect(await (await plain.request("/mcp", { method: "POST" })).json()).toEqual({ marked: false });
  });

  test("the outer group still has to be allowed for the token", async () => {
    const lanOnly = await createToken(app, admin, { name: "No tailnet", preset: "read_only", allowedFrom: ["loopback", "lan"] });
    const outer = new Hono();
    outer.use("*", accessGuard);
    outer.use("*", accessTokenGate);
    outer.post("/mcp", (c) => c.json({ ok: true }));
    const res = await outer.request(
      "/mcp",
      { method: "POST", headers: { Authorization: `Bearer ${lanOnly.secret}`, "Content-Type": "application/json" }, body: "{}" },
      TAILNET as never,
    );
    expect(res.status).toBe(403);
    expect((await res.json()).error).toContain("your tailnet");
  });
});
