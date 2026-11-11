import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import type {
  Checkpoint,
  CheckpointDetailResponse,
  CheckpointDiffResponse,
  CheckpointListResponse,
  CheckpointPolicy,
  CheckpointPolicyResponse,
  CheckpointStatusResponse,
  RestoreCheckpointRequest,
} from "@lambdata/shared";
import { audit, checkpoints, databases } from "../db/queries";
import { requireAuth, requireDbAccess, type AuthVariables } from "../auth/middleware";
import { disableRequestTimeout, jobAcceptedResponse, startJob } from "../jobs";
import { parseJson, parseQuery, zBoolish } from "../util/validate";
import { assertCheckpointPolicyAllowed } from "../util/disk";
import { createCheckpoint, deleteCheckpoint, restoreCheckpoint } from "../checkpoints";
import { normalizeMessage } from "../checkpoints/capture";
import { checkpointDownloadStream, downloadFileName } from "../checkpoints/download";
import { CheckpointDataMissingError } from "../checkpoints/restore";
import { automaticSchedule } from "../checkpoints/scheduler";
import { boundedLiveSnapshot, diffAgainstLive, diffEntries, getWorkingCopyStatus } from "../checkpoints/status";
import { notRespondingMessage } from "../util/mariadbHealth";

export const checkpointsRoute = new Hono<{ Variables: AuthVariables }>();

checkpointsRoute.use("*", requireAuth);

const createBody = z.object({ message: z.string().max(2000).optional(), verify: z.boolean().optional() });
const updateBody = z
  .object({ message: z.string().trim().min(1).max(500).optional(), pinned: z.boolean().optional() })
  .refine((b) => b.message !== undefined || b.pinned !== undefined, { message: "nothing to update" });
const policyBody = z
  .object({
    versioned: z.boolean().optional(),
    autoIntervalHours: z.number().int().min(0).max(8760).optional(),
    autoRetention: z.number().int().min(1).max(1000).optional(),
    checkpointOnSync: z.boolean().optional(),
    manualSyncCheckpoint: z.enum(["ask", "always", "never"]).optional(),
  })
  .strict();
const restoreBody = z.object({ allowCodeFailures: z.boolean().optional() });
const statusQuery = z.object({ refresh: zBoolish.optional() });
const diffQuery = z.object({ against: z.string().min(1).max(128).default("parent"), refresh: zBoolish.optional() });

function policyFor(databaseId: string): CheckpointPolicy {
  const row = databases.byId(databaseId);
  return { versioned: row?.versioned ?? false, ...checkpoints.policy(databaseId) };
}

function checkpointOf(databaseId: string, checkpointId: string): Checkpoint {
  const cp = checkpoints.byId(checkpointId);
  if (!cp || cp.databaseId !== databaseId) throw new HTTPException(404, { message: "checkpoint not found" });
  return cp;
}

function publicEntries(checkpointId: string) {
  return checkpoints.entries(checkpointId).map((e) => ({
    name: e.name,
    kind: e.kind,
    objectHash: e.objectHash,
    rowCount: e.rowCount,
    logicalBytes: e.logicalBytes,
    storedBytes: e.storedBytes,
  }));
}

function diffFromParent(cp: Checkpoint) {
  if (cp.format === "legacy") return null;
  const parent = cp.parentId ? checkpoints.byId(cp.parentId) : null;
  if (parent && parent.format === "legacy") return null;
  return diffEntries(parent?.id ?? null, cp.id, parent ? checkpoints.entries(parent.id) : [], checkpoints.entries(cp.id));
}

checkpointsRoute.get("/:id/checkpoints", requireDbAccess("id", "read"), (c) => {
  const id = c.req.param("id");
  const res: CheckpointListResponse = {
    checkpoints: checkpoints.listForDatabase(id),
    policy: policyFor(id),
    storage: checkpoints.storage(id),
    unconverted: checkpoints.conversionFailures(id),
    schedule: automaticSchedule(id),
  };
  return c.json(res);
});

checkpointsRoute.get("/:id/checkpoints/status", requireDbAccess("id", "read"), async (c) => {
  const q = parseQuery(c, statusQuery);
  const res: CheckpointStatusResponse = {
    status: await getWorkingCopyStatus(c.req.param("id"), { refresh: q.refresh === true }),
  };
  return c.json(res);
});

checkpointsRoute.put("/:id/checkpoints/policy", requireDbAccess("id", "write"), async (c) => {
  const id = c.req.param("id");
  const body = await parseJson(c, policyBody);
  const current = checkpoints.policy(id);
  const next = {
    autoIntervalHours: body.autoIntervalHours ?? current.autoIntervalHours,
    autoRetention: body.autoRetention ?? current.autoRetention,
    checkpointOnSync: body.checkpointOnSync ?? current.checkpointOnSync,
    manualSyncCheckpoint: body.manualSyncCheckpoint ?? current.manualSyncCheckpoint ?? "ask",
  };
  assertCheckpointPolicyAllowed({ role: c.get("user").role, next, current });
  checkpoints.setPolicy(id, next);
  if (body.versioned !== undefined) databases.update(id, { versioned: body.versioned });
  audit.log(c.get("user").id, "checkpoint.policy", id, body);
  const res: CheckpointPolicyResponse = { policy: policyFor(id), schedule: automaticSchedule(id) };
  return c.json(res);
});

checkpointsRoute.post("/:id/checkpoints", requireDbAccess("id", "write"), async (c) => {
  const id = c.req.param("id");
  const body = await parseJson(c, createBody);
  const user = c.get("user");
  const message = normalizeMessage(body.message, "manual");
  const job = startJob({ kind: "checkpoint.create", databaseId: id, userId: user.id }, async (ctx) => {
    const result = await createCheckpoint(id, { trigger: "manual", message, userId: user.id, hooks: ctx, verify: body.verify === true });
    audit.log(user.id, "checkpoint.create", id, {
      checkpointId: result.checkpointId,
      unchanged: result.unchanged,
      verified: result.verified ?? false,
    });
    return result;
  });
  return jobAcceptedResponse(c, job);
});

checkpointsRoute.get("/:id/checkpoints/:cid", requireDbAccess("id", "read"), (c) => {
  const id = c.req.param("id");
  const cp = checkpointOf(id, c.req.param("cid"));
  const res: CheckpointDetailResponse = {
    checkpoint: cp,
    entries: publicEntries(cp.id),
    diffFromParent: diffFromParent(cp),
  };
  return c.json(res);
});

checkpointsRoute.get("/:id/checkpoints/:cid/diff", requireDbAccess("id", "read"), async (c) => {
  const id = c.req.param("id");
  const cp = checkpointOf(id, c.req.param("cid"));
  const q = parseQuery(c, diffQuery);
  if (cp.format === "legacy") {
    throw new HTTPException(409, { message: "imported snapshots have no per-table data to compare" });
  }
  let res: CheckpointDiffResponse;
  if (q.against === "working") {
    const live = await boundedLiveSnapshot(id, { refresh: q.refresh === true });
    if (!live) throw new HTTPException(503, { message: notRespondingMessage() });
    res = { diff: diffAgainstLive(cp.id, checkpoints.entries(cp.id), live) };
  } else if (q.against === "parent") {
    const diff = diffFromParent(cp);
    if (!diff) throw new HTTPException(409, { message: "the parent is an imported snapshot and cannot be compared" });
    res = { diff };
  } else {
    const other = checkpointOf(id, q.against);
    if (other.format === "legacy") {
      throw new HTTPException(409, { message: "imported snapshots have no per-table data to compare" });
    }
    res = { diff: diffEntries(other.id, cp.id, checkpoints.entries(other.id), checkpoints.entries(cp.id)) };
  }
  return c.json(res);
});

checkpointsRoute.patch("/:id/checkpoints/:cid", requireDbAccess("id", "write"), async (c) => {
  const id = c.req.param("id");
  const cp = checkpointOf(id, c.req.param("cid"));
  const body = await parseJson(c, updateBody);
  checkpoints.update(cp.id, {
    message: body.message === undefined ? undefined : normalizeMessage(body.message, cp.trigger),
    pinned: body.pinned,
  });
  audit.log(c.get("user").id, "checkpoint.update", id, { checkpointId: cp.id, ...body });
  return c.json({ checkpoint: checkpoints.byId(cp.id) });
});

checkpointsRoute.delete("/:id/checkpoints/:cid", requireDbAccess("id", "write"), async (c) => {
  const id = c.req.param("id");
  const cp = checkpointOf(id, c.req.param("cid"));
  await deleteCheckpoint(id, cp.id);
  audit.log(c.get("user").id, "checkpoint.delete", id, { checkpointId: cp.id, hash: cp.shortHash });
  return c.json({ ok: true });
});

checkpointsRoute.post("/:id/checkpoints/:cid/restore", requireDbAccess("id", "owner"), async (c) => {
  const id = c.req.param("id");
  const cp = checkpointOf(id, c.req.param("cid"));
  const body: RestoreCheckpointRequest = await parseJson(c, restoreBody);
  const user = c.get("user");
  const job = startJob({ kind: "checkpoint.restore", databaseId: id, userId: user.id }, (ctx) =>
    restoreCheckpoint(id, cp.id, { userId: user.id, hooks: ctx, allowCodeFailures: body.allowCodeFailures === true }),
  );
  return jobAcceptedResponse(c, job);
});

checkpointsRoute.get("/:id/checkpoints/:cid/download", requireDbAccess("id", "read"), (c) => {
  const id = c.req.param("id");
  const cp = checkpointOf(id, c.req.param("cid"));
  const row = databases.byId(id);
  if (!row) throw new HTTPException(404, { message: "database not found" });
  let stream: ReadableStream<Uint8Array>;
  try {
    stream = checkpointDownloadStream(row.name, cp, checkpoints.entries(cp.id));
  } catch (err) {
    if (err instanceof CheckpointDataMissingError) throw new HTTPException(410, { message: err.message });
    throw err;
  }
  disableRequestTimeout(c);
  audit.log(c.get("user").id, "checkpoint.download", id, { checkpointId: cp.id, hash: cp.shortHash });
  const name = downloadFileName(row.name, cp);
  return new Response(stream, {
    headers: {
      "Content-Type": "application/gzip",
      "Content-Disposition": `attachment; filename="${name}"`,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
});
