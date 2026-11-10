import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { HTTPException } from "hono/http-exception";
import type { EdgeFunction } from "@lambdata/shared";
import { edgeFunctions, functionInvocations } from "../db/queries";
import { env } from "../env";

export const MAX_SOURCE_CHARS = 512_000;
const FUNCTION_NAME = /^[a-z0-9](?:[a-z0-9_-]{0,61}[a-z0-9])?$/;

export function normalizeFunctionName(input: string): string {
  const name = input.trim().toLowerCase();
  if (name.length < 1 || name.length > 63 || !FUNCTION_NAME.test(name)) {
    throw new HTTPException(400, {
      message: "function names must be 1-63 lowercase letters, numbers, underscores, or hyphens",
    });
  }
  return name;
}

export function normalizeSecretName(input: string): string {
  const name = input.trim().toUpperCase();
  if (!/^[A-Z][A-Z0-9_]{1,63}$/.test(name)) {
    throw new HTTPException(400, { message: "secret names must be 2-64 uppercase letters, numbers, or underscores" });
  }
  if (name.startsWith("SUPABASE_")) {
    throw new HTTPException(400, { message: "SUPABASE_ is reserved for compatibility variables" });
  }
  return name;
}

export function functionDir(name: string): string {
  return join(env.functionsDir, normalizeFunctionName(name));
}

export function functionEntryPath(name: string): string {
  return join(functionDir(name), "index.ts");
}

export async function listFunctionDefinitions(): Promise<EdgeFunction[]> {
  await mkdir(env.functionsDir, { recursive: true, mode: 0o700 });
  const settingsByName = new Map(edgeFunctions.listSettings().map((s) => [s.name, s]));
  const entries = await readdir(env.functionsDir, { withFileTypes: true }).catch(() => []);
  const names = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => FUNCTION_NAME.test(name))
    .sort((a, b) => a.localeCompare(b));

  const definitions: EdgeFunction[] = [];
  for (const name of names) {
    const entrypoint = functionEntryPath(name);
    if (!existsSync(entrypoint)) continue;
    const sourceStat = await stat(entrypoint);
    const setting = settingsByName.get(name);
    const stats = functionInvocations.stats(name);
    definitions.push({
      name,
      verifyJwt: setting?.verifyJwt ?? true,
      entrypoint,
      sourceSizeBytes: sourceStat.size,
      sourceUpdatedAt: sourceStat.mtimeMs,
      createdAt: setting?.createdAt ?? null,
      updatedAt: setting?.updatedAt ?? null,
      ...stats,
    });
  }
  return definitions;
}

export async function createFunction(input: {
  name: string;
  verifyJwt: boolean;
  createdByUserId: string | null;
}): Promise<EdgeFunction> {
  const name = normalizeFunctionName(input.name);
  const entrypoint = functionEntryPath(name);
  if (existsSync(entrypoint)) throw new HTTPException(409, { message: "function already exists" });
  await mkdir(functionDir(name), { recursive: true, mode: 0o700 });
  await writeFile(entrypoint, starterSource(name), { mode: 0o600 });
  edgeFunctions.upsert({
    name,
    verifyJwt: input.verifyJwt,
    createdByUserId: input.createdByUserId,
  });
  return getFunctionDefinition(name);
}

export async function getFunctionDefinition(name: string): Promise<EdgeFunction> {
  const normalized = normalizeFunctionName(name);
  const definitions = await listFunctionDefinitions();
  const definition = definitions.find((fn) => fn.name === normalized);
  if (!definition) throw new HTTPException(404, { message: "function not found" });
  return definition;
}

export async function readFunctionSource(name: string): Promise<string> {
  const entrypoint = functionEntryPath(name);
  if (!existsSync(entrypoint)) throw new HTTPException(404, { message: "function not found" });
  return readFile(entrypoint, "utf8");
}

export async function writeFunctionSource(name: string, source: string): Promise<EdgeFunction> {
  if (source.length > MAX_SOURCE_CHARS) throw new HTTPException(400, { message: "function source exceeds 512 KB" });
  const normalized = normalizeFunctionName(name);
  const entrypoint = functionEntryPath(normalized);
  if (!existsSync(entrypoint)) throw new HTTPException(404, { message: "function not found" });
  await writeFile(entrypoint, source, { mode: 0o600 });
  const setting = edgeFunctions.byName(normalized);
  edgeFunctions.upsert({
    name: normalized,
    verifyJwt: setting?.verifyJwt ?? true,
    createdByUserId: setting?.createdByUserId ?? null,
  });
  return getFunctionDefinition(normalized);
}

export async function deleteFunction(name: string): Promise<void> {
  const normalized = normalizeFunctionName(name);
  await rm(functionDir(normalized), { recursive: true, force: true });
  edgeFunctions.delete(normalized);
  functionInvocations.deleteForFunction(normalized);
}

function starterSource(name: string): string {
  return `export default async function handler(req, ctx) {
  const url = new URL(req.url);
  console.log("invoked", ctx.functionName, req.method, url.pathname);

  return Response.json({
    ok: true,
    function: "${name}",
    method: req.method,
    path: url.pathname,
    appUserId: ctx.env.LAMBDATA_APP_USER_ID ?? null,
    time: new Date().toISOString(),
  });
}
`;
}
