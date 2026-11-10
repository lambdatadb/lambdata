import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { AccessPolicy, IngressKind, NetworkStatusResponse } from "@lambdata/shared";
import { authHeaders, seedUser, useTempMetadata, type SeededUser, type TempMetadata } from "../harness/sqlite";
import { buildApp } from "../../src/server";
import { classifyParts } from "../../src/network/classify";
import { evaluateAccess } from "../../src/network/policy";
import { computeFacts, isLocalFacts, loopbackForwardingSeen, resetLoopbackForwarding } from "../../src/network/request";
import { parseCidr, type Cidr } from "../../src/network/ip";
import { setAccessVerifierDefaults } from "../../src/network/cfAccess";
import {
  OPEN_POLICY,
  markAccessVerified,
  saveAccessConfig,
  savePolicy,
  saveTrustedProxies,
  saveTunnelMode,
  type AccessConfig,
} from "../../src/network/config";
import { APP_APIS_OPEN_WARNING, EXTERNAL_TUNNEL_UNTRUSTED_WARNING } from "../../src/network/status";
import { AUD, TEAM, accessClaims, makeRsaKey, peerEnv, signRs256, startJwksServer, type JwksServer, type TestKey } from "./helpers";

let md: TempMetadata;
let app: ReturnType<typeof buildApp>;
let admin: SeededUser;
let key: TestKey;
let jwks: JwksServer;

const ACCESS: AccessConfig = { teamDomain: TEAM, audience: AUD };
const REVIEWER_POLICY: AccessPolicy = {
  allowLan: true,
  allowTailnet: false,
  allowCloudflare: true,
  requireCloudflareAccess: true,
  restrictAppApis: true,
};

const CF = { "cf-ray": "8a1b2c3d4e5f-AMS", "cf-connecting-ip": "203.0.113.50", "x-forwarded-for": "203.0.113.50" };
const FUNNEL = { "tailscale-funnel-request": "?1", "x-forwarded-for": "203.0.113.50" };
const SERVE = { "x-forwarded-for": "100.101.102.103", "x-forwarded-proto": "https", "tailscale-user-login": "avery@example.com" };

beforeAll(async () => {
  md = useTempMetadata();
  app = buildApp();
  admin = seedUser("admin");
  key = await makeRsaKey("classify-kid");
  jwks = startJwksServer([key.publicJwk]);
  setAccessVerifierDefaults({ certsUrl: () => jwks.url });
});

afterAll(() => {
  setAccessVerifierDefaults({});
  savePolicy({ ...OPEN_POLICY });
  saveTunnelMode("off");
  jwks.stop();
  md.cleanup();
});

beforeEach(() => {
  savePolicy({ ...OPEN_POLICY });
  saveTrustedProxies([]);
  saveAccessConfig(null);
  saveTunnelMode("off");
  resetLoopbackForwarding();
  delete process.env.LAMBDATA_TRUST_LOOPBACK;
  delete process.env.LAMBDATA_ACCESS_POLICY;
});

async function classify(peer: string | null, headers: Record<string, string>, trusted: string[] = [], access: AccessConfig | null = null) {
  const h = new Headers(headers);
  const cidrs = trusted.map((t) => parseCidr(t)).filter((c): c is Cidr => c !== null);
  const facts = computeFacts({ headers: h, peer: peer ? { address: peer, port: 40000 } : null, url: "http://x/api/auth/me" }, cidrs);
  return classifyParts(h, facts, access);
}

describe("the reviewer's reproduction (classify-repro.ts)", () => {
  test("external cloudflared without a trusted proxy is no longer LAN, and is denied without Access", async () => {
    const info = await classify("172.17.0.1", CF);
    expect(info.ingress).toBe("cloudflare");
    expect(info.checks).toEqual(["cloudflare", "lan"]);
    expect(info.untrustedProxy).toBe(true);
    expect(evaluateAccess(REVIEWER_POLICY, info, "/api/auth/me", "GET").allowed).toBe(false);
  });

  test("Tailscale Funnel is no longer LAN, and is denied without Access", async () => {
    const info = await classify("127.0.0.1", FUNNEL);
    expect(info.ingress).toBe("cloudflare");
    expect(info.checks).toEqual(["cloudflare", "lan"]);
    expect(info.funnel).toBe(true);
    expect(evaluateAccess(REVIEWER_POLICY, info, "/api/auth/me", "GET").allowed).toBe(false);
  });

  test("the built-in tunnel is still Cloudflare and still denied without Access", async () => {
    const info = await classify("127.0.0.1", CF);
    expect(info.checks).toEqual(["cloudflare"]);
    expect(evaluateAccess(REVIEWER_POLICY, info, "/api/auth/me", "GET").allowed).toBe(false);
  });

  test("a plain LAN client is still LAN and allowed", async () => {
    const info = await classify("192.168.1.20", {});
    expect(info.checks).toEqual(["lan"]);
    expect(evaluateAccess(REVIEWER_POLICY, info, "/api/auth/me", "GET").allowed).toBe(true);
  });
});

describe("truth table", () => {
  const rows: [string, string | null, Record<string, string>, string[], IngressKind[]][] = [
    ["loopback, no proxy headers", "127.0.0.1", {}, [], ["loopback"]],
    ["IPv6 loopback", "::1", {}, [], ["loopback"]],
    ["managed cloudflared on loopback", "127.0.0.1", CF, [], ["cloudflare"]],
    ["external cloudflared, not trusted", "172.17.0.1", CF, [], ["cloudflare", "lan"]],
    ["external cloudflared, trusted", "172.17.0.1", CF, ["172.17.0.1"], ["cloudflare"]],
    ["Funnel on loopback", "127.0.0.1", FUNNEL, [], ["cloudflare", "lan"]],
    ["Funnel from an untrusted sidecar", "172.17.0.3", FUNNEL, [], ["cloudflare", "lan"]],
    ["Tailscale Serve on loopback", "127.0.0.1", SERVE, [], ["tailnet"]],
    ["Serve plus spoofed Cloudflare headers", "127.0.0.1", { ...SERVE, "cf-ray": "spoofed" }, [], ["cloudflare", "tailnet"]],
    ["direct tailnet peer", "100.101.102.103", {}, [], ["tailnet"]],
    ["tailnet peer carrying Cloudflare headers", "100.101.102.103", CF, [], ["cloudflare", "tailnet"]],
    ["LAN peer", "192.168.1.20", {}, [], ["lan"]],
    ["LAN peer forging a tailnet X-Forwarded-For", "192.168.1.20", { "x-forwarded-for": "100.101.102.103" }, [], ["lan"]],
    ["LAN peer forging a Tailscale identity", "192.168.1.20", { "tailscale-user-login": "x@example.com" }, [], ["lan"]],
    ["LAN peer with only a Cloudflare header", "192.168.1.20", { "cf-ipcountry": "NL" }, [], ["cloudflare", "lan"]],
    ["local proxy with forwarding headers but no client address", "127.0.0.1", { "x-forwarded-proto": "https" }, [], ["lan"]],
    ["local proxy forwarding a local client", "127.0.0.1", { "x-forwarded-for": "127.0.0.1" }, [], ["loopback"]],
    ["local proxy forwarding a LAN client", "127.0.0.1", { "x-forwarded-for": "192.168.1.20" }, [], ["lan"]],
    ["trusted non-loopback proxy forwarding a loopback address", "172.18.0.5", { "x-forwarded-for": "127.0.0.1" }, ["172.18.0.0/16"], ["lan"]],
    ["unknown peer", null, {}, [], ["lan"]],
  ];
  for (const [name, peer, headers, trusted, checks] of rows) {
    test(name, async () => {
      expect((await classify(peer, headers, trusted)).checks).toEqual(checks);
    });
  }

  test("a verified Access token from an untrusted peer must still pass the LAN rule", async () => {
    const good = await signRs256(key, accessClaims());
    const info = await classify("192.168.1.20", { "cf-access-jwt-assertion": good }, [], ACCESS);
    expect(info.accessVerified).toBe(true);
    expect(info.checks).toEqual(["cloudflare", "lan"]);
    const noLan = { ...REVIEWER_POLICY, allowLan: false };
    expect(evaluateAccess(noLan, info, "/api/auth/me", "GET").allowed).toBe(false);
    expect(evaluateAccess(REVIEWER_POLICY, info, "/api/auth/me", "GET").allowed).toBe(true);
  });

  test("proxy evidence never upgrades: every row is at most as trusted as its peer alone", async () => {
    const lanOnly: AccessPolicy = { allowLan: true, allowTailnet: false, allowCloudflare: false, requireCloudflareAccess: false, restrictAppApis: true };
    const cfOnly: AccessPolicy = { allowLan: false, allowTailnet: false, allowCloudflare: true, requireCloudflareAccess: false, restrictAppApis: true };
    const forgedFromLan: Record<string, string>[] = [CF, FUNNEL, { "x-forwarded-for": "100.101.102.103" }, { "tailscale-user-login": "x@example.com" }];
    for (const headers of forgedFromLan) {
      const info = await classify("192.168.1.20", headers);
      expect(evaluateAccess(cfOnly, info, "/api/auth/me", "GET").allowed).toBe(false);
    }
    const viaFunnel = await classify("127.0.0.1", FUNNEL);
    expect(evaluateAccess(lanOnly, viaFunnel, "/api/auth/me", "GET").allowed).toBe(false);
    expect(evaluateAccess(cfOnly, viaFunnel, "/api/auth/me", "GET").allowed).toBe(false);
  });
});

describe("through the running guard", () => {
  test("LAN on, tailnet off, Cloudflare with Access: both internet paths are refused, LAN and the tunnel with Access are let in", async () => {
    saveAccessConfig(ACCESS);
    savePolicy(REVIEWER_POLICY);
    const probe = "/api/classify-probe";
    const hit = async (peer: string, headers: Record<string, string>) => (await app.request(probe, { headers }, peerEnv(peer))).status;
    expect(await hit("172.17.0.1", CF)).toBe(403);
    expect(await hit("127.0.0.1", FUNNEL)).toBe(403);
    expect(await hit("127.0.0.1", CF)).toBe(403);
    expect(await hit("192.168.1.20", {})).toBe(404);
    const good = await signRs256(key, accessClaims());
    expect(await hit("127.0.0.1", { ...CF, "cf-access-jwt-assertion": good })).toBe(404);
    expect(await hit("172.17.0.1", { ...CF, "cf-access-jwt-assertion": good })).toBe(404);
    const blocked = await app.request(probe, { headers: CF }, peerEnv("172.17.0.1"));
    expect(((await blocked.json()) as { error: string }).error).toContain("Cloudflare Access");
  });

  test("with LAN off, untrusted cloudflared traffic is refused with a message naming the proxy", async () => {
    savePolicy({ ...OPEN_POLICY, allowLan: false });
    const res = await app.request("/api/classify-probe", { headers: CF }, peerEnv("172.17.0.1"));
    expect(res.status).toBe(403);
    const error = ((await res.json()) as { error: string }).error;
    expect(error).toContain("172.17.0.1");
    expect(error).toContain("trusted proxies");
  });
});

describe("running elsewhere with Access needs a trusted proxy", () => {
  async function put(path: string, body: unknown, peer = "127.0.0.1") {
    return app.request(
      path,
      { method: "PUT", headers: await authHeaders(admin, { "Content-Type": "application/json" }), body: JSON.stringify(body) },
      peerEnv(peer),
    );
  }
  const required: AccessPolicy = { ...OPEN_POLICY, requireCloudflareAccess: true };

  test("the policy cannot require Access while an external tunnel has no trusted proxy", async () => {
    saveAccessConfig(ACCESS);
    markAccessVerified(Date.now());
    saveTunnelMode("external");
    const res = await put("/api/network/policy", { policy: required });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain("trusted proxy");
    saveTrustedProxies(["172.17.0.1"]);
    expect((await put("/api/network/policy", { policy: required })).status).toBe(200);
  });

  test("the tunnel cannot switch to external, nor drop its last trusted proxy, while Access is required", async () => {
    saveAccessConfig(ACCESS);
    markAccessVerified(Date.now());
    savePolicy(required);
    const toExternal = await put("/api/network/cloudflare/tunnel", { mode: "external" });
    expect(toExternal.status).toBe(400);
    saveTrustedProxies(["172.17.0.1"]);
    expect((await put("/api/network/cloudflare/tunnel", { mode: "external" })).status).toBe(200);
    const drop = await put("/api/network/public-urls", { publicUrls: [], trustedProxies: [] });
    expect(drop.status).toBe(400);
  });

  test("status warns about an external tunnel without a trusted proxy, and about untrusted Cloudflare or Funnel traffic", async () => {
    const status = async (peer: string, headers: Record<string, string> = {}) => {
      const res = await app.request("/api/network/status", { headers: await authHeaders(admin, headers) }, peerEnv(peer));
      return ((await res.json()) as NetworkStatusResponse).status;
    };
    const quiet = await status("192.168.1.20");
    expect(quiet.warnings).toEqual([]);
    expect(quiet.yourAccessVerified).toBe(false);
    expect(quiet.cloudflare.tunnel.desired).toBe(false);
    saveTunnelMode("external");
    expect((await status("192.168.1.20")).warnings).toEqual([EXTERNAL_TUNNEL_UNTRUSTED_WARNING]);
    saveTrustedProxies(["172.17.0.1"]);
    expect((await status("192.168.1.20")).warnings).toEqual([]);
    const stray = await status("172.17.0.9", CF);
    expect(stray.warnings.join(" ")).toContain("172.17.0.9");
    const funnel = await status("127.0.0.1", FUNNEL);
    expect(funnel.warnings.join(" ")).toContain("Tailscale Funnel");
  });

  test("status reports a verified Access session", async () => {
    saveAccessConfig(ACCESS);
    const good = await signRs256(key, accessClaims());
    const res = await app.request(
      "/api/network/status",
      { headers: await authHeaders(admin, { ...CF, "cf-access-jwt-assertion": good }) },
      peerEnv("127.0.0.1"),
    );
    expect(((await res.json()) as NetworkStatusResponse).status.yourAccessVerified).toBe(true);
  });
});

describe("a forwarder on the same machine that adds no forwarding headers (VSEC-01)", () => {
  const CLOSED: AccessPolicy = { allowLan: false, allowTailnet: false, allowCloudflare: false, requireCloudflareAccess: false, restrictAppApis: true };
  const facts = (peer: string, headers: Record<string, string>, trusted: string[] = []) =>
    computeFacts(
      { headers: new Headers(headers), peer: { address: peer, port: 40000 }, url: "http://x/api/auth/me" },
      trusted.map((t) => parseCidr(t)).filter((c): c is Cidr => c !== null),
    );

  test("the reviewer's probe: loopback with only a public Host header is LAN, not local, and denied by a closed policy", async () => {
    const info = await classify("127.0.0.1", { host: "db.example.com" });
    expect(info.ingress).toBe("lan");
    expect(info.forwardedHost).toBe("db.example.com");
    expect(isLocalFacts(facts("127.0.0.1", { host: "db.example.com" }))).toBe(false);
    expect(evaluateAccess(CLOSED, info, "/api/auth/me", "GET").allowed).toBe(false);
    const forwardings: Record<string, string>[] = [{ "x-forwarded-for": "203.0.113.9" }, { forwarded: "for=203.0.113.9" }, { "x-real-ip": "203.0.113.9" }];
    for (const forwarding of forwardings) {
      const viaHeaders = await classify("127.0.0.1", { host: "db.example.com", ...forwarding });
      expect(viaHeaders.ingress).toBe("lan");
      expect(evaluateAccess(CLOSED, viaHeaders, "/api/auth/me", "GET").allowed).toBe(false);
    }
  });

  test("Host, Origin and Referer naming this machine stay loopback; any other name makes it LAN", async () => {
    const local: Record<string, string>[] = [
      {},
      { host: "localhost:4317" },
      { host: "127.0.0.1:4317", origin: "http://127.0.0.1:4317" },
      { host: "[::1]:4317", referer: "http://[::1]:4317/databases" },
      { host: "app.localhost:5173", origin: "http://app.localhost:5173" },
      { host: "localhost:4317", origin: "null" },
    ];
    for (const headers of local) {
      expect({ headers, ingress: (await classify("127.0.0.1", headers)).ingress }).toEqual({ headers, ingress: "loopback" });
      expect(isLocalFacts(facts("127.0.0.1", headers))).toBe(true);
    }
    const forwarded: Record<string, string>[] = [
      { host: "192.168.1.50:4317" },
      { host: "localhost:4317", origin: "https://db.example.com" },
      { host: "localhost:4317", referer: "https://db.example.com/x" },
      { host: "box.tail1234.ts.net" },
      { "x-forwarded-for": "127.0.0.1", host: "db.example.com" },
    ];
    for (const headers of forwarded) {
      expect({ headers, ingress: (await classify("127.0.0.1", headers)).ingress }).toEqual({ headers, ingress: "lan" });
      expect(isLocalFacts(facts("127.0.0.1", headers))).toBe(false);
    }
    expect((await classify("192.168.1.20", { host: "db.example.com" })).forwardedHost).toBeNull();
  });

  test("LAMBDATA_TRUST_LOOPBACK=0 removes the loopback exemption and loopback's implicit proxy trust", async () => {
    process.env.LAMBDATA_TRUST_LOOPBACK = "0";
    expect((await classify("127.0.0.1", { host: "localhost:4317" })).ingress).toBe("lan");
    expect(isLocalFacts(facts("127.0.0.1", { host: "localhost:4317" }))).toBe(false);
    expect((await classify("127.0.0.1", SERVE)).checks).toEqual(["lan"]);
    expect((await classify("127.0.0.1", CF)).checks).toEqual(["cloudflare", "lan"]);
    expect((await classify("127.0.0.1", { "x-forwarded-for": "127.0.0.1" }, ["127.0.0.1"])).checks).toEqual(["lan"]);
    expect((await classify("127.0.0.1", SERVE, ["127.0.0.1"])).checks).toEqual(["tailnet"]);
    expect((await classify("127.0.0.1", CF, ["127.0.0.1"])).checks).toEqual(["cloudflare"]);
    expect((await classify("::1", {})).ingress).toBe("lan");
  });

  test("through the running guard: a closed policy lets the server itself in and refuses the forwarder; the switch and the recovery path", async () => {
    savePolicy({ ...CLOSED });
    const hit = async (headers: Record<string, string>) => (await app.request("/api/classify-probe", { headers }, peerEnv("127.0.0.1"))).status;
    expect(await hit({ host: "localhost:4317" })).toBe(404);
    expect(await hit({ host: "db.example.com" })).toBe(403);
    expect(await hit({ host: "localhost:4317", origin: "https://db.example.com" })).toBe(403);
    process.env.LAMBDATA_TRUST_LOOPBACK = "0";
    expect(await hit({ host: "localhost:4317" })).toBe(403);
    process.env.LAMBDATA_ACCESS_POLICY = "open";
    expect(await hit({ host: "localhost:4317" })).toBe(404);
    expect(await hit({ host: "db.example.com" })).toBe(404);
  });

  test("status warns once such requests were seen, even under the open policy, and names the host", async () => {
    const status = async (peer: string, headers: Record<string, string> = {}) => {
      const res = await app.request("/api/network/status", { headers: await authHeaders(admin, headers) }, peerEnv(peer));
      return ((await res.json()) as NetworkStatusResponse).status;
    };
    expect((await status("127.0.0.1", { host: "localhost:4317" })).warnings).toEqual([]);
    expect(loopbackForwardingSeen()).toBeNull();
    expect((await app.request("/api/classify-probe", { headers: { host: "db.example.com:443" } }, peerEnv("127.0.0.1"))).status).toBe(404);
    expect(loopbackForwardingSeen()).toMatchObject({ host: "db.example.com", count: 1 });
    const warned = await status("192.168.1.20");
    expect(warned.warnings).toHaveLength(1);
    expect(warned.warnings[0]).toContain("addressed to db.example.com");
    expect(warned.warnings[0]).toContain("LAMBDATA_TRUST_LOOPBACK=0");
    expect(warned.warnings[0]).toContain("trusted proxies");
    await app.request("/api/classify-probe", { headers: { host: "<script>" } }, peerEnv("127.0.0.1"));
    expect((await status("192.168.1.20")).warnings[0]).toContain("addressed to another name");
    process.env.LAMBDATA_TRUST_LOOPBACK = "0";
    expect((await status("192.168.1.20")).warnings).toEqual([]);
  });
});

describe("Cloudflare Access for the console only (VSEC-03)", () => {
  test("status says the app-facing APIs are still reachable without Access, until they are restricted", async () => {
    const status = async () => {
      const res = await app.request("/api/network/status", { headers: await authHeaders(admin) }, peerEnv("192.168.1.20"));
      return ((await res.json()) as NetworkStatusResponse).status;
    };
    savePolicy({ ...OPEN_POLICY, requireCloudflareAccess: true, restrictAppApis: false });
    expect((await status()).warnings).toEqual([APP_APIS_OPEN_WARNING]);
    savePolicy({ ...OPEN_POLICY, requireCloudflareAccess: true, restrictAppApis: true });
    expect((await status()).warnings).toEqual([]);
    savePolicy({ ...OPEN_POLICY, allowCloudflare: false, requireCloudflareAccess: true, restrictAppApis: false });
    expect((await status()).warnings).toEqual([]);
  });
});
