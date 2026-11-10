import { Hono, type MiddlewareHandler } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { requireAuth, requireRole, type AuthVariables } from "../auth/middleware";
import { audit, edgeFunctions, functionInvocations, functionSecrets } from "../db/queries";
import { encryptSecret } from "../util/crypto";
import { parseJson, parseQuery } from "../util/validate";
import {
  MAX_SOURCE_CHARS,
  createFunction,
  deleteFunction,
  getFunctionDefinition,
  listFunctionDefinitions,
  normalizeFunctionName,
  normalizeSecretName,
  readFunctionSource,
  writeFunctionSource,
} from "../functions/service";

export const functionsRoute = new Hono<{ Variables: AuthVariables }>();

const createSchema = z.object({
  name: z.string().trim().min(1, "name required").max(63),
  verifyJwt: z.boolean().optional(),
});

const patchSchema = z.object({ verifyJwt: z.boolean().optional() });

const sourceSchema = z.object({
  source: z.string({ error: "source required" }).max(MAX_SOURCE_CHARS, "function source exceeds 512 KB"),
});

const secretSchema = z.object({
  name: z.string().trim().min(1, "name required"),
  value: z.string().min(1, "secret value required").max(65_536),
});

const logsQuery = z.object({
  limit: z.coerce.number().int().catch(50).optional(),
});

const adminOnly = requireRole("admin");

function adminOnlyRead(message: string): MiddlewareHandler<{ Variables: AuthVariables }> {
  return async (c, next) => {
    if (c.get("user").role !== "admin") throw new HTTPException(403, { message });
    await next();
  };
}

functionsRoute.use("*", requireAuth);

functionsRoute.get("/", async (c) => {
  return c.json({ functions: await listFunctionDefinitions() });
});

functionsRoute.post("/", adminOnly, async (c) => {
  const user = c.get("user");
  const body = await parseJson(c, createSchema);
  const fn = await createFunction({
    name: body.name,
    verifyJwt: body.verifyJwt !== false,
    createdByUserId: user.id,
  });
  audit.log(user.id, "function.create", fn.name, { verifyJwt: fn.verifyJwt });
  return c.json({ function: fn });
});

functionsRoute.get("/secrets", adminOnly, (c) => {
  return c.json({ secrets: functionSecrets.list() });
});

functionsRoute.post("/secrets", adminOnly, async (c) => {
  const user = c.get("user");
  const body = await parseJson(c, secretSchema);
  const name = normalizeSecretName(body.name);
  functionSecrets.upsert({ name, valueEnc: await encryptSecret(body.value) });
  audit.log(user.id, "function.secret.upsert", name, {});
  return c.json({ secret: functionSecrets.list().find((s) => s.name === name) });
});

functionsRoute.delete("/secrets/:name", adminOnly, (c) => {
  const user = c.get("user");
  const name = normalizeSecretName(c.req.param("name"));
  functionSecrets.delete(name);
  audit.log(user.id, "function.secret.delete", name, {});
  return c.json({ ok: true });
});

functionsRoute.get("/:name", async (c) => {
  return c.json({ function: await getFunctionDefinition(c.req.param("name")) });
});

functionsRoute.patch("/:name", adminOnly, async (c) => {
  const user = c.get("user");
  const name = normalizeFunctionName(c.req.param("name"));
  const existing = await getFunctionDefinition(name);
  const body = await parseJson(c, patchSchema);
  if (body.verifyJwt !== undefined) {
    edgeFunctions.upsert({ name, verifyJwt: body.verifyJwt, createdByUserId: user.id });
  }
  const fn = await getFunctionDefinition(name);
  audit.log(user.id, "function.update", name, {
    verifyJwt: body.verifyJwt,
    previousVerifyJwt: existing.verifyJwt,
  });
  return c.json({ function: fn });
});

functionsRoute.delete("/:name", adminOnly, async (c) => {
  const user = c.get("user");
  const name = normalizeFunctionName(c.req.param("name"));
  await deleteFunction(name);
  audit.log(user.id, "function.delete", name, {});
  return c.json({ ok: true });
});

functionsRoute.get("/:name/source", adminOnlyRead("Only admins can read a function's source, because it often holds keys and other secrets."), async (c) => {
  const name = normalizeFunctionName(c.req.param("name"));
  return c.json({ source: await readFunctionSource(name) });
});

functionsRoute.put("/:name/source", adminOnly, async (c) => {
  const user = c.get("user");
  const name = normalizeFunctionName(c.req.param("name"));
  const { source } = await parseJson(c, sourceSchema);
  const fn = await writeFunctionSource(name, source);
  audit.log(user.id, "function.source.update", name, { bytes: source.length });
  return c.json({ function: fn });
});

functionsRoute.get("/:name/logs", adminOnlyRead("Only admins can read a function's invocation logs, because they often hold keys and other secrets."), (c) => {
  const name = normalizeFunctionName(c.req.param("name"));
  const { limit } = parseQuery(c, logsQuery);
  return c.json({ invocations: functionInvocations.list(name, Math.min(200, Math.max(1, limit || 50))) });
});
