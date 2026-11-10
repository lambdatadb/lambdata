import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { homedir } from "node:os";
import { useTempMetadata, type TempMetadata } from "../harness/sqlite";
import { buildApp } from "../../src/server";
import { db } from "../../src/db/client";
import { settings, users } from "../../src/db/queries";
import {
  announceSetupToken,
  expireSetupToken,
  issueSetupToken,
  setupTokenActive,
  verifySetupToken,
} from "../../src/auth/setupToken";
import { SETUP_TOKEN_INVALID, SETUP_TOKEN_MISSING, setupTokenFailures } from "../../src/routes/setup";
import { peerEnv } from "../network/helpers";

let md: TempMetadata;
let app: ReturnType<typeof buildApp>;
let token: string;

const LAN = "192.168.1.20";
const OTHER_LAN = "192.168.1.21";

beforeAll(() => {
  md = useTempMetadata();
  app = buildApp();
});

afterAll(() => {
  expireSetupToken();
  settings.set("setup_complete", "1");
  md.cleanup();
});

beforeEach(() => {
  db.query("UPDATE audit_log SET user_id = NULL").run();
  db.query("DELETE FROM users").run();
  settings.set("setup_complete", "0");
  setupTokenFailures.reset();
  token = issueSetupToken();
});

function post(path: string, body: unknown, peer: string | null, headers: Record<string, string> = {}) {
  return app.request(
    path,
    { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) },
    peerEnv(peer),
  );
}

function admin(extra: Record<string, unknown> = {}) {
  return { email: "avery@example.com", password: "correct-horse-battery", displayName: "Avery Chen", ...extra };
}

async function state(peer: string | null, headers: Record<string, string> = {}) {
  return (await app.request("/api/setup/state", { headers }, peerEnv(peer))).json();
}

describe("the token itself", () => {
  test("is long, readable, checked without regard to case or dashes, and only the latest one works", () => {
    expect(token).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4}){4}$/);
    expect(verifySetupToken(token)).toBe(true);
    expect(verifySetupToken(token.toLowerCase().replaceAll("-", " "))).toBe(true);
    expect(verifySetupToken("")).toBe(false);
    expect(verifySetupToken(`${token}X`)).toBe(false);
    const next = issueSetupToken();
    expect(verifySetupToken(token)).toBe(false);
    expect(verifySetupToken(next)).toBe(true);
    expireSetupToken();
    expect(setupTokenActive()).toBe(false);
    expect(verifySetupToken(next)).toBe(false);
  });

  test("the boot banner prints the token once with a line saying what it is for", () => {
    const lines: string[] = [];
    const printed = announceSetupToken((line) => lines.push(line));
    const text = lines.join("\n");
    expect(text.split(printed).length - 1).toBe(1);
    expect(text).toContain("first-run setup token");
    expect(text).toContain("setup wizard");
    expect(text).toContain("first admin");
    expect(verifySetupToken(printed)).toBe(true);
  });
});

describe("GET /api/setup/state", () => {
  test("a remote visitor learns a token is required and does not see the home directory", async () => {
    const remote = await state(LAN);
    expect(remote.needsSetup).toBe(true);
    expect(remote.tokenRequired).toBe(true);
    expect(remote.homeDir).toBe("");
    expect(typeof remote.dataDir).toBe("string");
  });

  test("the server itself is exempt and still gets the home directory for the folder presets", async () => {
    const local = await state("127.0.0.1");
    expect(local.tokenRequired).toBe(false);
    expect(local.homeDir).toBe(homedir());
  });

  test("loopback carrying proxy headers (Serve, Funnel, a tunnel) is not the server itself", async () => {
    const proxied: Record<string, string>[] = [
      { "X-Forwarded-For": "100.101.102.103", "Tailscale-User-Login": "avery@example.com" },
      { "Tailscale-Funnel-Request": "?1", "X-Forwarded-For": "203.0.113.50" },
      { "Cf-Ray": "8a1b2c3d4e5f-AMS", "X-Forwarded-For": "203.0.113.50" },
      { "X-Forwarded-For": "127.0.0.1" },
    ];
    for (const headers of proxied) {
      const s = await state("127.0.0.1", headers);
      expect(s.tokenRequired).toBe(true);
      expect(s.homeDir).toBe("");
    }
  });

  test("loopback naming another host in Host, Origin or Referer is a forwarder, not the server itself", async () => {
    const forwarded: Record<string, string>[] = [
      { Host: "db.example.com" },
      { Host: "192.168.1.50:4317" },
      { Host: "localhost:4317", Origin: "https://db.example.com" },
      { Host: "127.0.0.1:4317", Referer: "https://db.example.com/setup" },
    ];
    for (const headers of forwarded) {
      const s = await state("127.0.0.1", headers);
      expect({ headers, tokenRequired: s.tokenRequired, homeDir: s.homeDir }).toEqual({ headers, tokenRequired: true, homeDir: "" });
    }
    for (const host of ["localhost:4317", "127.0.0.1:4317", "[::1]:4317", "app.localhost"]) {
      expect((await state("127.0.0.1", { Host: host, Origin: `http://${host}` })).tokenRequired).toBe(false);
    }
    const res = await post("/api/setup/complete", admin(), "127.0.0.1", { Host: "db.example.com" });
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe(SETUP_TOKEN_MISSING);
    expect(users.byEmail("avery@example.com")).toBeNull();
  });

  test("LAMBDATA_TRUST_LOOPBACK=0 asks for the token on the server itself too", async () => {
    process.env.LAMBDATA_TRUST_LOOPBACK = "0";
    try {
      expect((await state("127.0.0.1", { Host: "localhost:4317" })).tokenRequired).toBe(true);
      expect((await post("/api/setup/complete", admin(), "127.0.0.1", { Host: "localhost:4317" })).status).toBe(403);
      expect((await post("/api/setup/complete", admin({ setupToken: token }), "127.0.0.1", { Host: "localhost:4317" })).status).toBe(200);
    } finally {
      delete process.env.LAMBDATA_TRUST_LOOPBACK;
    }
  });

  test("an install that has completed setup never sees any of it", async () => {
    settings.set("setup_complete", "1");
    expect(await state(LAN)).toEqual({ needsSetup: false, dataDir: "", dataDirConfigured: expect.any(Boolean), homeDir: "", tokenRequired: false });
  });
});

describe("creating the first admin", () => {
  test("the reviewer's claim from a remote visitor without the token is refused", async () => {
    const res = await post("/api/setup/complete", admin(), LAN);
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.code).toBe(SETUP_TOKEN_MISSING);
    expect(body.error).toContain("log");
    expect(users.byEmail("avery@example.com")).toBeNull();
    expect(settings.get("setup_complete")).toBe("0");
  });

  test("a wrong token is refused and does not create the account", async () => {
    const res = await post("/api/setup/complete", admin({ setupToken: "AAAA-BBBB-CCCC-DDDD-EEEE" }), LAN);
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe(SETUP_TOKEN_INVALID);
    expect(users.byEmail("avery@example.com")).toBeNull();
  });

  test("the right token creates the admin, signs them in, and then stops working", async () => {
    const check = await post("/api/setup/token", { setupToken: token }, LAN);
    expect(check.status).toBe(200);
    const res = await post("/api/setup/complete", admin({ setupToken: token }), LAN);
    expect(res.status).toBe(200);
    expect(res.headers.get("set-cookie") ?? "").toContain("lambdata_session=");
    expect(users.byEmail("avery@example.com")?.role).toBe("admin");
    expect(setupTokenActive()).toBe(false);
    expect((await post("/api/setup/complete", admin({ email: "jordan@example.com", setupToken: token }), LAN)).status).toBe(409);
    expect((await post("/api/setup/token", { setupToken: token }, LAN)).status).toBe(409);
  });

  test("a request made on the server itself needs no token", async () => {
    const res = await post("/api/setup/complete", admin(), "127.0.0.1");
    expect(res.status).toBe(200);
    expect(users.byEmail("avery@example.com")?.role).toBe("admin");
  });

  test("wrong tokens are rate limited per client, the right token included, and other clients are unaffected", async () => {
    for (let i = 0; i < 10; i++) {
      expect((await post("/api/setup/token", { setupToken: `WRONG-${i}` }, LAN)).status).toBe(403);
    }
    const limited = await post("/api/setup/token", { setupToken: token }, LAN);
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
    expect((await post("/api/setup/complete", admin({ setupToken: token }), LAN)).status).toBe(429);
    expect(users.byEmail("avery@example.com")).toBeNull();
    expect((await post("/api/setup/complete", admin({ setupToken: token }), OTHER_LAN)).status).toBe(200);
  });

  test("a missing token is not counted as a guess", async () => {
    for (let i = 0; i < 12; i++) expect((await post("/api/setup/token", {}, LAN)).status).toBe(403);
    expect((await post("/api/setup/token", { setupToken: token }, LAN)).status).toBe(200);
  });

  test("if no token is active (for example after an unexpected reset), a remote request prints a fresh one", async () => {
    expireSetupToken();
    const res = await post("/api/setup/complete", admin(), LAN);
    expect(res.status).toBe(403);
    expect(setupTokenActive()).toBe(true);
  });
});

describe("choosing the data directory", () => {
  test("remote callers need the token; with it they reach the directory checks", async () => {
    const without = await post("/api/setup/data-dir", { path: "relative/not-allowed" }, LAN);
    expect(without.status).toBe(403);
    expect((await without.json()).code).toBe(SETUP_TOKEN_MISSING);
    const wrong = await post("/api/setup/data-dir", { path: "relative/not-allowed", setupToken: "nope" }, LAN);
    expect((await wrong.json()).code).toBe(SETUP_TOKEN_INVALID);
    const withToken = await post("/api/setup/data-dir", { path: "relative/not-allowed", setupToken: token }, LAN);
    expect((await withToken.json()).code).toBeUndefined();
    expect(withToken.status).not.toBe(403);
  });
});
