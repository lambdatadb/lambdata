import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { NetworkStatusResponse } from "@lambdata/shared";
import { authHeaders, seedUser, useTempMetadata, type SeededUser, type TempMetadata } from "../harness/sqlite";
import { buildApp } from "../../src/server";
import { audit, settings } from "../../src/db/queries";
import { env } from "../../src/env";
import { decryptSecret } from "../../src/util/crypto";
import { processCommand } from "../../src/util/processes";
import { KEYS, OPEN_POLICY, savePolicy } from "../../src/network/config";
import { stopTunnel, tunnelState, extractTunnelToken } from "../../src/network/cloudflared";
import { networkService } from "../../src/network/service";
import { fakeTunnelToken, peerEnv, useFakeCloudflared, useFakeTailscale, waitFor, type FakeBin } from "./helpers";

let md: TempMetadata;
let app: ReturnType<typeof buildApp>;
let admin: SeededUser;
let cf: FakeBin;
let ts: FakeBin;
const token = fakeTunnelToken();

interface Run {
  pid: number;
  args?: string[];
  token?: string | null;
  envKeys?: string[];
  stopped?: boolean;
}

function runs(): Run[] {
  const path = join(cf.state, "runs.log");
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Run);
}

function started(): Run[] {
  return runs().filter((r) => r.args);
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function call(path: string, init: { method?: string; body?: unknown; headers?: Record<string, string> } = {}, peer = "127.0.0.1"): Promise<Response> {
  const headers = await authHeaders(admin, { "Content-Type": "application/json", ...(init.headers ?? {}) });
  return app.request(
    path,
    { method: init.method ?? "GET", headers, body: init.body === undefined ? undefined : JSON.stringify(init.body) },
    peerEnv(peer),
  );
}

async function status(): Promise<NetworkStatusResponse["status"]> {
  return ((await (await call("/api/network/status")).json()) as NetworkStatusResponse).status;
}

beforeAll(() => {
  md = useTempMetadata();
  app = buildApp();
  admin = seedUser("admin");
  ts = useFakeTailscale({ BackendState: "Stopped" });
});

afterAll(async () => {
  await stopTunnel();
  cf?.restore();
  ts.restore();
  savePolicy({ ...OPEN_POLICY });
  md.cleanup();
});

describe("without cloudflared installed", () => {
  test("reports installed: false and refuses to start", async () => {
    const s = await status();
    expect(s.cloudflare.tunnel).toMatchObject({ mode: "off", installed: false, running: false, tokenConfigured: false });
    const put = await call("/api/network/cloudflare/tunnel", { method: "PUT", body: { mode: "managed", token } });
    expect(put.status).toBe(200);
    const start = await call("/api/network/cloudflare/tunnel/start", { method: "POST" });
    expect(start.status).toBe(409);
    expect(((await start.json()) as { error: string }).error).toContain("not installed");
  });
});

describe("token handling", () => {
  test("rejects things that are not tunnel tokens", async () => {
    for (const bad of ["hello", "eyJhIjoieCJ9", "x".repeat(100)]) {
      const res = await call("/api/network/cloudflare/tunnel", { method: "PUT", body: { mode: "managed", token: bad } });
      expect(res.status).toBe(400);
    }
  });

  test("extracts the token from a pasted install command", () => {
    expect(extractTunnelToken(`sudo cloudflared service install ${token}`)).toBe(token);
    expect(extractTunnelToken(`docker run cloudflare/cloudflared:latest tunnel --no-autoupdate run --token ${token}`)).toBe(token);
    expect(extractTunnelToken(`"${token}"`)).toBe(token);
  });

  test("stores the token encrypted and never returns or audits it", async () => {
    const res = await call("/api/network/cloudflare/tunnel", {
      method: "PUT",
      body: { mode: "managed", token: `cloudflared.exe service install ${token}` },
    });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain(token);
    expect((JSON.parse(text) as NetworkStatusResponse).status.cloudflare.tunnel.tokenConfigured).toBe(true);
    const stored = settings.get(KEYS.tunnelToken)!;
    expect(stored).not.toContain(token);
    expect(await decryptSecret(stored)).toBe(token);
    const logs = JSON.stringify(audit.list(100));
    expect(logs).not.toContain(token);
    expect(logs).toContain("network.cloudflare.tunnel.update");
  });

  test("managed mode needs a token", async () => {
    const clear = await call("/api/network/cloudflare/tunnel", { method: "PUT", body: { mode: "managed", token: "" } });
    expect(clear.status).toBe(400);
    const off = await call("/api/network/cloudflare/tunnel", { method: "PUT", body: { mode: "off", token: "" } });
    expect(off.status).toBe(200);
    expect(settings.get(KEYS.tunnelToken)).toBe("");
    const managed = await call("/api/network/cloudflare/tunnel", { method: "PUT", body: { mode: "managed" } });
    expect(managed.status).toBe(400);
  });
});

describe("supervising a fake cloudflared", () => {
  beforeAll(async () => {
    cf = useFakeCloudflared();
    const res = await call("/api/network/cloudflare/tunnel", { method: "PUT", body: { mode: "managed", token } });
    expect(res.status).toBe(200);
  });

  beforeEach(() => rmSync(join(cf.state, "mode"), { force: true }));

  test("starts cloudflared with the token in the environment only", async () => {
    const res = await call("/api/network/cloudflare/tunnel/start", { method: "POST" });
    expect(res.status).toBe(200);
    await waitFor(() => started().length >= 1);
    const run = started().at(-1)!;
    expect(run.args?.slice(0, 3)).toEqual(["tunnel", "--no-autoupdate", "--metrics"]);
    expect(run.args?.[3]).toMatch(/^127\.0\.0\.1:\d+$/);
    expect(run.args?.[4]).toBe("run");
    expect(run.args?.join(" ")).not.toContain(token);
    expect(run.token).toBe(token);
    expect(run.envKeys).not.toContain("LAMBDATA_DATA_DIR");
    expect(run.envKeys).toContain("TUNNEL_FAKE_DIR");
    const command = processCommand(run.pid);
    expect(command).not.toBeNull();
    expect(command!).not.toContain(token);
    expect(settings.get(KEYS.tunnelAutostart)).toBe("1");
  });

  test("reports version, connections and start time", async () => {
    await waitFor(async () => (await status()).cloudflare.tunnel.connections === 4);
    const s = (await status()).cloudflare.tunnel;
    expect(s).toMatchObject({ mode: "managed", installed: true, version: "2025.1.0", running: true, connections: 4, lastError: null });
    expect(typeof s.startedAt).toBe("number");
  });

  test("writes a log without the token", () => {
    const log = readFileSync(join(env.logsDir, "cloudflared.log"), "utf8");
    expect(log).toContain("Registered tunnel connection");
    expect(log).not.toContain(token);
    expect(existsSync(join(env.logsDir, "cloudflared.pid"))).toBe(true);
  });

  test("restarts after a crash with backoff and reports the error", async () => {
    const before = started().length;
    const victim = tunnelState().pid!;
    writeFileSync(join(cf.state, "mode"), "crash");
    process.kill(victim, "SIGKILL");
    await waitFor(() => started().length >= before + 1, 10_000);
    await waitFor(() => (tunnelState().lastError ?? "").includes("Invalid tunnel secret"), 10_000);
    expect((await status()).cloudflare.tunnel.lastError).toContain("Invalid tunnel secret");
    rmSync(join(cf.state, "mode"), { force: true });
    await waitFor(() => tunnelState().running && started().length >= before + 2, 15_000);
    const first = started()[before]!;
    const second = started()[before + 1]!;
    expect(second.pid).not.toBe(first.pid);
    await waitFor(() => tunnelState().lastError === null, 5_000);
  }, 30_000);

  test("refuses to stop the tunnel when it is the only way in for the caller", async () => {
    savePolicy({ ...OPEN_POLICY, allowLan: false, allowTailnet: false });
    const res = await call(
      "/api/network/cloudflare/tunnel/stop",
      { method: "POST", headers: { "Cf-Ray": "x", "Cf-Connecting-Ip": "203.0.113.9" } },
    );
    expect(res.status).toBe(409);
    expect(tunnelState().running).toBe(true);
    savePolicy({ ...OPEN_POLICY });
  });

  test("restarts with a new token when the token changes", async () => {
    const before = started().length;
    const next = fakeTunnelToken("another-secret-value-for-the-tunnel-0000");
    const res = await call("/api/network/cloudflare/tunnel", { method: "PUT", body: { mode: "managed", token: next } });
    expect(res.status).toBe(200);
    await waitFor(() => started().length > before);
    expect(started().at(-1)!.token).toBe(next);
  });

  test("stops cleanly", async () => {
    const pid = tunnelState().pid!;
    const res = await call("/api/network/cloudflare/tunnel/stop", { method: "POST" });
    expect(res.status).toBe(200);
    expect(alive(pid)).toBe(false);
    expect(runs().some((r) => r.pid === pid && r.stopped)).toBe(true);
    expect((await status()).cloudflare.tunnel).toMatchObject({ running: false, connections: null });
    expect(settings.get(KEYS.tunnelAutostart)).toBe("0");
    expect(existsSync(join(env.logsDir, "cloudflared.pid"))).toBe(false);
  });

  test("the network service autostarts it and stops it on shutdown", async () => {
    settings.set(KEYS.tunnelAutostart, "1");
    await networkService.start();
    await waitFor(() => tunnelState().running);
    const pid = tunnelState().pid!;
    await networkService.stop();
    expect(alive(pid)).toBe(false);
    expect(tunnelState().running).toBe(false);
    expect(settings.get(KEYS.tunnelAutostart)).toBe("1");
  });

  test("kills a cloudflared left behind by a previous run", async () => {
    const bin = Bun.which("cloudflared", { PATH: process.env.PATH ?? "" })!;
    const orphan = Bun.spawn([bin, "tunnel", "--no-autoupdate", "--metrics", "127.0.0.1:0", "run"], {
      env: { ...process.env, TUNNEL_TOKEN: token },
      stdout: "ignore",
      stderr: "ignore",
    });
    await waitFor(() => runs().some((r) => r.pid === orphan.pid));
    writeFileSync(join(env.logsDir, "cloudflared.pid"), String(orphan.pid));
    await networkService.start();
    await orphan.exited;
    expect(alive(orphan.pid)).toBe(false);
    await waitFor(() => tunnelState().running);
    await networkService.stop();
  });

  test("switching the mode off stops the tunnel and clears autostart", async () => {
    await call("/api/network/cloudflare/tunnel/start", { method: "POST" });
    await waitFor(() => tunnelState().running);
    const res = await call("/api/network/cloudflare/tunnel", { method: "PUT", body: { mode: "external" } });
    expect(res.status).toBe(200);
    expect(tunnelState().running).toBe(false);
    expect(settings.get(KEYS.tunnelAutostart)).toBe("0");
    const start = await call("/api/network/cloudflare/tunnel/start", { method: "POST" });
    expect(start.status).toBe(409);
  });
});
