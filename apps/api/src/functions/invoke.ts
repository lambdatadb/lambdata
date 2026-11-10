import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Subprocess } from "bun";
import { HTTPException } from "hono/http-exception";
import type { AppAuthUser } from "@lambdata/shared";
import { appUserFromBearer } from "../auth/appBearer";
import { edgeFunctions, functionInvocations, functionSecrets } from "../db/queries";
import { ENV_PREFIX, readEnv } from "../env";
import { decryptSecret } from "../util/crypto";
import { newId } from "../util/id";
import { LEGACY } from "../util/legacy";
import { functionEntryPath, normalizeFunctionName } from "./service";

const FUNCTION_LOG_ID_HEADER = "x-lambdata-function-log-id";
const RUNNER_PATH = join(import.meta.dir, "runner.ts");
const MAX_STDERR_BYTES = 1024 * 1024;
const OUTPUT_GRACE_MS = 2_000;
const FALLBACK_PATH = "/usr/local/bin:/usr/bin:/bin";
const INHERITED_ENV = new Set([
  "PATH",
  "HOME",
  "TMPDIR",
  "TZ",
  "LANG",
  "LANGUAGE",
  "NODE_ENV",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "NODE_EXTRA_CA_CERTS",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "ALL_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
  "all_proxy",
]);

function positiveInt(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

const maxConcurrent = positiveInt(readEnv("FUNCTIONS_MAX_CONCURRENT"), 8);

export const functionLimits = {
  timeoutMs: 60_000,
  maxBodyBytes: 10 * 1024 * 1024,
  maxOutputBytes: 64 * 1024 * 1024,
  maxConcurrent,
  maxQueued: maxConcurrent * 4,
  queueWaitMs: 10_000,
};

type RunnerResult = {
  ok: boolean;
  status: number;
  headers: [string, string][];
  bodyBase64: string;
  logs: string[];
  error: string | null;
};

type RunOutcome = {
  exitCode: number;
  timedOut: boolean;
  outputOverflow: boolean;
  stdout: string;
  stderr: string;
};

let running = 0;
const waiting: Array<() => void> = [];
const liveProcesses = new Set<Subprocess>();

process.once("exit", () => {
  for (const proc of liveProcesses) killProcessGroup(proc);
});

export function functionLoad(): { running: number; queued: number } {
  return { running, queued: waiting.length };
}

function acquireSlot(signal: AbortSignal): Promise<boolean> {
  if (running < functionLimits.maxConcurrent && waiting.length === 0) {
    running++;
    return Promise.resolve(true);
  }
  if (waiting.length >= functionLimits.maxQueued || signal.aborted) return Promise.resolve(false);
  return new Promise((resolve) => {
    const settle = (granted: boolean) => {
      clearTimeout(timer);
      signal.removeEventListener("abort", giveUp);
      resolve(granted);
    };
    const grant = () => {
      running++;
      settle(true);
    };
    const giveUp = () => {
      const index = waiting.indexOf(grant);
      if (index >= 0) waiting.splice(index, 1);
      settle(false);
    };
    const timer = setTimeout(giveUp, functionLimits.queueWaitMs);
    signal.addEventListener("abort", giveUp, { once: true });
    waiting.push(grant);
  });
}

function releaseSlot(): void {
  running--;
  while (running < functionLimits.maxConcurrent && waiting.length > 0) waiting.shift()!();
}

function overloadedResponse(): Response {
  return Response.json(
    { error: "too many function invocations are in progress; try again shortly" },
    { status: 503, headers: { "Retry-After": "1" } },
  );
}

function bodyTooLarge(): HTTPException {
  return new HTTPException(413, {
    message: `function request body exceeds ${Math.round(functionLimits.maxBodyBytes / (1024 * 1024))} MB`,
  });
}

function statusOf(err: unknown): number {
  if (err instanceof HTTPException) return err.status;
  if (err instanceof Error && err.name === "BodyTooLargeError") return 413;
  return 500;
}

export async function invokeFunctionRequest(req: Request, mountPath: string): Promise<Response> {
  const started = performance.now();
  const url = new URL(req.url);
  const relative = url.pathname.slice(mountPath.length).replace(/^\/+/, "");
  const [rawName] = relative.split("/");
  if (!rawName) throw new HTTPException(400, { message: "missing function name in request" });

  const functionName = normalizeFunctionName(rawName);
  const entrypoint = functionEntryPath(functionName);
  if (!existsSync(entrypoint)) throw new HTTPException(404, { message: "function not found" });

  const settings = edgeFunctions.byName(functionName);
  const verifyJwt = settings?.verifyJwt ?? true;
  let appUser: AppAuthUser | null = null;
  if (verifyJwt) {
    appUser = await appUserFromBearer(req.headers.get("Authorization") ?? undefined);
  } else if (req.headers.has("Authorization")) {
    appUser = await appUserFromBearer(req.headers.get("Authorization") ?? undefined).catch(() => null);
  }

  if (Number(req.headers.get("content-length") ?? "0") > functionLimits.maxBodyBytes) throw bodyTooLarge();

  const invocationId = newId("fn_log");
  let statusCode: number | null = null;
  let requestBytes = 0;
  let responseBytes = 0;
  let error: string | null = null;
  let logs: string | null = null;
  const record = () =>
    functionInvocations.insert({
      id: invocationId,
      functionName,
      method: req.method,
      path: url.pathname,
      statusCode,
      durationMs: performance.now() - started,
      requestBytes,
      responseBytes,
      error,
      logs,
      invokedByAppUserId: appUser?.id ?? null,
    });

  if (!(await acquireSlot(req.signal))) {
    statusCode = 503;
    error = "rejected: too many function invocations in progress";
    record();
    return overloadedResponse();
  }

  try {
    const body = ["GET", "HEAD"].includes(req.method.toUpperCase())
      ? Buffer.alloc(0)
      : Buffer.from(await req.arrayBuffer());
    requestBytes = body.byteLength;
    if (body.byteLength > functionLimits.maxBodyBytes) throw bodyTooLarge();

    const payload = JSON.stringify({
      functionName,
      request: {
        url: req.url,
        method: req.method,
        headers: Array.from(req.headers.entries()),
        bodyBase64: body.byteLength ? body.toString("base64") : null,
      },
      env: await buildFunctionEnv(url, functionName, appUser),
    });
    const outcome = await runInSubprocess(entrypoint, payload);

    if (outcome.timedOut) {
      statusCode = 504;
      error = "function timed out";
      logs = limitText(outcome.stderr);
      return Response.json({ error }, { status: 504 });
    }
    if (outcome.outputOverflow) {
      statusCode = 502;
      error = `function output exceeded ${Math.round(functionLimits.maxOutputBytes / (1024 * 1024))} MB`;
      logs = limitText(outcome.stderr);
      return Response.json({ error }, { status: 502 });
    }

    const result = parseRunnerResult(outcome.stdout, outcome.exitCode, outcome.stderr);
    statusCode = result.status;
    error = result.error;
    logs = limitText([...result.logs, outcome.stderr].filter(Boolean).join("\n"));
    const responseBody = Buffer.from(result.bodyBase64, "base64");
    responseBytes = responseBody.byteLength;
    const headers = sanitizeHeaders(result.headers);
    headers.set(FUNCTION_LOG_ID_HEADER, invocationId);
    headers.set(LEGACY.functionLogIdHeader, invocationId);
    return new Response(responseBody, { status: result.status, headers });
  } catch (err) {
    statusCode ??= statusOf(err);
    error ??= err instanceof Error ? err.message : String(err);
    throw err;
  } finally {
    releaseSlot();
    record();
  }
}

export function functionProcessEnv(source: Record<string, string | undefined> = process.env): Record<string, string> {
  const vars: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue;
    if (INHERITED_ENV.has(key) || key.startsWith("LC_")) vars[key] = value;
  }
  vars.PATH ??= FALLBACK_PATH;
  return vars;
}

function killProcessGroup(proc: Subprocess): void {
  try {
    process.kill(-proc.pid, "SIGKILL");
    return;
  } catch {
    if (proc.exitCode === null && proc.signalCode === null) proc.kill("SIGKILL");
  }
}

type Capture = { done: Promise<{ bytes: Buffer; overflowed: boolean }>; cancel(): void };

function capture(stream: ReadableStream<Uint8Array>, cap: number, onOverflow?: () => void): Capture {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let overflowed = false;
  const pump = async () => {
    for (;;) {
      const { done: finished, value } = await reader.read();
      if (finished) return;
      if (overflowed) continue;
      if (size + value.byteLength > cap) {
        overflowed = true;
        chunks.push(value.subarray(0, cap - size));
        size = cap;
        onOverflow?.();
        continue;
      }
      chunks.push(value);
      size += value.byteLength;
    }
  };
  const done = pump()
    .catch(() => undefined)
    .then(() => ({ bytes: Buffer.concat(chunks), overflowed }));
  return {
    done,
    cancel() {
      reader.cancel().catch(() => undefined);
    },
  };
}

async function writeStdin(proc: Subprocess<"pipe", "pipe", "pipe">, payload: string): Promise<void> {
  try {
    proc.stdin.write(payload);
    await proc.stdin.end();
  } catch {
    return;
  }
}

async function runInSubprocess(entrypoint: string, payload: string): Promise<RunOutcome> {
  const proc = Bun.spawn([process.execPath, "--no-install", RUNNER_PATH, entrypoint], {
    cwd: dirname(entrypoint),
    env: functionProcessEnv(),
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    detached: true,
  });
  liveProcesses.add(proc);
  let timedOut = false;
  let outputOverflow = false;
  const stdout = capture(proc.stdout, functionLimits.maxOutputBytes, () => {
    outputOverflow = true;
    killProcessGroup(proc);
  });
  const stderr = capture(proc.stderr, MAX_STDERR_BYTES);
  const timer = setTimeout(() => {
    timedOut = true;
    killProcessGroup(proc);
  }, functionLimits.timeoutMs);

  let exitCode: number;
  try {
    await writeStdin(proc, payload);
    exitCode = await proc.exited;
  } finally {
    clearTimeout(timer);
    killProcessGroup(proc);
    liveProcesses.delete(proc);
  }

  const outputs = Promise.all([stdout.done, stderr.done]);
  const grace = new Promise<null>((resolve) => setTimeout(() => resolve(null), OUTPUT_GRACE_MS).unref());
  if ((await Promise.race([outputs, grace])) === null) {
    stdout.cancel();
    stderr.cancel();
  }
  const [out, err] = await outputs;
  return {
    exitCode,
    timedOut,
    outputOverflow: outputOverflow || out.overflowed,
    stdout: out.bytes.toString("utf8"),
    stderr: err.bytes.toString("utf8"),
  };
}

async function buildFunctionEnv(
  url: URL,
  functionName: string,
  appUser: AppAuthUser | null,
): Promise<Record<string, string>> {
  const secrets: Record<string, string> = {};
  for (const [name, encrypted] of Object.entries(functionSecrets.values())) {
    secrets[name] = await decryptSecret(encrypted);
  }
  const runtime: Record<string, string> = {
    API_URL: `${url.origin}/api`,
    FUNCTIONS_URL: `${url.origin}/functions/v1`,
    FUNCTION_NAME: functionName,
    APP_USER_ID: appUser?.id ?? "",
    APP_USER_EMAIL: appUser?.email ?? "",
  };
  const vars: Record<string, string> = { ...secrets };
  for (const [name, value] of Object.entries(runtime)) {
    vars[`${ENV_PREFIX}${name}`] = value;
    vars[`${LEGACY.envPrefix}${name}`] = value;
  }
  return vars;
}

function parseRunnerResult(stdout: string, exitCode: number, stderr: string): RunnerResult {
  try {
    const parsed = JSON.parse(stdout) as RunnerResult;
    if (!parsed.ok && !parsed.error) parsed.error = "function invocation failed";
    return parsed;
  } catch {
    return {
      ok: false,
      status: 500,
      headers: [["content-type", "application/json"]],
      bodyBase64: Buffer.from(JSON.stringify({ error: "function invocation failed" })).toString("base64"),
      logs: [],
      error: `runner exited ${exitCode}: ${limitText(stderr || stdout)}`,
    };
  }
}

function sanitizeHeaders(entries: [string, string][]): Headers {
  const headers = new Headers();
  const blocked = new Set(["content-length", "connection", "transfer-encoding"]);
  for (const [key, value] of entries) {
    if (!blocked.has(key.toLowerCase())) headers.append(key, value);
  }
  return headers;
}

function limitText(value: string): string {
  return value.length > 64_000 ? `${value.slice(0, 64_000)}\n[truncated]` : value;
}
