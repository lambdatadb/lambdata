import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TailscaleServeStatus, TailscaleStatus } from "@lambdata/shared";
import { readEnv } from "../util/readEnv";

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

const DEFAULT_TIMEOUT_MS = 15_000;
const RUNTIME_TTL_MS = 30_000;
const WHOIS_TTL_MS = 30_000;
const WHOIS_TIMEOUT_MS = 1_500;
const WHOIS_CACHE_LIMIT = 1_000;
const KEY_PATTERN = /tskey-[A-Za-z0-9_-]+/g;

export function tailscaleBinary(): string | null {
  const configured = readEnv("TAILSCALE_BIN");
  if (configured) return existsSync(configured) ? configured : null;
  return Bun.which("tailscale", { PATH: process.env.PATH ?? "" });
}

async function run(args: string[], timeoutMs = DEFAULT_TIMEOUT_MS): Promise<RunResult> {
  const bin = tailscaleBinary();
  if (!bin) return { code: 127, stdout: "", stderr: "tailscale not found", timedOut: false };
  let proc: ReturnType<typeof Bun.spawn<"ignore", "pipe", "pipe">>;
  try {
    proc = Bun.spawn([bin, ...args], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  } catch {
    return { code: 127, stdout: "", stderr: "tailscale not found", timedOut: false };
  }
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill("SIGKILL");
  }, timeoutMs);
  try {
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    const code = await proc.exited;
    return { code: timedOut ? 124 : code, stdout, stderr, timedOut };
  } finally {
    clearTimeout(timer);
  }
}

export function redactTailscaleOutput(text: string, secret?: string): string {
  let out = text;
  if (secret) out = out.split(secret).join("[redacted]");
  return out.replace(KEY_PATTERN, "[redacted]").trim();
}

function failure(r: RunResult, secret?: string): string {
  const text = redactTailscaleOutput(r.stderr || r.stdout, secret);
  if (r.timedOut) return text ? `tailscale did not finish in time: ${text}` : "tailscale did not finish in time";
  return text || `tailscale exited with code ${r.code}`;
}

export function tailscaleManager(): TailscaleStatus["managedBy"] {
  return process.env.ORG_ENTRYPOINT && process.env.TAILSCALE_STATE_DIR ? "unraid" : null;
}

interface StatusJson {
  BackendState?: string;
  TUN?: boolean;
  Self?: { HostName?: string; DNSName?: string; TailscaleIPs?: string[] };
}

interface Runtime {
  installed: boolean;
  running: boolean;
  userspace: boolean;
  dnsName: string | null;
  checkedAt: number;
}

let runtime: Runtime = { installed: false, running: false, userspace: false, dnsName: null, checkedAt: 0 };
const whoisCache = new Map<string, { ip: string | null; until: number }>();
const whoisInflight = new Map<string, Promise<string | null>>();

async function readStatus(): Promise<{ installed: boolean; data: StatusJson | null }> {
  const ver = await run(["--version"], 5_000);
  if (ver.code !== 0) return { installed: false, data: null };
  const s = await run(["status", "--json"], 5_000);
  if (s.code !== 0) return { installed: true, data: null };
  try {
    return { installed: true, data: JSON.parse(s.stdout) as StatusJson };
  } catch {
    return { installed: true, data: null };
  }
}

function recordRuntime(installed: boolean, data: StatusJson | null): void {
  const dns = data?.Self?.DNSName?.replace(/\.$/, "") ?? null;
  runtime = {
    installed,
    running: data?.BackendState === "Running",
    userspace: data?.TUN === false,
    dnsName: dns || null,
    checkedAt: Date.now(),
  };
}

export function tailscaleRuntime(): Readonly<Runtime> {
  return runtime;
}

export async function refreshTailscaleRuntime(): Promise<Readonly<Runtime>> {
  const { installed, data } = await readStatus();
  recordRuntime(installed, data);
  return runtime;
}

export function tailscaleRuntimeStale(): boolean {
  return Date.now() - runtime.checkedAt > RUNTIME_TTL_MS;
}

export async function tailscaleStatus(): Promise<TailscaleStatus> {
  const managedBy = tailscaleManager();
  const { installed, data } = await readStatus();
  recordRuntime(installed, data);
  if (!installed) return { installed: false, running: false, hostname: null, tailnetIp: null, managedBy };
  if (!data) return { installed: true, running: false, hostname: null, tailnetIp: null, managedBy };
  return {
    installed: true,
    running: data.BackendState === "Running",
    hostname: data.Self?.HostName ?? null,
    tailnetIp: data.Self?.TailscaleIPs?.[0] ?? null,
    managedBy,
  };
}

export async function tailscaleUp(authKey?: string): Promise<{ ok: boolean; error?: string }> {
  const args = ["up"];
  let dir: string | null = null;
  try {
    if (authKey) {
      dir = mkdtempSync(join(tmpdir(), "ld-ts-"));
      const file = join(dir, "authkey");
      writeFileSync(file, authKey, { mode: 0o600 });
      args.push(`--auth-key=file:${file}`);
    }
    const r = await run(args, 60_000);
    return r.code === 0 ? { ok: true } : { ok: false, error: failure(r, authKey) };
  } finally {
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
}

export async function tailscaleDown(): Promise<{ ok: boolean; error?: string }> {
  const r = await run(["down"]);
  return r.code === 0 ? { ok: true } : { ok: false, error: failure(r) };
}

interface ServeJson {
  Web?: Record<string, { Handlers?: Record<string, { Proxy?: string }> }>;
}

function proxyPort(target: string): number | null {
  const trimmed = target.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed);
  try {
    const url = new URL(trimmed.includes("://") ? trimmed : `http://${trimmed}`);
    const host = url.hostname.replace(/^\[|\]$/g, "");
    if (!["127.0.0.1", "localhost", "::1", "0.0.0.0"].includes(host)) return null;
    return url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80;
  } catch {
    return null;
  }
}

export function serveUrlFromConfig(json: ServeJson, port: number): string | null {
  for (const [hostPort, web] of Object.entries(json.Web ?? {})) {
    const root = web.Handlers?.["/"];
    if (!root?.Proxy || proxyPort(root.Proxy) !== port) continue;
    const host = hostPort.endsWith(":443") ? hostPort.slice(0, -4) : hostPort;
    return `https://${host}`;
  }
  return null;
}

export async function tailscaleServeStatus(port: number): Promise<TailscaleServeStatus> {
  const r = await run(["serve", "status", "--json"], 5_000);
  if (r.code !== 0) return { supported: false, enabled: false, url: null };
  let json: ServeJson = {};
  try {
    const text = r.stdout.trim();
    json = text ? (JSON.parse(text) as ServeJson) : {};
  } catch {
    return { supported: false, enabled: false, url: null };
  }
  const url = serveUrlFromConfig(json, port);
  return { supported: true, enabled: url !== null, url };
}

export async function tailscaleServeSet(
  enabled: boolean,
  port: number,
): Promise<{ ok: boolean; error?: string; status: TailscaleServeStatus }> {
  const args = enabled
    ? ["serve", "--bg", "--https=443", `http://127.0.0.1:${port}`]
    : ["serve", "--https=443", "off"];
  const r = await run(args, 20_000);
  const status = await tailscaleServeStatus(port);
  if (r.code !== 0 && status.enabled !== enabled) return { ok: false, error: failure(r), status };
  return { ok: true, status };
}

function parseWhois(stdout: string): string | null {
  try {
    const data = JSON.parse(stdout) as { Node?: { Addresses?: unknown } };
    const addresses = data.Node?.Addresses;
    if (!Array.isArray(addresses)) return null;
    const first = addresses.find((a): a is string => typeof a === "string");
    return first ? first.replace(/\/\d+$/, "") : null;
  } catch {
    return null;
  }
}

export async function tailscaleWhois(addrPort: string): Promise<string | null> {
  const now = Date.now();
  const cached = whoisCache.get(addrPort);
  if (cached && cached.until > now) return cached.ip;
  const pending = whoisInflight.get(addrPort);
  if (pending) return pending;
  const lookup = run(["whois", "--json", addrPort], WHOIS_TIMEOUT_MS)
    .then((r) => (r.code === 0 ? parseWhois(r.stdout) : null))
    .catch(() => null)
    .then((ip) => {
      if (whoisCache.size >= WHOIS_CACHE_LIMIT) whoisCache.clear();
      whoisCache.set(addrPort, { ip, until: Date.now() + WHOIS_TTL_MS });
      return ip;
    })
    .finally(() => whoisInflight.delete(addrPort));
  whoisInflight.set(addrPort, lookup);
  return lookup;
}

export function resetTailscaleCaches(): void {
  runtime = { installed: false, running: false, userspace: false, dnsName: null, checkedAt: 0 };
  whoisCache.clear();
  whoisInflight.clear();
}
