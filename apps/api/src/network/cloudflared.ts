import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { env, readEnv } from "../env";
import { processCommand } from "../util/processes";

const LOG_MAX_BYTES = 5 * 1024 * 1024;
const STOP_GRACE_MS = 5_000;
const INITIAL_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 60_000;
const STABLE_RUN_MS = 60_000;
const VERSION_TTL_MS = 5 * 60_000;
const METRICS_TIMEOUT_MS = 1_500;
const ERROR_MAX_CHARS = 400;

const ENV_PASSTHROUGH = new Set([
  "PATH",
  "HOME",
  "TZ",
  "LANG",
  "LC_ALL",
  "TMPDIR",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
]);
const ENV_BLOCKED = new Set(["TUNNEL_TOKEN", "TUNNEL_TOKEN_FILE"]);

type TunnelProcess = ReturnType<typeof Bun.spawn<"ignore", "pipe", "pipe">>;

export class TunnelError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TunnelError";
  }
}

interface State {
  desired: boolean;
  proc: TunnelProcess | null;
  token: string | null;
  bin: string | null;
  startedAt: number | null;
  lastError: string | null;
  lastErrLine: string | null;
  backoffMs: number;
  restartTimer: ReturnType<typeof setTimeout> | null;
  metricsPort: number | null;
  generation: number;
  restarts: number;
  logBytes: number | null;
}

const state: State = {
  desired: false,
  proc: null,
  token: null,
  bin: null,
  startedAt: null,
  lastError: null,
  lastErrLine: null,
  backoffMs: INITIAL_BACKOFF_MS,
  restartTimer: null,
  metricsPort: null,
  generation: 0,
  restarts: 0,
  logBytes: null,
};

let versionCache: { bin: string; version: string | null; at: number } | null = null;

export function cloudflaredBinary(): string | null {
  const configured = readEnv("CLOUDFLARED_BIN");
  if (configured) return existsSync(configured) ? configured : null;
  return Bun.which("cloudflared", { PATH: process.env.PATH ?? "" });
}

export async function cloudflaredVersion(bin: string): Promise<string | null> {
  if (versionCache && versionCache.bin === bin && Date.now() - versionCache.at < VERSION_TTL_MS) {
    return versionCache.version;
  }
  let version: string | null = null;
  try {
    const proc = Bun.spawn([bin, "--version"], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const timer = setTimeout(() => proc.kill("SIGKILL"), 5_000);
    const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    clearTimeout(timer);
    await proc.exited;
    const match = /version\s+(\S+)/i.exec(`${out}\n${err}`);
    version = match ? match[1]! : null;
  } catch {
    version = null;
  }
  versionCache = { bin, version, at: Date.now() };
  return version;
}

function isTunnelToken(s: string): boolean {
  if (s.length < 40 || s.length > 4096 || !/^[A-Za-z0-9+/=_-]+$/.test(s)) return false;
  try {
    const decoded = JSON.parse(atob(s.replace(/-/g, "+").replace(/_/g, "/"))) as Record<string, unknown>;
    return typeof decoded.a === "string" && typeof decoded.t === "string" && typeof decoded.s === "string";
  } catch {
    return false;
  }
}

export function extractTunnelToken(input: string): string | null {
  const words = input.trim().split(/\s+/).reverse();
  for (const word of words) {
    const cleaned = word.replace(/^--token=/, "").replace(/^["']+|["']+$/g, "");
    if (isTunnelToken(cleaned)) return cleaned;
  }
  return null;
}

function logPath(): string {
  return join(env.logsDir, "cloudflared.log");
}

function pidPath(): string {
  return join(env.logsDir, "cloudflared.pid");
}

function redact(line: string): string {
  return state.token ? line.split(state.token).join("[redacted]") : line;
}

function writeLog(text: string): void {
  try {
    mkdirSync(env.logsDir, { recursive: true, mode: 0o700 });
    const path = logPath();
    if (state.logBytes === null) state.logBytes = existsSync(path) ? statSync(path).size : 0;
    if (state.logBytes > LOG_MAX_BYTES) {
      renameSync(path, `${path}.1`);
      state.logBytes = 0;
    }
    appendFileSync(path, text, { mode: 0o600 });
    state.logBytes += Buffer.byteLength(text);
  } catch (err) {
    console.error("[cloudflared] could not write log:", err instanceof Error ? err.message : String(err));
  }
}

function note(message: string): void {
  writeLog(`${new Date().toISOString()} [lambdata] ${message}\n`);
}

function inspectLine(line: string): void {
  if (/\bERR\b/.test(line)) {
    const trimmed = line.replace(/^\S+\s+ERR\s+/, "").trim();
    state.lastErrLine = trimmed.slice(0, ERROR_MAX_CHARS);
    state.lastError = state.lastErrLine;
  } else if (/Registered tunnel connection/i.test(line)) {
    state.lastErrLine = null;
    state.lastError = null;
  }
}

async function pump(stream: ReadableStream<Uint8Array>, gen: number): Promise<void> {
  const decoder = new TextDecoder();
  const reader = stream.getReader();
  let pending = "";
  try {
    for (;;) {
      const { value: chunk, done } = await reader.read();
      if (done) break;
      pending += decoder.decode(chunk, { stream: true });
      const lines = pending.split("\n");
      pending = lines.pop() ?? "";
      if (lines.length === 0) continue;
      const safe = lines.map(redact);
      writeLog(`${safe.join("\n")}\n`);
      if (gen === state.generation) safe.forEach(inspectLine);
    }
  } catch {
    return;
  }
  if (pending) {
    const safe = redact(pending);
    writeLog(`${safe}\n`);
    if (gen === state.generation) inspectLine(safe);
  }
}

function freePort(): number {
  const listener = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const port = listener.port;
  listener.stop(true);
  return port;
}

function childEnv(token: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined || ENV_BLOCKED.has(key)) continue;
    if (ENV_PASSTHROUGH.has(key) || key.startsWith("TUNNEL_")) out[key] = value;
  }
  out.TUNNEL_TOKEN = token;
  return out;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function killOrphan(): Promise<void> {
  const path = pidPath();
  if (!existsSync(path)) return;
  const pid = Number(readFileSync(path, "utf8").trim());
  rmSync(path, { force: true });
  if (!Number.isInteger(pid) || pid <= 1 || pid === process.pid || !alive(pid)) return;
  const command = processCommand(pid);
  if (!command || !command.includes("cloudflared") || !command.includes("tunnel")) return;
  note(`stopping a cloudflared left over from a previous run (pid ${pid})`);
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    return;
  }
  const deadline = Date.now() + STOP_GRACE_MS;
  while (alive(pid) && Date.now() < deadline) await Bun.sleep(100);
  if (alive(pid)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      return;
    }
  }
}

function writePid(pid: number): void {
  try {
    mkdirSync(env.logsDir, { recursive: true, mode: 0o700 });
    writeFileSync(pidPath(), String(pid), { mode: 0o600 });
  } catch {
    return;
  }
}

function clearRestartTimer(): void {
  if (state.restartTimer) clearTimeout(state.restartTimer);
  state.restartTimer = null;
}

function spawnOnce(): void {
  const bin = state.bin;
  const token = state.token;
  if (!bin || !token) return;
  const port = freePort();
  const gen = ++state.generation;
  let proc: TunnelProcess;
  try {
    proc = Bun.spawn([bin, "tunnel", "--no-autoupdate", "--metrics", `127.0.0.1:${port}`, "run"], {
      env: childEnv(token),
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
  } catch (err) {
    state.lastError = `could not start cloudflared: ${err instanceof Error ? err.message : String(err)}`;
    note(state.lastError);
    scheduleRestart();
    return;
  }
  state.proc = proc;
  state.startedAt = Date.now();
  state.metricsPort = port;
  writePid(proc.pid);
  note(`started cloudflared (pid ${proc.pid})`);
  const drained = Promise.all([pump(proc.stdout, gen), pump(proc.stderr, gen)]);
  void proc.exited.then(async (code) => {
    await Promise.race([drained, Bun.sleep(2_000)]);
    onExit(gen, code);
  });
}

function scheduleRestart(): void {
  if (!state.desired) return;
  clearRestartTimer();
  const delay = state.backoffMs;
  state.backoffMs = Math.min(state.backoffMs * 2, MAX_BACKOFF_MS);
  note(`restarting cloudflared in ${Math.round(delay / 1000)}s`);
  state.restartTimer = setTimeout(() => {
    state.restartTimer = null;
    if (!state.desired) return;
    state.restarts += 1;
    spawnOnce();
  }, delay);
}

function onExit(gen: number, code: number): void {
  if (gen !== state.generation) return;
  const ranMs = state.startedAt ? Date.now() - state.startedAt : 0;
  state.proc = null;
  state.startedAt = null;
  state.metricsPort = null;
  rmSync(pidPath(), { force: true });
  if (!state.desired) return;
  const detail = state.lastErrLine ? `: ${state.lastErrLine}` : "";
  state.lastError = `cloudflared exited with code ${code}${detail}`.slice(0, ERROR_MAX_CHARS);
  note(state.lastError);
  if (ranMs >= STABLE_RUN_MS) state.backoffMs = INITIAL_BACKOFF_MS;
  scheduleRestart();
}

async function terminate(proc: TunnelProcess): Promise<void> {
  try {
    proc.kill("SIGTERM");
  } catch {
    return;
  }
  const exited = await Promise.race([proc.exited.then(() => true), Bun.sleep(STOP_GRACE_MS).then(() => false)]);
  if (!exited) {
    try {
      proc.kill("SIGKILL");
    } catch {
      return;
    }
    await proc.exited;
  }
}

export async function startTunnel(token: string): Promise<void> {
  const bin = cloudflaredBinary();
  if (!bin) throw new TunnelError("cloudflared is not installed on this server");
  clearRestartTimer();
  const previous = state.proc;
  state.generation += 1;
  state.proc = null;
  if (previous) await terminate(previous);
  await killOrphan();
  state.desired = true;
  state.bin = bin;
  state.token = token;
  state.backoffMs = INITIAL_BACKOFF_MS;
  state.lastError = null;
  state.lastErrLine = null;
  state.logBytes = null;
  spawnOnce();
}

export async function stopTunnel(): Promise<void> {
  const wasActive = state.desired || state.proc !== null;
  state.desired = false;
  clearRestartTimer();
  state.generation += 1;
  const proc = state.proc;
  state.proc = null;
  if (proc) await terminate(proc);
  rmSync(pidPath(), { force: true });
  if (wasActive) note("stopped cloudflared");
  state.token = null;
  state.startedAt = null;
  state.metricsPort = null;
  state.lastErrLine = null;
}

export function tunnelDesired(): boolean {
  return state.desired;
}

export function tunnelState(): {
  running: boolean;
  pid: number | null;
  startedAt: number | null;
  lastError: string | null;
  restarts: number;
  metricsPort: number | null;
} {
  return {
    running: state.proc !== null,
    pid: state.proc?.pid ?? null,
    startedAt: state.startedAt,
    lastError: state.lastError,
    restarts: state.restarts,
    metricsPort: state.metricsPort,
  };
}

export function setTunnelError(message: string | null): void {
  state.lastError = message;
}

export async function tunnelConnections(): Promise<number | null> {
  const port = state.metricsPort;
  if (!state.proc || !port) return null;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/ready`, { signal: AbortSignal.timeout(METRICS_TIMEOUT_MS) });
    const body = (await res.json()) as { readyConnections?: unknown };
    if (typeof body.readyConnections === "number") return body.readyConnections;
  } catch {
    return metricsConnections(port);
  }
  return metricsConnections(port);
}

async function metricsConnections(port: number): Promise<number | null> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/metrics`, { signal: AbortSignal.timeout(METRICS_TIMEOUT_MS) });
    if (!res.ok) return null;
    const match = /^cloudflared_tunnel_ha_connections\s+(\d+(?:\.\d+)?)/m.exec(await res.text());
    return match ? Math.round(Number(match[1])) : null;
  } catch {
    return null;
  }
}

export function cloudflaredLogPath(): string {
  return logPath();
}
