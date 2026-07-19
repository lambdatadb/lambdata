import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { HTTPException } from "hono/http-exception";
import type { AppAuthUser } from "@kilndb/shared";
import { appUserFromBearer } from "../auth/appBearer";
import { edgeFunctions, functionInvocations, functionSecrets } from "../db/queries";
import { decryptSecret } from "../util/crypto";
import { newId } from "../util/id";
import { functionEntryPath, normalizeFunctionName } from "./service";

const MAX_BODY_BYTES = 10 * 1024 * 1024;
const TIMEOUT_MS = 60_000;

type RunnerResult = {
  ok: boolean;
  status: number;
  headers: [string, string][];
  bodyBase64: string;
  logs: string[];
  error: string | null;
};

export async function invokeFunctionRequest(req: Request, mountPath: string): Promise<Response> {
  const started = performance.now();
  const url = new URL(req.url);
  const relative = url.pathname.slice(mountPath.length).replace(/^\/+/, "");
  const [rawName] = relative.split("/");
  if (!rawName) throw new HTTPException(400, { message: "missing function name in request" });

  let functionName: string;
  try {
    functionName = normalizeFunctionName(rawName);
  } catch (err) {
    throw new HTTPException(400, {
      message: err instanceof Error ? err.message : "invalid function name",
    });
  }
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

  const declaredBytes = Number(req.headers.get("content-length") ?? "0");
  if (declaredBytes > MAX_BODY_BYTES) {
    throw new HTTPException(413, { message: "function request body exceeds 10 MB" });
  }
  const body = ["GET", "HEAD"].includes(req.method.toUpperCase())
    ? Buffer.alloc(0)
    : Buffer.from(await req.arrayBuffer());
  if (body.byteLength > MAX_BODY_BYTES) {
    throw new HTTPException(413, { message: "function request body exceeds 10 MB" });
  }

  const inputDir = await mkdtemp(join(tmpdir(), "kilndb-function-"));
  const inputPath = join(inputDir, "request.json");
  const invocationId = newId("fn_log");
  const runnerPath = join(import.meta.dir, "runner.ts");
  let statusCode: number | null = null;
  let responseBytes = 0;
  let error: string | null = null;
  let logs: string | null = null;

  try {
    await writeFile(
      inputPath,
      JSON.stringify({
        functionName,
        request: {
          url: req.url,
          method: req.method,
          headers: Array.from(req.headers.entries()),
          bodyBase64: body.byteLength ? body.toString("base64") : null,
        },
        env: await buildFunctionEnv(url, functionName, appUser),
      }),
      { mode: 0o600 },
    );

    const proc = Bun.spawn([process.execPath, runnerPath, entrypoint, inputPath], {
      stdout: "pipe",
      stderr: "pipe",
    });
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      proc.kill();
    }, TIMEOUT_MS);
    const exitCode = await proc.exited.finally(() => clearTimeout(timeout));
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);

    if (timedOut) {
      statusCode = 504;
      error = "function timed out";
      logs = limitText(stderr);
      return Response.json({ error }, { status: 504 });
    }

    const result = parseRunnerResult(stdout, exitCode, stderr);
    statusCode = result.status;
    error = result.error;
    logs = limitText([...result.logs, stderr].filter(Boolean).join("\n"));
    const responseBody = Buffer.from(result.bodyBase64, "base64");
    responseBytes = responseBody.byteLength;
    const headers = sanitizeHeaders(result.headers);
    headers.set("x-kilndb-function-log-id", invocationId);
    return new Response(responseBody, { status: result.status, headers });
  } finally {
    functionInvocations.insert({
      id: invocationId,
      functionName,
      method: req.method,
      path: url.pathname,
      statusCode,
      durationMs: performance.now() - started,
      requestBytes: body.byteLength,
      responseBytes,
      error,
      logs,
      invokedByAppUserId: appUser?.id ?? null,
    });
    await rm(inputDir, { recursive: true, force: true }).catch(() => undefined);
  }
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
  return {
    ...secrets,
    KILNDB_API_URL: `${url.origin}/api`,
    KILNDB_FUNCTIONS_URL: `${url.origin}/functions/v1`,
    KILNDB_FUNCTION_NAME: functionName,
    KILNDB_APP_USER_ID: appUser?.id ?? "",
    KILNDB_APP_USER_EMAIL: appUser?.email ?? "",
  };
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
