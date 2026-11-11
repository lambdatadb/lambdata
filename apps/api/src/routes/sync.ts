import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { audit, databases, syncJobs } from "../db/queries";
import { requireAuth, requireDbAccess, type AuthVariables } from "../auth/middleware";
import { encryptSecret } from "../util/crypto";
import { newId } from "../util/id";
import { parseJson } from "../util/validate";
import { jobAcceptedResponse } from "../jobs";
import { startSyncJob, syncSourceProblem } from "../workers/sync";

export const syncRoute = new Hono<{ Variables: AuthVariables }>();

syncRoute.use("*", requireAuth);

const upsertBody = z.object({
  sourceKind: z.enum(["mysql", "postgres"]),
  sourceHost: z.string().trim().min(1).max(255),
  sourcePort: z.coerce.number().int().min(1).max(65535),
  sourceUser: z.string().min(1).max(128),
  sourcePassword: z.string().max(1024).optional(),
  sourceDatabase: z.string().min(1).max(64),
  intervalSeconds: z.coerce.number().int().min(1).max(31_536_000).optional(),
  enabled: z.boolean().optional(),
});

syncRoute.get("/:id/sync", requireDbAccess("id", "read"), (c) => {
  return c.json({ sync: syncJobs.byDatabaseId(c.req.param("id")) });
});

syncRoute.put("/:id/sync", requireDbAccess("id", "write"), async (c) => {
  const id = c.req.param("id");
  const dbRow = databases.byId(id);
  if (!dbRow) throw new HTTPException(404, { message: "not found" });
  if (dbRow.kind !== "mirror") {
    throw new HTTPException(400, { message: "sync only valid for mirror databases" });
  }
  const body = await parseJson(c, upsertBody);
  const problem = syncSourceProblem(body);
  if (problem) throw new HTTPException(400, { message: problem });
  const existing = syncJobs.byDatabaseId(id);
  let passwordEnc: string;
  if (body.sourcePassword) {
    passwordEnc = await encryptSecret(body.sourcePassword);
  } else {
    const stored = syncJobs.passwordEncFor(id);
    if (!stored) throw new HTTPException(400, { message: "sourcePassword required" });
    passwordEnc = stored;
  }
  syncJobs.upsert({
    id: existing?.id ?? newId("sj"),
    databaseId: id,
    sourceKind: body.sourceKind,
    sourceHost: body.sourceHost,
    sourcePort: body.sourcePort,
    sourceUser: body.sourceUser,
    passwordEnc,
    sourceDatabase: body.sourceDatabase,
    intervalSeconds: Math.max(60, body.intervalSeconds ?? 3600),
    enabled: body.enabled !== false,
  });
  audit.log(c.get("user").id, "sync.upsert", id, { host: body.sourceHost, database: body.sourceDatabase });
  return c.json({ sync: syncJobs.byDatabaseId(id) });
});

const runBody = z.object({ checkpoint: z.boolean().optional() }).strict();

syncRoute.post("/:id/sync/run", requireDbAccess("id", "write"), async (c) => {
  const id = c.req.param("id");
  if (!syncJobs.byDatabaseId(id)) throw new HTTPException(404, { message: "no sync configured" });
  const body = await parseJson(c, runBody);
  const user = c.get("user");
  const job = startSyncJob(id, user.id, { manual: true, checkpoint: body.checkpoint });
  audit.log(user.id, "sync.run", id, { jobId: job.id, ...(body.checkpoint === undefined ? {} : { checkpoint: body.checkpoint }) });
  return jobAcceptedResponse(c, job);
});

syncRoute.delete("/:id/sync", requireDbAccess("id", "write"), (c) => {
  const id = c.req.param("id");
  syncJobs.deleteByDatabaseId(id);
  audit.log(c.get("user").id, "sync.delete", id, null);
  return c.json({ ok: true });
});
