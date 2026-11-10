import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { authHeaders, seedUser, useTempMetadata, type SeededUser, type TempMetadata } from "../harness/sqlite";
import { buildApp } from "../../src/server";
import { settings, users } from "../../src/db/queries";
import { hashPassword } from "../../src/auth/password";
import { OPEN_POLICY, savePolicy, savePublicUrls, saveServeUrl, saveTrustedProxies } from "../../src/network/config";
import { guardUpgradeRequest } from "../../src/network/guard";
import { JSON_REQUIRED_MESSAGE, checkRequestOrigin, isSameServerOrigin } from "../../src/network/csrf";
import { newId } from "../../src/util/id";
import { peerEnv } from "./helpers";

let md: TempMetadata;
let app: ReturnType<typeof buildApp>;
let admin: SeededUser;

const LAN_CLIENT = "192.168.1.20";
const LAN_HOST = "192.168.1.50:4317";
const SIBLING = "http://192.168.1.50:8080";
const TAILNET_CLIENT = "100.101.102.103";

beforeAll(() => {
  md = useTempMetadata();
  app = buildApp();
  admin = seedUser("admin");
  settings.set("setup_complete", "1");
});

afterAll(() => {
  savePolicy({ ...OPEN_POLICY });
  md.cleanup();
});

beforeEach(() => {
  savePolicy({ ...OPEN_POLICY });
  saveTrustedProxies([]);
  savePublicUrls([]);
  saveServeUrl(null);
});

interface Case {
  url: string;
  peer: string;
  headers: Record<string, string>;
}

function freshEmail(): string {
  return `made-${newId().slice(-10)}@example.test`;
}

async function createUser(c: Case, extra: Record<string, string> = {}, contentType = "application/json") {
  const email = freshEmail();
  const headers = await authHeaders(admin, { ...c.headers, "Content-Type": contentType, ...extra });
  const res = await app.request(
    c.url.replace(/\/$/, "") + "/api/users",
    { method: "POST", headers, body: JSON.stringify({ email, password: "a-strong-password", role: "admin" }) },
    peerEnv(c.peer),
  );
  return { res, email, created: users.byEmail(email) !== null };
}

async function errorOf(res: Response): Promise<string> {
  return ((await res.json()) as { error: string }).error;
}

const CONSOLE_WAYS: Record<string, Case> = {
  "direct on a LAN IP and port over HTTP": {
    url: `http://${LAN_HOST}`,
    peer: LAN_CLIENT,
    headers: { Host: LAN_HOST, Origin: `http://${LAN_HOST}`, "Sec-Fetch-Site": "same-origin" },
  },
  "through the Vite dev proxy (Host kept, no forwarding headers)": {
    url: "http://localhost:5187",
    peer: "127.0.0.1",
    headers: { Host: "localhost:5187", Origin: "http://localhost:5187", "Sec-Fetch-Site": "same-origin" },
  },
  "behind a TLS-terminating reverse proxy that keeps Host (not a trusted proxy)": {
    url: "http://db.example.com",
    peer: "172.18.0.9",
    headers: {
      Host: "db.example.com",
      Origin: "https://db.example.com",
      "X-Forwarded-For": LAN_CLIENT,
      "X-Forwarded-Proto": "https",
      "Sec-Fetch-Site": "same-origin",
    },
  },
  "through Tailscale Serve": {
    url: "http://box.tail1234.ts.net",
    peer: "127.0.0.1",
    headers: {
      Host: "box.tail1234.ts.net",
      Origin: "https://box.tail1234.ts.net",
      "X-Forwarded-For": TAILNET_CLIENT,
      "X-Forwarded-Proto": "https",
      "X-Forwarded-Host": "box.tail1234.ts.net",
      "Tailscale-User-Login": "avery@example.com",
      "Sec-Fetch-Site": "same-origin",
    },
  },
  "through the managed Cloudflare Tunnel": {
    url: "http://db.example.com",
    peer: "127.0.0.1",
    headers: {
      Host: "db.example.com",
      Origin: "https://db.example.com",
      "Cf-Ray": "8a1b2c3d4e5f-AMS",
      "Cf-Connecting-Ip": "203.0.113.50",
      "Cf-Visitor": '{"scheme":"https"}',
      "X-Forwarded-For": "203.0.113.50",
      "X-Forwarded-Proto": "https",
      "Sec-Fetch-Site": "same-origin",
    },
  },
  "a browser on the server itself": {
    url: "http://localhost:4317",
    peer: "127.0.0.1",
    headers: { Host: "localhost:4317", Origin: "http://localhost:4317", "Sec-Fetch-Site": "same-origin" },
  },
  "curl on the server itself (no Origin, no Sec-Fetch headers)": {
    url: "http://127.0.0.1:4317",
    peer: "127.0.0.1",
    headers: { Host: "127.0.0.1:4317" },
  },
};

describe("the console keeps working however it is reached", () => {
  for (const [name, c] of Object.entries(CONSOLE_WAYS)) {
    test(name, async () => {
      const { res, created } = await createUser(c);
      expect(res.status).toBe(200);
      expect(created).toBe(true);
    });
  }

  test("a proxy or tunnel that rewrites Host works once its address is listed under public URLs", async () => {
    const tunnel: Case = {
      url: "http://localhost:4317",
      peer: "127.0.0.1",
      headers: {
        Host: "localhost:4317",
        Origin: "https://db.example.com",
        "Cf-Ray": "8a1b2c3d4e5f-AMS",
        "X-Forwarded-For": "203.0.113.50",
        "X-Forwarded-Proto": "https",
      },
    };
    const before = await createUser(tunnel);
    expect(before.res.status).toBe(403);
    expect(await errorOf(before.res)).toContain("public URLs");
    expect(before.created).toBe(false);
    savePublicUrls(["https://db.example.com"]);
    const after = await createUser(tunnel);
    expect(after.res.status).toBe(200);
  });

  test("a reverse proxy that rewrites Host is believed about X-Forwarded-Host only once it is a trusted proxy (VSEC-04)", async () => {
    const proxied: Case = {
      url: "http://172.18.0.5:4317",
      peer: "172.18.0.9",
      headers: {
        Host: "172.18.0.5:4317",
        "X-Forwarded-Host": "db.example.com",
        Origin: "https://db.example.com",
        "X-Forwarded-Proto": "https",
      },
    };
    const before = await createUser(proxied);
    expect(before.res.status).toBe(403);
    expect(await errorOf(before.res)).toContain("trusted proxies");
    expect(before.created).toBe(false);
    saveTrustedProxies(["172.18.0.9"]);
    expect((await createUser(proxied)).res.status).toBe(200);
  });

  test("the reviewer's probe: an Origin matching a client-supplied X-Forwarded-Host is refused from an untrusted peer", async () => {
    const forged: Case = {
      url: `http://${LAN_HOST}`,
      peer: LAN_CLIENT,
      headers: { Host: LAN_HOST, Origin: "http://evil.example", "X-Forwarded-Host": "evil.example" },
    };
    const { res, created } = await createUser(forged);
    expect(res.status).toBe(403);
    expect(created).toBe(false);
    process.env.LAMBDATA_TRUST_LOOPBACK = "0";
    try {
      const local = await createUser({ ...forged, url: "http://127.0.0.1:4317", peer: "127.0.0.1", headers: { ...forged.headers, Host: "127.0.0.1:4317" } });
      expect(local.res.status).toBe(403);
    } finally {
      delete process.env.LAMBDATA_TRUST_LOOPBACK;
    }
  });

  test("Tailscale Serve rewriting Host to loopback works through the recorded Serve URL", async () => {
    const serve: Case = {
      url: "http://127.0.0.1:4317",
      peer: "127.0.0.1",
      headers: {
        Host: "127.0.0.1:4317",
        Origin: "https://box.tail1234.ts.net",
        "X-Forwarded-For": TAILNET_CLIENT,
        "X-Forwarded-Proto": "https",
      },
    };
    expect((await createUser(serve)).res.status).toBe(403);
    saveServeUrl("https://box.tail1234.ts.net");
    expect((await createUser(serve)).res.status).toBe(200);
  });

  test("a DELETE and a body-less POST from the console's own client are accepted", async () => {
    const lan = CONSOLE_WAYS["direct on a LAN IP and port over HTTP"]!;
    const victim = seedUser("viewer");
    const del = await app.request(
      `http://${LAN_HOST}/api/users/${victim.id}`,
      { method: "DELETE", headers: await authHeaders(admin, lan.headers) },
      peerEnv(LAN_CLIENT),
    );
    expect(del.status).toBe(200);
    const someone = seedUser("viewer");
    const logoutAll = await app.request(
      `http://${LAN_HOST}/api/auth/logout-all`,
      { method: "POST", headers: await authHeaders(someone, { ...lan.headers, "Content-Type": "application/json" }) },
      peerEnv(LAN_CLIENT),
    );
    expect(logoutAll.status).toBe(200);
  });
});

describe("what a page on another port of the same host (another container's web UI) can make the admin's browser send", () => {
  const sameSite = (extra: Record<string, string> = {}): Case => ({
    url: `http://${LAN_HOST}`,
    peer: LAN_CLIENT,
    headers: { Host: LAN_HOST, Origin: SIBLING, "Sec-Fetch-Site": "same-site", ...extra },
  });

  test("the reviewer's text/plain form post creating an admin is refused", async () => {
    const { res, created } = await createUser(sameSite(), {}, "text/plain");
    expect(res.status).toBe(415);
    expect(await errorOf(res)).toBe(JSON_REQUIRED_MESSAGE);
    expect(created).toBe(false);
  });

  test("the same text/plain request with no Origin at all is refused too", async () => {
    const bare: Case = { url: `http://${LAN_HOST}`, peer: LAN_CLIENT, headers: { Host: LAN_HOST } };
    const { res, created } = await createUser(bare, {}, "text/plain;charset=UTF-8");
    expect(res.status).toBe(415);
    expect(created).toBe(false);
  });

  test("the reviewer's text/plain PATCH of a user is refused", async () => {
    const target = seedUser("viewer");
    const res = await app.request(
      `http://${LAN_HOST}/api/users/${target.id}`,
      {
        method: "PATCH",
        headers: await authHeaders(admin, { ...sameSite().headers, "Content-Type": "text/plain" }),
        body: JSON.stringify({ role: "admin" }),
      },
      peerEnv(LAN_CLIENT),
    );
    expect(res.status).toBe(415);
    expect(users.byId(target.id)!.role).toBe("viewer");
  });

  test("url-encoded and multipart form posts to JSON routes are refused", async () => {
    const form = new FormData();
    form.append("email", freshEmail());
    for (const body of [new URLSearchParams({ email: freshEmail() }), form]) {
      const res = await app.request(
        `http://${LAN_HOST}/api/users`,
        { method: "POST", headers: await authHeaders(admin, sameSite().headers), body },
        peerEnv(LAN_CLIENT),
      );
      expect(res.status).toBe(415);
    }
  });

  test("a no-cors fetch with no body and no Content-Type is refused", async () => {
    const res = await app.request(
      `http://${LAN_HOST}/api/auth/logout-all`,
      { method: "POST", headers: await authHeaders(admin, sameSite().headers) },
      peerEnv(LAN_CLIENT),
    );
    expect(res.status).toBe(415);
  });

  test("even a JSON request is refused when the Origin is another port", async () => {
    const { res, created } = await createUser(sameSite());
    expect(res.status).toBe(403);
    expect(await errorOf(res)).toContain(SIBLING);
    expect(created).toBe(false);
  });

  test("a DELETE from another port is refused", async () => {
    const victim = seedUser("viewer");
    const res = await app.request(
      `http://${LAN_HOST}/api/users/${victim.id}`,
      { method: "DELETE", headers: await authHeaders(admin, sameSite().headers) },
      peerEnv(LAN_CLIENT),
    );
    expect(res.status).toBe(403);
    expect(users.byId(victim.id)).not.toBeNull();
  });

  test("a multipart upload into a bucket from another port is refused, and from the console it is accepted", async () => {
    const lan = CONSOLE_WAYS["direct on a LAN IP and port over HTTP"]!;
    const bucket = await app.request(
      `http://${LAN_HOST}/api/storage/buckets`,
      {
        method: "POST",
        headers: await authHeaders(admin, { ...lan.headers, "Content-Type": "application/json" }),
        body: JSON.stringify({ name: `csrf-${newId().slice(-8)}` }),
      },
      peerEnv(LAN_CLIENT),
    );
    expect(bucket.status).toBe(200);
    const bucketId = ((await bucket.json()) as { bucket: { id: string } }).bucket.id;
    const upload = async (headers: Record<string, string>) => {
      const form = new FormData();
      form.append("file", new File(["hello"], "note.txt", { type: "text/plain" }));
      return app.request(
        `http://${LAN_HOST}/api/storage/buckets/${bucketId}/objects`,
        { method: "POST", headers: await authHeaders(admin, headers), body: form },
        peerEnv(LAN_CLIENT),
      );
    };
    expect((await upload(sameSite().headers)).status).toBe(403);
    expect((await upload(lan.headers)).status).toBe(200);
  });

  test("a sibling subdomain behind the same tunnel is refused", async () => {
    const tunnel = CONSOLE_WAYS["through the managed Cloudflare Tunnel"]!;
    const { res } = await createUser({ ...tunnel, headers: { ...tunnel.headers, Origin: "https://evil.example.com", "Sec-Fetch-Site": "same-site" } });
    expect(res.status).toBe(403);
  });

  test("an http page on the same host cannot post into the https console", async () => {
    const tunnel = CONSOLE_WAYS["through the managed Cloudflare Tunnel"]!;
    const { res } = await createUser({ ...tunnel, headers: { ...tunnel.headers, Origin: "http://db.example.com" } });
    expect(res.status).toBe(403);
  });
});

describe("Origin and Sec-Fetch-Site rules", () => {
  const base = { host: LAN_HOST, forwardedHost: null, https: false };

  test("an allowed Origin wins; a foreign one loses", () => {
    expect(checkRequestOrigin({ ...base, origin: `http://${LAN_HOST}`, fetchSite: "cross-site" }).ok).toBe(true);
    expect(checkRequestOrigin({ ...base, origin: SIBLING, fetchSite: "same-origin" }).ok).toBe(false);
  });

  test("without an Origin, Sec-Fetch-Site decides", () => {
    expect(checkRequestOrigin({ ...base, origin: null, fetchSite: "same-origin" }).ok).toBe(true);
    expect(checkRequestOrigin({ ...base, origin: null, fetchSite: "none" }).ok).toBe(true);
    expect(checkRequestOrigin({ ...base, origin: null, fetchSite: "same-site" }).ok).toBe(false);
    expect(checkRequestOrigin({ ...base, origin: null, fetchSite: "cross-site" }).ok).toBe(false);
  });

  test("an opaque Origin is refused unless the browser says same-origin", () => {
    expect(checkRequestOrigin({ ...base, origin: "null", fetchSite: "cross-site" }).ok).toBe(false);
    expect(checkRequestOrigin({ ...base, origin: "null", fetchSite: null }).ok).toBe(false);
    expect(checkRequestOrigin({ ...base, origin: "null", fetchSite: "same-origin" }).ok).toBe(true);
  });

  test("with neither header the client is not a browser and only the JSON rule applies", () => {
    expect(checkRequestOrigin({ ...base, origin: null, fetchSite: null }).ok).toBe(true);
  });

  test("host comparison handles default ports and IPv6", () => {
    expect(isSameServerOrigin("https://db.example.com", { ...base, host: "db.example.com" })).toBe(true);
    expect(isSameServerOrigin("https://db.example.com", { ...base, host: "db.example.com:443" })).toBe(true);
    expect(isSameServerOrigin("https://db.example.com", { ...base, host: "db.example.com:8443" })).toBe(false);
    expect(isSameServerOrigin("http://[fd00::5]:4317", { ...base, host: "[fd00::5]:4317" })).toBe(true);
    expect(isSameServerOrigin("http://[fd00::5]:4318", { ...base, host: "[fd00::5]:4317" })).toBe(false);
    expect(isSameServerOrigin("http://DB.Example.com", { ...base, host: "db.example.com" })).toBe(true);
    expect(isSameServerOrigin("http://db.example.com.evil.test", { ...base, host: "db.example.com" })).toBe(false);
  });
});

describe("app-facing APIs are not cookie-authenticated and keep accepting cross-origin calls", () => {
  const foreign = { Origin: "https://app.example.org", "Sec-Fetch-Site": "cross-site" };

  function notBlocked(res: Response, body: { error?: string }): void {
    expect(res.status).not.toBe(415);
    expect(body.error ?? "").not.toBe(JSON_REQUIRED_MESSAGE);
    expect(body.error ?? "").not.toStartWith("Request blocked");
  }

  test("App Auth token: a text/plain fetch from another origin, even with a console cookie in the jar", async () => {
    const res = await app.request(
      "http://db.example.com/api/app-auth/token",
      {
        method: "POST",
        headers: await authHeaders(admin, { ...foreign, "Content-Type": "text/plain;charset=UTF-8" }),
        body: JSON.stringify({ email: "nobody@example.test", password: "wrong-password" }),
      },
      peerEnv(LAN_CLIENT),
    );
    notBlocked(res, (await res.json()) as { error?: string });
    expect(res.status).toBe(401);
  });

  test("Data API: a bearer call from another origin reaches the route", async () => {
    const res = await app.request(
      "http://db.example.com/api/data/shop/orders",
      { method: "POST", headers: { ...foreign, Authorization: "Bearer not-a-token", "Content-Type": "text/plain" }, body: "{}" },
      peerEnv(LAN_CLIENT),
    );
    notBlocked(res, (await res.json()) as { error?: string });
    expect(res.status).toBe(401);
  });

  test("functions: a form post from another origin reaches the invoker", async () => {
    const res = await app.request(
      "http://db.example.com/functions/v1/no-such-function",
      { method: "POST", headers: { ...foreign, "Content-Type": "application/x-www-form-urlencoded" }, body: "a=1" },
      peerEnv(LAN_CLIENT),
    );
    const text = await res.text();
    expect(res.status).not.toBe(415);
    expect(text).not.toContain("Request blocked");
  });

  test("realtime: the websocket upgrade from another origin is left to the token check", async () => {
    const ws = new Request("http://db.example.com/api/realtime/v1/websocket?token=x", {
      headers: { Origin: "https://app.example.org", Upgrade: "websocket", Connection: "Upgrade" },
    });
    expect(await guardUpgradeRequest(ws, { requestIP: () => ({ address: LAN_CLIENT, port: 5555 }) })).toBeNull();
  });

  test("CORS preflights: a foreign origin gets no grant, a listed one does", async () => {
    const preflight = (origin: string) =>
      app.request(
        "http://db.example.com/api/users",
        {
          method: "OPTIONS",
          headers: { Origin: origin, "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "content-type" },
        },
        peerEnv(LAN_CLIENT),
      );
    expect((await preflight(SIBLING)).headers.get("access-control-allow-origin")).toBeNull();
    savePublicUrls(["https://db.example.com"]);
    const listed = await preflight("https://db.example.com");
    expect(listed.headers.get("access-control-allow-origin")).toBe("https://db.example.com");
    expect(listed.headers.get("access-control-allow-headers") ?? "").toContain("X-File-Name");
  });
});

describe("session cookie attributes", () => {
  async function login(c: Case): Promise<string> {
    const email = freshEmail();
    users.insert({
      id: newId("u"),
      email,
      passwordHash: await hashPassword("correct-horse-battery"),
      displayName: "Avery Chen",
      role: "admin",
      experienceLevel: "advanced",
    });
    const res = await app.request(
      `${c.url}/api/auth/login`,
      {
        method: "POST",
        headers: { ...c.headers, "Content-Type": "application/json" },
        body: JSON.stringify({ email, password: "correct-horse-battery" }),
      },
      peerEnv(c.peer),
    );
    expect(res.status).toBe(200);
    return res.headers.get("set-cookie") ?? "";
  }

  test("HttpOnly, SameSite=Strict, Path=/, and not Secure on plain HTTP", async () => {
    const cookie = await login(CONSOLE_WAYS["direct on a LAN IP and port over HTTP"]!);
    expect(cookie).toContain("lambdata_session=");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Strict");
    expect(cookie).toContain("Path=/");
    expect(cookie).not.toContain("Secure");
  });

  test("Secure behind HTTPS, whether the proxy is trusted or only the browser's Origin says so", async () => {
    expect(await login(CONSOLE_WAYS["through Tailscale Serve"]!)).toContain("Secure");
    expect(await login(CONSOLE_WAYS["through the managed Cloudflare Tunnel"]!)).toContain("Secure");
    expect(await login(CONSOLE_WAYS["behind a TLS-terminating reverse proxy that keeps Host (not a trusted proxy)"]!)).toContain("Secure");
  });
});
