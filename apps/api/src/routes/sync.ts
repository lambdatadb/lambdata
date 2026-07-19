import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { SyncSourceKind } from "@kilndb/shared";
import { audit, databases, syncJobs } from "../db/queries";
import { requireAuth, requireDbAccess, type AuthVariables } from "../auth/middleware";
import { encryptSecret } from "../util/crypto";
import { runSyncJob } from "../workers/sync";
import { newId } from "../util/id";

export const syncRoute = new Hono<{ Variables: AuthVariables }>();

syncRoute.use("*", requireAuth);

syncRoute.get("/:id/sync", requireDbAccess("id", "read"), (c) => {
  const job = syncJobs.byDatabaseId(c.req.param("id"));
  return c.json({ sync: job });
});

syncRoute.put("/:id/sync", requireDbAccess("id", "write"), async (c) => {
  const id = c.req.param("id");
  const dbRow = databases.byId(id);
  if (!dbRow) throw new HTTPException(404, { message: "not found" });
  if (dbRow.kind !== "mirror") {
    throw new HTTPException(400, { message: "sync only valid for mirror databases" });
  }
  const body = (await c.req.json()) as {
    sourceKind?: SyncSourceKind;
    sourceHost?: string;
    sourcePort?: number;
    sourceUser?: string;
    sourcePassword?: string;
    sourceDatabase?: string;
    intervalSeconds?: number;
    enabled?: boolean;
  };
  if (!body.sourceKind || !body.sourceHost || !body.sourcePort || !body.sourceUser || !body.sourceDatabase) {
    throw new HTTPException(400, { message: "missing required sync fields" });
  }
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
  audit.log(c.get("user").id, "sync.upsert", id, { host: body.sourceHost });
  return c.json({ sync: syncJobs.byDatabaseId(id) });
});

syncRoute.post("/:id/sync/run", requireDbAccess("id", "write"), async (c) => {
  const id = c.req.param("id");
  const job = syncJobs.byDatabaseId(id);
  if (!job) throw new HTTPException(404, { message: "no sync configured" });
  const result = await runSyncJob(id);
  audit.log(c.get("user").id, "sync.run", id, { status: result.status });
  return c.json(result);
});

syncRoute.delete("/:id/sync", requireDbAccess("id", "write"), (c) => {
  const id = c.req.param("id");
  syncJobs.deleteByDatabaseId(id);
  audit.log(c.get("user").id, "sync.delete", id, null);
  return c.json({ ok: true });
});
