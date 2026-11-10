import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import type { Job, JobListResponse, JobResponse, User } from "@lambdata/shared";
import { databases, jobs as jobStore } from "../db/queries";
import { requireAuth, type AuthVariables } from "../auth/middleware";
import { getJob, withLiveState } from "../jobs";
import { parseQuery, zBoolish } from "../util/validate";

export const jobsRoute = new Hono<{ Variables: AuthVariables }>();

jobsRoute.use("*", requireAuth);

function canReadDatabase(user: User, databaseId: string): boolean {
  if (user.role === "admin") return true;
  const row = databases.byId(databaseId);
  if (!row) return false;
  if (user.role === "db_owner") return row.ownerUserId === user.id;
  return true;
}

function canSeeJob(user: User, job: Job): boolean {
  if (user.role === "admin") return true;
  if (job.databaseId === null) return false;
  if (canReadDatabase(user, job.databaseId)) return true;
  return job.createdByUserId === user.id && databases.byId(job.databaseId) === null;
}

const listQuery = z.object({
  databaseId: z.string().min(1).max(128).optional(),
  active: zBoolish.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

jobsRoute.get("/", (c) => {
  const user = c.get("user");
  const q = parseQuery(c, listQuery);
  const activeOnly = q.active === true;
  let list: Job[];
  if (q.databaseId !== undefined) {
    if (!canReadDatabase(user, q.databaseId)) {
      throw new HTTPException(404, { message: "database not found" });
    }
    list = jobStore.list({ databaseId: q.databaseId, activeOnly, limit: q.limit });
  } else if (user.role === "admin") {
    list = jobStore.list({ activeOnly, limit: q.limit });
  } else {
    const visible = user.role === "db_owner" ? databases.listForUser(user.id) : databases.list();
    list = jobStore.list({
      databaseIds: visible.map((d) => d.id),
      includeWithoutDatabase: false,
      activeOnly,
      limit: q.limit,
    });
  }
  const res: JobListResponse = { jobs: withLiveState(list) };
  return c.json(res);
});

jobsRoute.get("/:id", (c) => {
  const job = getJob(c.req.param("id"));
  if (!job || !canSeeJob(c.get("user"), job)) {
    throw new HTTPException(404, { message: "job not found" });
  }
  const res: JobResponse = { job };
  return c.json(res);
});
