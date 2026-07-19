type InvokePayload = {
  functionName: string;
  request: {
    url: string;
    method: string;
    headers: [string, string][];
    bodyBase64: string | null;
  };
  env: Record<string, string>;
};

type InvokeResult = {
  ok: boolean;
  status: number;
  headers: [string, string][];
  bodyBase64: string;
  logs: string[];
  error: string | null;
};

const entrypoint = Bun.argv[2];
const inputPath = Bun.argv[3];
const logs: string[] = [];

for (const level of ["log", "info", "warn", "error"] as const) {
  console[level] = (...args: unknown[]) => {
    logs.push(`[${level}] ${args.map(formatLogValue).join(" ")}`);
  };
}

try {
  if (!entrypoint || !inputPath) throw new Error("runner requires entrypoint and payload path");
  const payload = await Bun.file(inputPath).json() as InvokePayload;
  for (const [key, value] of Object.entries(payload.env)) {
    process.env[key] = value;
  }

  const mod = await import(`${pathToFileURL(entrypoint).href}?t=${Date.now()}`);
  const handler = mod.default ?? mod.handler;
  if (typeof handler !== "function") {
    throw new Error("function must export default or named handler");
  }

  const body = payload.request.bodyBase64
    ? Buffer.from(payload.request.bodyBase64, "base64")
    : undefined;
  const request = new Request(payload.request.url, {
    method: payload.request.method,
    headers: new Headers(payload.request.headers),
    body: ["GET", "HEAD"].includes(payload.request.method.toUpperCase()) ? undefined : body,
  });

  const response = await toResponse(
    await handler(request, {
      env: payload.env,
      functionName: payload.functionName,
    }),
  );
  const responseBody = Buffer.from(await response.arrayBuffer()).toString("base64");
  writeResult({
    ok: true,
    status: response.status,
    headers: Array.from(response.headers.entries()),
    bodyBase64: responseBody,
    logs,
    error: null,
  });
} catch (err) {
  writeResult({
    ok: false,
    status: 500,
    headers: [["content-type", "application/json"]],
    bodyBase64: Buffer.from(JSON.stringify({ error: "function invocation failed" })).toString("base64"),
    logs,
    error: err instanceof Error ? err.message : String(err),
  });
}

function writeResult(result: InvokeResult): void {
  process.stdout.write(JSON.stringify(result));
}

function formatLogValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (value instanceof Error) return value.stack ?? value.message;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

async function toResponse(value: unknown): Promise<Response> {
  if (value instanceof Response) return value;
  if (value === undefined || value === null) {
    return new Response(null, { status: 204 });
  }
  if (typeof value === "string" || value instanceof Blob || value instanceof ArrayBuffer) {
    return new Response(value);
  }
  return Response.json(value);
}
import { pathToFileURL } from "node:url";
