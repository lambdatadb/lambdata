import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { AccessPolicy, CloudflareAccessTestResponse, NetworkStatusResponse } from "@lambdata/shared";
import { authHeaders, seedUser, useTempMetadata, type SeededUser, type TempMetadata } from "../harness/sqlite";
import { buildApp } from "../../src/server";
import { audit, settings } from "../../src/db/queries";
import {
  KEYS,
  OPEN_POLICY,
  loadNetworkConfig,
  saveAccessConfig,
  savePolicy,
  savePublicUrls,
  saveTrustedProxies,
} from "../../src/network/config";
import { setAccessVerifierDefaults } from "../../src/network/cfAccess";
import { applyEnvPolicyLock } from "../../src/network/service";
import { isAllowedOrigin } from "../../src/network/origins";
import {
  AUD,
  TEAM,
  accessClaims,
  makeRsaKey,
  peerEnv,
  signRs256,
  startJwksServer,
  useFakeTailscale,
  type FakeBin,
  type JwksServer,
  type TestKey,
} from "./helpers";

let md: TempMetadata;
let app: ReturnType<typeof buildApp>;
let admin: SeededUser;
let viewer: SeededUser;
let key: TestKey;
let jwks: JwksServer;
let ts: FakeBin;

const LAN = "192.168.1.20";
const CLOUDFLARED = { "Cf-Ray": "8a1b2c3d4e5f-AMS", "Cf-Connecting-Ip": "203.0.113.50", "X-Forwarded-For": "203.0.113.50", "X-Forwarded-Proto": "https" };

beforeAll(async () => {
  md = useTempMetadata();
  app = buildApp();
  admin = seedUser("admin");
  viewer = seedUser("viewer");
  key = await makeRsaKey("routes-kid");
  jwks = startJwksServer([key.publicJwk]);
  setAccessVerifierDefaults({ certsUrl: () => jwks.url });
  ts = useFakeTailscale({ BackendState: "Stopped" });
});

afterAll(() => {
  setAccessVerifierDefaults({});
  savePolicy({ ...OPEN_POLICY });
  jwks.stop();
  ts.restore();
  md.cleanup();
});

beforeEach(() => {
  savePolicy({ ...OPEN_POLICY });
  saveTrustedProxies([]);
  savePublicUrls([]);
  saveAccessConfig(null);
  delete process.env.LAMBDATA_ACCESS_POLICY;
});

async function call(
  user: SeededUser | null,
  path: string,
  init: { method?: string; body?: unknown; headers?: Record<string, string> } = {},
  peer = LAN,
): Promise<Response> {
  const base = { "Content-Type": "application/json", ...(init.headers ?? {}) };
  const headers = user ? await authHeaders(user, base) : base;
  return app.request(
    path,
    { method: init.method ?? "GET", headers, body: init.body === undefined ? undefined : JSON.stringify(init.body) },
    peerEnv(peer),
  );
}

async function errorOf(res: Response): Promise<string> {
  return ((await res.json()) as { error: string }).error;
}

function policy(p: Partial<AccessPolicy>): AccessPolicy {
  return { ...OPEN_POLICY, ...p };
}

describe("auth requirements", () => {
  test("status needs a session; every change needs an admin", async () => {
    expect((await call(null, "/api/network/status")).status).toBe(401);
    expect((await call(viewer, "/api/network/status")).status).toBe(200);
    const writes: [string, string, unknown][] = [
      ["PUT", "/api/network/policy", { policy: OPEN_POLICY }],
      ["PUT", "/api/network/public-urls", { publicUrls: [] }],
      ["PUT", "/api/network/cloudflare/tunnel", { mode: "off" }],
      ["POST", "/api/network/cloudflare/tunnel/start", {}],
      ["POST", "/api/network/cloudflare/tunnel/stop", {}],
      ["PUT", "/api/network/cloudflare/access", { teamDomain: null, audience: null }],
      ["POST", "/api/network/cloudflare/access/test", {}],
      ["POST", "/api/network/tailscale/serve", { enabled: true }],
    ];
    for (const [method, path, body] of writes) {
      expect((await call(null, path, { method, body })).status).toBe(401);
      expect((await call(viewer, path, { method, body })).status).toBe(403);
    }
  });
});

describe("GET /status", () => {
  test("reports how the caller is connected", async () => {
    const lan = ((await (await call(viewer, "/api/network/status")).json()) as NetworkStatusResponse).status;
    expect(lan.yourIngress).toBe("lan");
    expect(lan.yourIp).toBe(LAN);
    expect(lan.policy).toEqual(OPEN_POLICY);
    expect(lan.policyLockedByEnv).toBe(false);
    expect(lan.bind.port).toBeGreaterThan(0);
    expect(lan.tailscale.serve).toEqual({ supported: false, enabled: false, url: null });

    const cfRes = await call(viewer, "/api/network/status", { headers: CLOUDFLARED }, "127.0.0.1");
    const viaCf = ((await cfRes.json()) as NetworkStatusResponse).status;
    expect(viaCf.yourIngress).toBe("cloudflare");
    expect(viaCf.yourIp).toBe("203.0.113.50");

    const local = ((await (await call(viewer, "/api/network/status", {}, "127.0.0.1")).json()) as NetworkStatusResponse).status;
    expect(local.yourIngress).toBe("loopback");
  });
});

describe("PUT /policy", () => {
  test("saves a policy and audits the change", async () => {
    const next = policy({ restrictAppApis: true });
    const res = await call(admin, "/api/network/policy", { method: "PUT", body: { policy: next } });
    expect(res.status).toBe(200);
    expect(((await res.json()) as NetworkStatusResponse).status.policy).toEqual(next);
    expect(loadNetworkConfig().storedPolicy).toEqual(next);
    expect(audit.list(5).some((e) => e.action === "network.policy.update")).toBe(true);
  });

  test("validates the body", async () => {
    for (const body of [{}, { policy: { allowLan: true } }, { policy: { ...OPEN_POLICY, allowLan: "no" } }, { policy: { ...OPEN_POLICY, extra: true } }]) {
      expect((await call(admin, "/api/network/policy", { method: "PUT", body })).status).toBe(400);
    }
  });

  test("refuses a change that would lock out the admin making it", async () => {
    const res = await call(admin, "/api/network/policy", { method: "PUT", body: { policy: policy({ allowLan: false }) } });
    expect(res.status).toBe(409);
    const message = await errorOf(res);
    expect(message).toContain("local network");
    expect(message).toContain(LAN);
    expect(loadNetworkConfig().storedPolicy).toEqual(OPEN_POLICY);

    const viaTunnel = await call(
      admin,
      "/api/network/policy",
      { method: "PUT", body: { policy: policy({ allowCloudflare: false }) }, headers: CLOUDFLARED },
      "127.0.0.1",
    );
    expect(viaTunnel.status).toBe(409);
    expect(await errorOf(viaTunnel)).toContain("Cloudflare");
  });

  test("allows the same change from a connection the new policy allows", async () => {
    const fromTailnet = await call(
      admin,
      "/api/network/policy",
      { method: "PUT", body: { policy: policy({ allowLan: false }) } },
      "100.70.1.2",
    );
    expect(fromTailnet.status).toBe(200);
    const lockAll = await call(
      admin,
      "/api/network/policy",
      { method: "PUT", body: { policy: policy({ allowLan: false, allowTailnet: false, allowCloudflare: false }) } },
      "127.0.0.1",
    );
    expect(lockAll.status).toBe(200);
  });

  test("Require Cloudflare Access needs configuration and a successful test first", async () => {
    const required = policy({ allowLan: false, allowTailnet: false, requireCloudflareAccess: true });
    const noConfig = await call(admin, "/api/network/policy", { method: "PUT", body: { policy: required } }, "127.0.0.1");
    expect(noConfig.status).toBe(400);

    const put = await call(admin, "/api/network/cloudflare/access", { method: "PUT", body: { teamDomain: "lambtest", audience: AUD } }, "127.0.0.1");
    expect(put.status).toBe(200);
    const untested = await call(admin, "/api/network/policy", { method: "PUT", body: { policy: required } }, "127.0.0.1");
    expect(untested.status).toBe(400);
    expect(await errorOf(untested)).toContain("Test my session");

    const jwt = await signRs256(key, accessClaims());
    const tunnelHeaders = { ...CLOUDFLARED, "Cf-Access-Jwt-Assertion": jwt };
    const tested = await call(admin, "/api/network/cloudflare/access/test", { method: "POST", headers: tunnelHeaders }, "127.0.0.1");
    expect((await tested.json()) as CloudflareAccessTestResponse).toEqual({ ok: true, email: "owner@example.test", error: null });
    expect(loadNetworkConfig().accessVerifiedAt).not.toBeNull();

    const withoutJwt = await call(admin, "/api/network/policy", { method: "PUT", body: { policy: required }, headers: CLOUDFLARED }, "127.0.0.1");
    expect(withoutJwt.status).toBe(409);
    expect(await errorOf(withoutJwt)).toContain("without a Cloudflare Access token");

    const ok = await call(admin, "/api/network/policy", { method: "PUT", body: { policy: required }, headers: tunnelHeaders }, "127.0.0.1");
    expect(ok.status).toBe(200);

    const clear = await call(admin, "/api/network/cloudflare/access", { method: "PUT", body: { teamDomain: null, audience: null } }, "127.0.0.1");
    expect(clear.status).toBe(409);

    const otherAud = "d".repeat(64);
    const swap = await call(
      admin,
      "/api/network/cloudflare/access",
      { method: "PUT", body: { teamDomain: TEAM, audience: otherAud }, headers: tunnelHeaders },
      "127.0.0.1",
    );
    expect(swap.status).toBe(409);
    expect(loadNetworkConfig().access).toEqual({ teamDomain: TEAM, audience: AUD });
  });

  test("LAMBDATA_ACCESS_POLICY=open resets the stored policy and blocks edits", async () => {
    savePolicy(policy({ allowLan: false, allowTailnet: false, allowCloudflare: false }));
    process.env.LAMBDATA_ACCESS_POLICY = "open";
    expect(applyEnvPolicyLock()).toBe(true);
    expect(loadNetworkConfig().storedPolicy).toEqual(OPEN_POLICY);
    expect(audit.list(5).some((e) => e.action === "network.policy.reset_by_env")).toBe(true);
    const s = ((await (await call(admin, "/api/network/status")).json()) as NetworkStatusResponse).status;
    expect(s.policyLockedByEnv).toBe(true);
    expect(s.policy).toEqual(OPEN_POLICY);
    const res = await call(admin, "/api/network/policy", { method: "PUT", body: { policy: policy({ allowTailnet: false }) } });
    expect(res.status).toBe(409);
    expect(await errorOf(res)).toContain("LAMBDATA_ACCESS_POLICY");
    delete process.env.LAMBDATA_ACCESS_POLICY;
  });
});

describe("PUT /public-urls", () => {
  test("normalizes origins, feeds CORS, and validates", async () => {
    expect(isAllowedOrigin("https://db.example.com")).toBe(false);
    const res = await call(admin, "/api/network/public-urls", {
      method: "PUT",
      body: { publicUrls: ["https://DB.Example.com/", "https://db.example.com"], trustedProxies: ["172.18.0.5", "10.1.2.3/8"] },
    });
    expect(res.status).toBe(200);
    const s = ((await res.json()) as NetworkStatusResponse).status;
    expect(s.publicUrls).toEqual(["https://db.example.com"]);
    expect(s.trustedProxies).toEqual(["172.18.0.5", "10.0.0.0/8"]);
    expect(isAllowedOrigin("https://db.example.com")).toBe(true);
    const preflight = await app.request(
      "/api/network/status",
      { method: "OPTIONS", headers: { Origin: "https://db.example.com", "Access-Control-Request-Method": "GET" } },
      peerEnv(LAN),
    );
    expect(preflight.headers.get("access-control-allow-origin")).toBe("https://db.example.com");

    for (const bad of ["db.example.com", "https://db.example.com/console", "ftp://db.example.com", "https://u:p@db.example.com"]) {
      const r = await call(admin, "/api/network/public-urls", { method: "PUT", body: { publicUrls: [bad] } });
      expect(r.status).toBe(400);
    }
    for (const bad of ["0.0.0.0/0", "::/0", "not-an-ip", "10.0.0.0/4"]) {
      const r = await call(admin, "/api/network/public-urls", { method: "PUT", body: { publicUrls: [], trustedProxies: [bad] } });
      expect(r.status).toBe(400);
    }
  });

  test("refuses to drop the trusted proxy the admin is connected through", async () => {
    saveTrustedProxies(["172.18.0.5"]);
    savePolicy(policy({ allowLan: false, allowTailnet: false }));
    const res = await call(
      admin,
      "/api/network/public-urls",
      { method: "PUT", body: { publicUrls: [], trustedProxies: [] }, headers: CLOUDFLARED },
      "172.18.0.5",
    );
    expect(res.status).toBe(409);
    expect(loadNetworkConfig().trustedProxies).toEqual(["172.18.0.5"]);
  });
});

describe("Cloudflare Access settings", () => {
  test("normalizes the team domain and validates the audience", async () => {
    const ok = await call(admin, "/api/network/cloudflare/access", {
      method: "PUT",
      body: { teamDomain: "https://LambTest.cloudflareaccess.com/", audience: AUD.toUpperCase() },
    });
    expect(ok.status).toBe(200);
    const s = ((await ok.json()) as NetworkStatusResponse).status;
    expect(s.cloudflare.access).toEqual({ teamDomain: TEAM, audience: AUD, configured: true, lastVerifiedAt: null });

    const bad: unknown[] = [
      { teamDomain: "evil.example.com", audience: AUD },
      { teamDomain: TEAM, audience: "short" },
      { teamDomain: TEAM, audience: null },
      { teamDomain: "-bad-.cloudflareaccess.com", audience: AUD },
    ];
    for (const body of bad) {
      expect((await call(admin, "/api/network/cloudflare/access", { method: "PUT", body })).status).toBe(400);
    }
  });

  test("the session test explains what is missing", async () => {
    const notConfigured = (await (await call(admin, "/api/network/cloudflare/access/test", { method: "POST" })).json()) as CloudflareAccessTestResponse;
    expect(notConfigured.ok).toBe(false);
    expect(notConfigured.error).toContain("not configured");

    saveAccessConfig({ teamDomain: TEAM, audience: AUD });
    const noHeader = (await (await call(admin, "/api/network/cloudflare/access/test", { method: "POST" })).json()) as CloudflareAccessTestResponse;
    expect(noHeader.ok).toBe(false);
    expect(noHeader.error).toContain("Cf-Access-Jwt-Assertion");

    const expired = await signRs256(key, accessClaims({ exp: Math.floor(Date.now() / 1000) - 600 }));
    const bad = (await (
      await call(admin, "/api/network/cloudflare/access/test", { method: "POST", headers: { "Cf-Access-Jwt-Assertion": expired } })
    ).json()) as CloudflareAccessTestResponse;
    expect(bad).toEqual({ ok: false, email: null, error: "token has expired" });
    expect(settings.get(KEYS.accessVerifiedAt)).toBe("");
  });
});

describe("POST /tailscale/serve", () => {
  test("is read-only when Unraid manages Tailscale", async () => {
    process.env.ORG_ENTRYPOINT = "/opt/unraid/tailscale";
    process.env.TAILSCALE_STATE_DIR = "/data/.tailscale_state";
    try {
      const res = await call(admin, "/api/network/tailscale/serve", { method: "POST", body: { enabled: true } });
      expect(res.status).toBe(409);
      expect(await errorOf(res)).toContain("Unraid");
    } finally {
      delete process.env.ORG_ENTRYPOINT;
      delete process.env.TAILSCALE_STATE_DIR;
    }
  });

  test("needs a running Tailscale", async () => {
    const res = await call(admin, "/api/network/tailscale/serve", { method: "POST", body: { enabled: true } });
    expect(res.status).toBe(409);
  });
});
