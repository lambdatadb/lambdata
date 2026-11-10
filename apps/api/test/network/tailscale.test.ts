import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { Hono } from "hono";
import { join } from "node:path";
import type { NetworkStatusResponse, TailscaleStatus } from "@lambdata/shared";
import { authHeaders, seedUser, useTempMetadata, type SeededUser, type TempMetadata } from "../harness/sqlite";
import { buildApp } from "../../src/server";
import { audit } from "../../src/db/queries";
import { env } from "../../src/env";
import { OPEN_POLICY, savePolicy } from "../../src/network/config";
import { isAllowedOrigin } from "../../src/network/origins";
import { refreshTailscaleRuntime, resetTailscaleCaches, tailscaleUp } from "../../src/tailscale/cli";
import { accessGuard } from "../../src/network/guard";
import { clientIp } from "../../src/network/request";
import { peerEnv, useFakeTailscale, type FakeBin } from "./helpers";

let md: TempMetadata;
let app: ReturnType<typeof buildApp>;
let admin: SeededUser;
let ts: FakeBin;
const authKey = "tskey-auth-kTESTkey11CNTRL-abcdefghijklmnopqrstuvwxyz0123";

function calls(): string[] {
  const path = join(ts.state, "calls.log");
  return existsSync(path) ? readFileSync(path, "utf8").trim().split("\n") : [];
}

async function call(path: string, init: { method?: string; body?: unknown } = {}, peer = "127.0.0.1", port = 40_000): Promise<Response> {
  const headers = await authHeaders(admin, { "Content-Type": "application/json" });
  return app.request(
    path,
    { method: init.method ?? "GET", headers, body: init.body === undefined ? undefined : JSON.stringify(init.body) },
    peerEnv(peer, port),
  );
}

beforeAll(() => {
  md = useTempMetadata();
  app = buildApp();
  admin = seedUser("admin");
  ts = useFakeTailscale();
});

afterAll(() => {
  savePolicy({ ...OPEN_POLICY });
  ts.restore();
  resetTailscaleCaches();
  md.cleanup();
});

beforeEach(() => {
  savePolicy({ ...OPEN_POLICY });
  rmSync(join(ts.state, "calls.log"), { force: true });
  rmSync(join(ts.state, "up-fail"), { force: true });
});

describe("tailscale up", () => {
  test("passes the auth key through a temporary file, never in the arguments", async () => {
    const r = await tailscaleUp(authKey);
    expect(r).toEqual({ ok: true });
    const line = calls().find((l) => l.startsWith("up"))!;
    expect(line).toContain("--auth-key=file:");
    expect(line).not.toContain(authKey);
    expect(readFileSync(join(ts.state, "authkey.seen"), "utf8")).toBe(authKey);
    const keyFile = readFileSync(join(ts.state, "authkey.path"), "utf8").trim();
    expect(existsSync(keyFile)).toBe(false);
  });

  test("redacts the key from error output", async () => {
    writeFileSync(join(ts.state, "up-fail"), "1");
    const r = await tailscaleUp(authKey);
    expect(r.ok).toBe(false);
    expect(r.error).toContain("[redacted]");
    expect(r.error).not.toContain(authKey);
  });

  test("the legacy route keeps working and audits without the key", async () => {
    const status = (await (await call("/api/tailscale/status")).json()) as TailscaleStatus;
    expect(status).toMatchObject({ installed: true, running: true, hostname: "box", tailnetIp: "100.88.0.1" });
    const res = await call("/api/tailscale/up", { method: "POST", body: { authKey } });
    expect(res.status).toBe(200);
    const entries = JSON.stringify(audit.list(20));
    expect(entries).toContain("tailscale.up");
    expect(entries).not.toContain(authKey);
    const failing = await call("/api/tailscale/up", { method: "POST", body: { authKey: 42 } });
    expect(failing.status).toBe(400);
    expect((await call("/api/tailscale/down", { method: "POST" })).status).toBe(200);
  });
});

describe("tailscale serve", () => {
  test("enables and disables Serve for the console and reports the URL", async () => {
    const on = await call("/api/network/tailscale/serve", { method: "POST", body: { enabled: true } });
    expect(on.status).toBe(200);
    const s = ((await on.json()) as NetworkStatusResponse).status;
    expect(s.tailscale.serve).toEqual({ supported: true, enabled: true, url: "https://box.tail1234.ts.net" });
    expect(calls()).toContain(`serve --bg --https=443 http://127.0.0.1:${env.port}`);
    expect(isAllowedOrigin("https://box.tail1234.ts.net")).toBe(true);

    const off = await call("/api/network/tailscale/serve", { method: "POST", body: { enabled: false } });
    expect(off.status).toBe(200);
    expect(((await off.json()) as NetworkStatusResponse).status.tailscale.serve).toEqual({ supported: true, enabled: false, url: null });
    expect(isAllowedOrigin("https://box.tail1234.ts.net")).toBe(false);
    expect(audit.list(5).some((e) => e.action === "network.tailscale.serve.disable")).toBe(true);
  });

  test("ignores Serve handlers that point somewhere else", async () => {
    writeFileSync(
      join(ts.state, "serve.json"),
      JSON.stringify({ Web: { "box.tail1234.ts.net:443": { Handlers: { "/": { Proxy: "http://127.0.0.1:9999" } } } } }),
    );
    const s = ((await (await call("/api/network/status")).json()) as NetworkStatusResponse).status;
    expect(s.tailscale.serve).toEqual({ supported: true, enabled: false, url: null });
    rmSync(join(ts.state, "serve.json"), { force: true });
  });
});

describe("userspace networking", () => {
  test("a tailnet connection proxied to loopback is classified as tailnet", async () => {
    writeFileSync(join(ts.state, "whois-ports"), "51001\n");
    await refreshTailscaleRuntime();
    const viaTailnet = ((await (await call("/api/network/status", {}, "127.0.0.1", 51001)).json()) as NetworkStatusResponse).status;
    expect(viaTailnet.yourIngress).toBe("tailnet");
    expect(viaTailnet.yourIp).toBe("100.88.1.2");
    const local = ((await (await call("/api/network/status", {}, "127.0.0.1", 51002)).json()) as NetworkStatusResponse).status;
    expect(local.yourIngress).toBe("loopback");

    savePolicy({ ...OPEN_POLICY, allowTailnet: false });
    expect((await app.request("/api/nope", {}, peerEnv("127.0.0.1", 51001))).status).toBe(403);
    expect((await app.request("/api/nope", {}, peerEnv("127.0.0.1", 51002))).status).toBe(404);
  });

  test("clientIp reports the tailnet peer even under the open policy", async () => {
    writeFileSync(join(ts.state, "whois-ports"), "51003\n");
    await refreshTailscaleRuntime();
    const probe = new Hono();
    probe.use("*", accessGuard);
    probe.get("/ip", (c) => c.text(clientIp(c)));
    expect(await (await probe.request("/ip", {}, peerEnv("127.0.0.1", 51003))).text()).toBe("100.88.1.2");
    expect(await (await probe.request("/ip", {}, peerEnv("127.0.0.1", 51004))).text()).toBe("127.0.0.1");
  });
});
