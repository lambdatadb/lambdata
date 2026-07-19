import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { requireAuth, requireRole, type AuthVariables } from "../auth/middleware";
import { audit, edgeFunctions, functionInvocations, functionSecrets } from "../db/queries";
import { encryptSecret } from "../util/crypto";
import {
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

functionsRoute.use("*", requireAuth);

functionsRoute.get("/", async (c) => {
  return c.json({ functions: await listFunctionDefinitions() });
});

functionsRoute.post("/", async (c) => {
  const user = c.get("user");
  if (user.role === "viewer") throw new HTTPException(403, { message: "read-only role" });
  const body = (await c.req.json()) as { name?: string; verifyJwt?: boolean };
  const fn = await fromUserInputAsync(() =>
    createFunction({
      name: body.name ?? "",
      verifyJwt: body.verifyJwt !== false,
      createdByUserId: user.id,
    }),
  );
  audit.log(user.id, "function.create", fn.name, { verifyJwt: fn.verifyJwt });
  return c.json({ function: fn });
});

functionsRoute.get("/secrets", requireRole("admin"), (c) => {
  return c.json({ secrets: functionSecrets.list() });
});

functionsRoute.post("/secrets", requireRole("admin"), async (c) => {
  const user = c.get("user");
  const body = (await c.req.json()) as { name?: string; value?: string };
  const name = fromUserInput(() => normalizeSecretName(body.name ?? ""));
  if (!body.value) throw new HTTPException(400, { message: "secret value required" });
  functionSecrets.upsert({ name, valueEnc: await encryptSecret(body.value) });
  audit.log(user.id, "function.secret.upsert", name, {});
  return c.json({ secret: functionSecrets.list().find((s) => s.name === name) });
});

functionsRoute.delete("/secrets/:name", requireRole("admin"), (c) => {
  const user = c.get("user");
  const name = fromUserInput(() => normalizeSecretName(c.req.param("name")));
  functionSecrets.delete(name);
  audit.log(user.id, "function.secret.delete", name, {});
  return c.json({ ok: true });
});

functionsRoute.get("/:name", async (c) => {
  const fn = await fromUserInputAsync(() => getFunctionDefinition(c.req.param("name")));
  return c.json({ function: fn });
});

functionsRoute.patch("/:name", async (c) => {
  const user = c.get("user");
  if (user.role === "viewer") throw new HTTPException(403, { message: "read-only role" });
  const name = fromUserInput(() => normalizeFunctionName(c.req.param("name")));
  const existing = await fromUserInputAsync(() => getFunctionDefinition(name));
  const body = (await c.req.json()) as { verifyJwt?: boolean };
  if (body.verifyJwt !== undefined) {
    edgeFunctions.upsert({ name, verifyJwt: !!body.verifyJwt, createdByUserId: user.id });
  }
  const fn = await getFunctionDefinition(name);
  audit.log(user.id, "function.update", name, {
    verifyJwt: body.verifyJwt,
    previousVerifyJwt: existing.verifyJwt,
  });
  return c.json({ function: fn });
});

functionsRoute.delete("/:name", async (c) => {
  const user = c.get("user");
  if (user.role === "viewer") throw new HTTPException(403, { message: "read-only role" });
  const name = fromUserInput(() => normalizeFunctionName(c.req.param("name")));
  await deleteFunction(name);
  audit.log(user.id, "function.delete", name, {});
  return c.json({ ok: true });
});

functionsRoute.get("/:name/source", async (c) => {
  const name = fromUserInput(() => normalizeFunctionName(c.req.param("name")));
  await fromUserInputAsync(() => getFunctionDefinition(name));
  return c.json({ source: await readFunctionSource(name) });
});

functionsRoute.put("/:name/source", async (c) => {
  const user = c.get("user");
  if (user.role === "viewer") throw new HTTPException(403, { message: "read-only role" });
  const name = fromUserInput(() => normalizeFunctionName(c.req.param("name")));
  const body = (await c.req.json()) as { source?: string };
  if (typeof body.source !== "string") {
    throw new HTTPException(400, { message: "source required" });
  }
  const fn = await fromUserInputAsync(() => writeFunctionSource(name, body.source!));
  audit.log(user.id, "function.source.update", name, { bytes: body.source.length });
  return c.json({ function: fn });
});

functionsRoute.get("/:name/logs", (c) => {
  const name = fromUserInput(() => normalizeFunctionName(c.req.param("name")));
  const limit = Math.min(200, Math.max(1, Number(c.req.query("limit") ?? "50") || 50));
  return c.json({ invocations: functionInvocations.list(name, limit) });
});

function fromUserInput<T>(fn: () => T): T {
  try {
    return fn();
  } catch (err) {
    throw inputException(err);
  }
}

async function fromUserInputAsync<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    throw inputException(err);
  }
}

function inputException(err: unknown): HTTPException {
  const message = err instanceof Error ? err.message : String(err);
  const status = message.includes("not found") ? 404 : message.includes("already exists") ? 409 : 400;
  return new HTTPException(status, { message });
}
