import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { env } from "../env";
import { getMariaDbBinariesSync, getRootPassword, localConnectHost } from "./controller";

export interface Target {
  host: string;
  port: number;
  user: string;
  password: string;
}

export interface ProcessOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface DumpOptions extends ProcessOptions {
  tables?: string[];
}

export interface LoadOptions extends ProcessOptions {
  args?: string[];
}

export interface DumpHandle {
  stdout: ReadableStream<Uint8Array>;
  done: Promise<void>;
}

export class MariaDbToolError extends Error {
  readonly tool: string;
  readonly exitCode: number | null;
  readonly stderr: string;
  readonly timedOut: boolean;
  readonly aborted: boolean;

  constructor(
    message: string,
    p: { tool: string; exitCode: number | null; stderr: string; timedOut?: boolean; aborted?: boolean },
  ) {
    super(message);
    this.name = "MariaDbToolError";
    this.tool = p.tool;
    this.exitCode = p.exitCode;
    this.stderr = p.stderr;
    this.timedOut = p.timedOut ?? false;
    this.aborted = p.aborted ?? false;
  }
}

const STDERR_LIMIT = 16 * 1024;
const KILL_GRACE_MS = 2000;
const CHILD_ENV_KEYS = ["PATH", "LANG", "LC_ALL", "LC_CTYPE", "TZ", "TMPDIR"];
const RESERVED_OPTIONS = new Set([
  "defaults-file",
  "defaults-extra-file",
  "defaults-group-suffix",
  "no-defaults",
  "print-defaults",
  "host",
  "port",
  "user",
  "password",
  "socket",
  "protocol",
  "pipe",
  "shared-memory-base-name",
  "plugin-dir",
  "default-auth",
  "database",
  "binary-mode",
  "local-infile",
  "execute",
  "init-command",
  "pager",
  "tee",
  "script-dir",
  "html",
  "xml",
]);

export const MAX_ALLOWED_PACKET = "1G";
const CLIENT_FORCED_ARGS = ["--binary-mode", "--local-infile=0", "--comments", `--max-allowed-packet=${MAX_ALLOWED_PACKET}`];
const DUMP_FORCED_ARGS = [`--max-allowed-packet=${MAX_ALLOWED_PACKET}`];

const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

export async function localAdminTarget(): Promise<Target> {
  return {
    host: localConnectHost(),
    port: env.mariadbPort,
    user: env.rootUser,
    password: await getRootPassword(),
  };
}

export function dumpStream(
  target: Target,
  schema: string,
  args: string[],
  opts: DumpOptions = {},
): DumpHandle {
  const names = [schema, ...(opts.tables ?? [])];
  for (const n of names) assertObjectName(n);
  const { proc, done } = spawnTool({
    tool: "dump",
    target,
    argv: [...DUMP_FORCED_ARGS, ...checkArgs(args), "--", ...names],
    stdin: "ignore",
    stdout: "pipe",
    opts,
  });
  return { stdout: proc.stdout as ReadableStream<Uint8Array>, done };
}

export function loadStream(
  target: Target,
  schema: string,
  input: ReadableStream<Uint8Array>,
  opts: LoadOptions = {},
): Promise<void> {
  assertObjectName(schema);
  return runClient(target, schema, input, opts);
}

export function runSql(
  target: Target,
  schema: string | null,
  sql: string,
  opts: LoadOptions = {},
): Promise<void> {
  if (schema !== null) assertObjectName(schema);
  return runClient(target, schema, new Blob([sql]), opts);
}

function runClient(
  target: Target,
  schema: string | null,
  input: ReadableStream<Uint8Array> | Blob,
  opts: LoadOptions,
): Promise<void> {
  try {
    const extra = (opts.args ?? []).filter((a) => !CLIENT_FORCED_ARGS.includes(a));
    const argv = [
      ...CLIENT_FORCED_ARGS,
      "--batch",
      ...(schema === null ? [] : [`--database=${schema}`]),
      ...checkArgs(extra),
    ];
    return spawnTool({ tool: "client", target, argv, stdin: input, stdout: "ignore", opts }).done;
  } catch (err) {
    return Promise.reject(err);
  }
}

function assertObjectName(name: string): void {
  if (!name || name.length > 64) throw new Error("invalid database or table name");
  if (CONTROL_CHARS.test(name)) {
    throw new Error(`the name ${JSON.stringify(name)} contains a control character, which MariaDB tools cannot be given safely`);
  }
}

function checkArgs(args: string[]): string[] {
  for (const a of args) {
    const m = /^--([a-z][a-z0-9_-]*)(=[\s\S]*)?$/i.exec(a);
    if (!m || CONTROL_CHARS.test(a)) throw new Error(`invalid MariaDB tool argument: ${a.slice(0, 40)}`);
    const name = m[1]!.toLowerCase().replaceAll("_", "-");
    if (RESERVED_OPTIONS.has(name) || name.startsWith("ssl") || name.startsWith("skip-ssl")) {
      throw new Error(`MariaDB tool argument --${name} is managed by the process helper`);
    }
  }
  return args;
}

function optionValue(value: string, field: string): string {
  if (value.includes("\u0000")) throw new Error(`invalid ${field}`);
  const escaped = value
    .replaceAll("\\", "\\\\")
    .replaceAll('"', '\\"')
    .replaceAll("\n", "\\n")
    .replaceAll("\r", "\\r")
    .replaceAll("\t", "\\t");
  return `"${escaped}"`;
}

function optionFile(t: Target): string {
  if (!t.host || CONTROL_CHARS.test(t.host) || /\s/.test(t.host)) throw new Error("invalid host");
  if (!t.user || CONTROL_CHARS.test(t.user)) throw new Error("invalid user");
  if (!Number.isInteger(t.port) || t.port < 1 || t.port > 65535) throw new Error("invalid port");
  return [
    "[client]",
    `host=${optionValue(t.host, "host")}`,
    `port=${t.port}`,
    `user=${optionValue(t.user, "user")}`,
    `password=${optionValue(t.password, "password")}`,
    "protocol=TCP",
    "skip-ssl",
    "default-character-set=utf8mb4",
    "",
  ].join("\n");
}

function childEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of CHILD_ENV_KEYS) {
    const v = process.env[key];
    if (v) out[key] = v;
  }
  return out;
}

async function collectTail(stream: ReadableStream<Uint8Array>): Promise<string> {
  const decoder = new TextDecoder();
  let buf = "";
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    if (buf.length > STDERR_LIMIT * 2) buf = buf.slice(-STDERR_LIMIT);
  }
  buf += decoder.decode();
  return buf.slice(-STDERR_LIMIT);
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function sanitizeToolOutput(text: string, secrets: string[]): string {
  let out = text;
  for (const s of secrets) {
    if (s && s.length >= 3) out = out.replace(new RegExp(escapeRegExp(s), "g"), "***");
  }
  return out.replace(/(password\s*[=:]\s*)\S+/gi, "$1***");
}

function summarize(stderr: string): string {
  const lines = stderr
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const errors = lines.filter((l) => /error/i.test(l));
  const picked = (errors.length > 0 ? errors : lines).slice(-3).join(" | ");
  return picked.length > 1000 ? `${picked.slice(0, 1000)}...` : picked;
}

function spawnTool(p: {
  tool: "dump" | "client";
  target: Target;
  argv: string[];
  stdin: ReadableStream<Uint8Array> | Blob | "ignore";
  stdout: "pipe" | "ignore";
  opts: ProcessOptions;
}): { proc: ReturnType<typeof Bun.spawn>; done: Promise<void> } {
  const label = p.tool === "dump" ? "mariadb-dump" : "mariadb";
  const signal = p.opts.signal;
  if (signal?.aborted) {
    throw new MariaDbToolError(`${label} was cancelled`, { tool: label, exitCode: null, stderr: "", aborted: true });
  }
  const binaries = getMariaDbBinariesSync();
  const bin = p.tool === "dump" ? binaries.dump : binaries.client;
  const contents = optionFile(p.target);
  const dir = mkdtempSync(join(tmpdir(), "ld-cnf-"));
  const cnf = join(dir, "client.cnf");
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    writeFileSync(cnf, contents, { mode: 0o600, flag: "wx" });
    proc = Bun.spawn([bin, `--defaults-extra-file=${cnf}`, ...p.argv], {
      stdin: p.stdin,
      stdout: p.stdout,
      stderr: "pipe",
      env: childEnv(),
    });
  } catch (err) {
    rmSync(dir, { recursive: true, force: true });
    throw err;
  }

  let timedOut = false;
  let aborted = false;
  let killTimer: ReturnType<typeof setTimeout> | null = null;
  const terminate = (): void => {
    if (proc.exitCode !== null || proc.signalCode !== null) return;
    proc.kill("SIGTERM");
    killTimer = setTimeout(() => {
      if (proc.exitCode === null && proc.signalCode === null) proc.kill("SIGKILL");
    }, KILL_GRACE_MS);
  };
  const timer =
    p.opts.timeoutMs !== undefined
      ? setTimeout(() => {
          timedOut = true;
          terminate();
        }, p.opts.timeoutMs)
      : null;
  const onAbort = (): void => {
    aborted = true;
    terminate();
  };
  signal?.addEventListener("abort", onAbort, { once: true });
  const stderrTail = collectTail(proc.stderr as ReadableStream<Uint8Array>).catch(() => "");

  const done = (async () => {
    try {
      const exitCode = await proc.exited;
      const stderr = sanitizeToolOutput(await stderrTail, [p.target.password]);
      if (timedOut) {
        throw new MariaDbToolError(
          `${label} timed out after ${Math.round((p.opts.timeoutMs ?? 0) / 100) / 10}s and was stopped`,
          { tool: label, exitCode, stderr, timedOut: true },
        );
      }
      if (aborted) {
        throw new MariaDbToolError(`${label} was cancelled`, { tool: label, exitCode, stderr, aborted: true });
      }
      if (exitCode !== 0) {
        const summary = summarize(stderr);
        throw new MariaDbToolError(`${label} failed (exit ${exitCode})${summary ? `: ${summary}` : ""}`, {
          tool: label,
          exitCode,
          stderr,
        });
      }
    } finally {
      if (timer) clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      signal?.removeEventListener("abort", onAbort);
      rmSync(dir, { recursive: true, force: true });
    }
  })();
  done.catch(() => {});
  return { proc, done };
}
