import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { AccessPolicy } from "@lambdata/shared";
import { useTempMetadata, type TempMetadata } from "../harness/sqlite";
import { buildApp } from "../../src/server";
import {
  OPEN_POLICY,
  saveAccessConfig,
  savePolicy,
  saveTrustedProxies,
} from "../../src/network/config";
import { setAccessVerifierDefaults } from "../../src/network/cfAccess";
import { guardUpgradeRequest } from "../../src/network/guard";
import {
  AUD,
  TEAM,
  accessClaims,
  makeRsaKey,
  peerEnv,
  signRs256,
  startJwksServer,
  type JwksServer,
  type TestKey,
} from "./helpers";

let md: TempMetadata;
let app: ReturnType<typeof buildApp>;
let key: TestKey;
let jwks: JwksServer;

const LAN = "192.168.1.20";
const TAILNET = "100.101.102.103";
const MISSING = "/api/network-guard-probe";

const CLOUDFLARED = { "Cf-Ray": "8a1b2c3d4e5f-AMS", "Cf-Connecting-Ip": "203.0.113.50", "X-Forwarded-For": "203.0.113.50", "X-Forwarded-Proto": "https" };
const SERVE = { "X-Forwarded-For": TAILNET, "X-Forwarded-Proto": "https", "Tailscale-User-Login": "owner@example.test" };

beforeAll(async () => {
  md = useTempMetadata();
  app = buildApp();
  key = await makeRsaKey("guard-kid");
  jwks = startJwksServer([key.publicJwk]);
  setAccessVerifierDefaults({ certsUrl: () => jwks.url });
});

afterAll(() => {
  setAccessVerifierDefaults({});
  savePolicy({ ...OPEN_POLICY });
  jwks.stop();
  md.cleanup();
});

beforeEach(() => {
  savePolicy({ ...OPEN_POLICY });
  saveTrustedProxies([]);
  saveAccessConfig(null);
  delete process.env.LAMBDATA_ACCESS_POLICY;
});

function policy(p: Partial<AccessPolicy>): void {
  savePolicy({ ...OPEN_POLICY, ...p });
}

async function hit(
  path: string,
  peer: string | null,
  headers: Record<string, string> = {},
  method = "GET",
): Promise<Response> {
  return app.request(path, { method, headers }, peerEnv(peer));
}

async function status(path: string, peer: string | null, headers: Record<string, string> = {}, method = "GET"): Promise<number> {
  return (await hit(path, peer, headers, method)).status;
}

describe("default policy", () => {
  test("allows every ingress, exactly as before", async () => {
    expect(await status(MISSING, LAN)).toBe(404);
    expect(await status(MISSING, TAILNET)).toBe(404);
    expect(await status(MISSING, "127.0.0.1", CLOUDFLARED)).toBe(404);
    expect(await status(MISSING, null)).toBe(404);
  });
});

describe("LAN blocked", () => {
  beforeEach(() => policy({ allowLan: false }));

  test("rejects LAN with 403 and a plain message", async () => {
    const res = await hit(MISSING, LAN);
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toContain("local network");
    const page = await hit("/", LAN);
    expect(page.status).toBe(403);
    expect(page.headers.get("content-type") ?? "").toContain("text/plain");
  });

  test("treats an unknown peer as LAN", async () => {
    expect(await status(MISSING, null)).toBe(403);
  });

  test("keeps /api/health reachable", async () => {
    expect(await status("/api/health", LAN)).toBe(200);
    expect(await status("/api/health/detail", LAN)).toBe(403);
  });

  test("always allows loopback, the break-glass path", async () => {
    expect(await status(MISSING, "127.0.0.1")).toBe(404);
    expect(await status(MISSING, "::1")).toBe(404);
  });

  test("allows tailnet peers and Tailscale Serve", async () => {
    expect(await status(MISSING, TAILNET)).toBe(404);
    expect(await status(MISSING, "fd7a:115c:a1e0::42")).toBe(404);
    expect(await status(MISSING, "127.0.0.1", SERVE)).toBe(404);
  });

  test("does not believe forwarded headers from a LAN peer", async () => {
    expect(await status(MISSING, LAN, { "X-Forwarded-For": TAILNET })).toBe(403);
    expect(await status(MISSING, LAN, { "X-Forwarded-For": "127.0.0.1" })).toBe(403);
    expect(await status(MISSING, LAN, CLOUDFLARED)).toBe(403);
    expect(await status(MISSING, LAN, { "Tailscale-User-Login": "owner@example.test" })).toBe(403);
  });

  test("Tailscale Funnel traffic must pass the LAN rule as well as the Cloudflare rule", async () => {
    expect(
      await status(MISSING, "127.0.0.1", { "X-Forwarded-For": "198.51.100.3", "Tailscale-Funnel-Request": "?1" }),
    ).toBe(403);
  });

  test("a non-loopback trusted proxy forwarding a loopback address is not loopback", async () => {
    saveTrustedProxies(["172.18.0.0/16"]);
    expect(await status(MISSING, "172.18.0.5", { "X-Forwarded-For": "127.0.0.1" })).toBe(403);
  });
});

describe("app-facing APIs", () => {
  test("stay reachable from the LAN unless restrictAppApis is on", async () => {
    policy({ allowLan: false });
    expect(await status("/api/data/somedb/sometable", LAN)).not.toBe(403);
    expect(await status("/api/app-auth/token", LAN, { "Content-Type": "application/json" }, "POST")).not.toBe(403);
    expect(await status("/api/storage/public/bucket/object.txt", LAN)).toBe(404);
    expect(await status("/functions/v1/hello", LAN)).not.toBe(403);
    expect(await status("/api/app-auth/users", LAN)).toBe(403);
    expect(await status("/api/storage/buckets", LAN)).toBe(403);

    policy({ allowLan: false, restrictAppApis: true });
    expect(await status("/api/data/somedb/sometable", LAN)).toBe(403);
    expect(await status("/api/storage/public/bucket/object.txt", LAN)).toBe(403);
    expect(await status("/functions/v1/hello", LAN)).toBe(403);
  });

  test("the websocket upgrade path follows the same rule", async () => {
    const server = { requestIP: () => ({ address: LAN, port: 5555 }) };
    const ws = new Request("http://lambdata.local/api/realtime/v1/websocket?apikey=x");
    policy({ allowLan: false });
    expect(await guardUpgradeRequest(ws, server)).toBeNull();
    policy({ allowLan: false, restrictAppApis: true });
    expect((await guardUpgradeRequest(ws, server))?.status).toBe(403);
    expect(await guardUpgradeRequest(ws, { requestIP: () => ({ address: TAILNET, port: 5555 }) })).toBeNull();
  });
});

describe("tailnet only", () => {
  beforeEach(() => policy({ allowLan: false, allowCloudflare: false }));

  test("rejects cloudflared traffic, including a spoofed Tailscale identity header", async () => {
    expect(await status(MISSING, "127.0.0.1", CLOUDFLARED)).toBe(403);
    expect(await status(MISSING, "127.0.0.1", { ...CLOUDFLARED, "Tailscale-User-Login": "x@example.test" })).toBe(403);
    expect(await status(MISSING, TAILNET)).toBe(404);
  });
});

describe("Cloudflare only", () => {
  beforeEach(() => policy({ allowLan: false, allowTailnet: false }));

  test("accepts cloudflared traffic and rejects Serve traffic that adds Cloudflare headers", async () => {
    expect(await status(MISSING, "127.0.0.1", CLOUDFLARED)).toBe(404);
    expect(await status(MISSING, "127.0.0.1", { ...SERVE, "Cf-Ray": "spoofed", "Cf-Connecting-Ip": "1.2.3.4" })).toBe(403);
    expect(await status(MISSING, TAILNET)).toBe(403);
  });

  test("needs the external cloudflared container to be a trusted proxy", async () => {
    expect(await status(MISSING, "172.18.0.5", CLOUDFLARED)).toBe(403);
    saveTrustedProxies(["172.18.0.5"]);
    expect(await status(MISSING, "172.18.0.5", CLOUDFLARED)).toBe(404);
  });

  test("with Access required, forwarding headers alone are not enough", async () => {
    saveAccessConfig({ teamDomain: TEAM, audience: AUD });
    policy({ allowLan: false, allowTailnet: false, requireCloudflareAccess: true });
    expect(await status(MISSING, "127.0.0.1", CLOUDFLARED)).toBe(403);
    const good = await signRs256(key, accessClaims());
    expect(await status(MISSING, "127.0.0.1", { ...CLOUDFLARED, "Cf-Access-Jwt-Assertion": good })).toBe(404);
    const wrongAud = await signRs256(key, accessClaims({ aud: ["c".repeat(64)] }));
    expect(await status(MISSING, "127.0.0.1", { ...CLOUDFLARED, "Cf-Access-Jwt-Assertion": wrongAud })).toBe(403);
    const forged = `${good.slice(0, good.lastIndexOf(".") + 1)}AAAA`;
    expect(await status(MISSING, "127.0.0.1", { ...CLOUDFLARED, "Cf-Access-Jwt-Assertion": forged })).toBe(403);
    expect(await status(MISSING, LAN, { "Cf-Access-Jwt-Assertion": forged })).toBe(403);
  });
});

describe("recovery", () => {
  test("LAMBDATA_ACCESS_POLICY=open overrides a locked policy", async () => {
    policy({ allowLan: false, allowTailnet: false, allowCloudflare: false });
    expect(await status(MISSING, LAN)).toBe(403);
    process.env.LAMBDATA_ACCESS_POLICY = "open";
    expect(await status(MISSING, LAN)).toBe(404);
    delete process.env.LAMBDATA_ACCESS_POLICY;
    expect(await status(MISSING, LAN)).toBe(403);
  });
});
