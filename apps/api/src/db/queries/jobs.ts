import type { Job, JobErrorCode, JobErrorDetails, JobKind, JobStatus } from "@lambdata/shared";
import { db } from "../client";

type JobRow = {
  id: string;
  kind: JobKind;
  database_id: string | null;
  status: JobStatus;
  exclusive: number;
  stage: string | null;
  progress: number | null;
  error: string | null;
  error_code: string | null;
  error_details: string | null;
  warnings: string | null;
  result: string | null;
  created_by_user_id: string | null;
  created_at: number;
  started_at: number | null;
  finished_at: number | null;
};

function parseJson<T>(raw: string | null, fallback: T): T {
  if (raw === null) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

const ERROR_CODES: ReadonlySet<string> = new Set<JobErrorCode>(["restore.code-unrestorable"]);

function errorDetailsOf(raw: string | null): JobErrorDetails | null {
  const parsed = parseJson<unknown>(raw, null);
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as JobErrorDetails) : null;
}

function rowToJob(r: JobRow): Job {
  const warnings = parseJson<unknown>(r.warnings, []);
  const result = parseJson<unknown>(r.result, null);
  return {
    id: r.id,
    kind: r.kind,
    databaseId: r.database_id,
    status: r.status,
    stage: r.stage,
    progress: r.progress,
    error: r.error,
    errorCode: r.error_code !== null && ERROR_CODES.has(r.error_code) ? (r.error_code as JobErrorCode) : null,
    errorDetails: errorDetailsOf(r.error_details),
    warnings: Array.isArray(warnings) ? warnings.map(String) : [],
    result: result && typeof result === "object" && !Array.isArray(result)
      ? (result as Record<string, unknown>)
      : null,
    createdByUserId: r.created_by_user_id,
    createdAt: r.created_at,
    startedAt: r.started_at,
    finishedAt: r.finished_at,
  };
}

export interface JobListFilter {
  databaseId?: string;
  databaseIds?: string[];
  includeWithoutDatabase?: boolean;
  activeOnly?: boolean;
  limit: number;
}

export const jobs = {
  insert(job: Job & { exclusive: boolean }): void {
    db.query(
      `INSERT INTO jobs(id, kind, database_id, status, exclusive, stage, progress, error, error_code, error_details, warnings,
        result, created_by_user_id, created_at, started_at, finished_at)
       VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      job.id,
      job.kind,
      job.databaseId,
      job.status,
      job.exclusive ? 1 : 0,
      job.stage,
      job.progress,
      job.error,
      job.errorCode ?? null,
      job.errorDetails ? JSON.stringify(job.errorDetails) : null,
      JSON.stringify(job.warnings),
      job.result === null ? null : JSON.stringify(job.result),
      job.createdByUserId,
      job.createdAt,
      job.startedAt,
      job.finishedAt,
    );
  },
  save(job: Job): void {
    db.query(
      `UPDATE jobs SET status = ?, stage = ?, progress = ?, error = ?, error_code = ?, error_details = ?, warnings = ?,
        result = ?, started_at = ?, finished_at = ? WHERE id = ?`,
    ).run(
      job.status,
      job.stage,
      job.progress,
      job.error,
      job.errorCode ?? null,
      job.errorDetails ? JSON.stringify(job.errorDetails) : null,
      JSON.stringify(job.warnings),
      job.result === null ? null : JSON.stringify(job.result),
      job.startedAt,
      job.finishedAt,
      job.id,
    );
  },
  byId(id: string): Job | null {
    const r = db.query("SELECT * FROM jobs WHERE id = ?").get(id) as JobRow | null;
    return r ? rowToJob(r) : null;
  },
  list(filter: JobListFilter): Job[] {
    const where: string[] = [];
    const params: (string | number)[] = [];
    if (filter.databaseId !== undefined) {
      where.push("database_id = ?");
      params.push(filter.databaseId);
    } else if (filter.databaseIds !== undefined) {
      const scoped: string[] = [];
      if (filter.databaseIds.length > 0) {
        scoped.push(`database_id IN (${filter.databaseIds.map(() => "?").join(",")})`);
        params.push(...filter.databaseIds);
      }
      if (filter.includeWithoutDatabase) scoped.push("database_id IS NULL");
      if (scoped.length === 0) return [];
      where.push(`(${scoped.join(" OR ")})`);
    } else if (filter.includeWithoutDatabase === false) {
      where.push("database_id IS NOT NULL");
    }
    if (filter.activeOnly) where.push("status IN ('queued', 'running')");
    const sql = `SELECT * FROM jobs ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY created_at DESC, id DESC LIMIT ?`;
    params.push(filter.limit);
    const rows = db.query(sql).all(...params) as JobRow[];
    return rows.map(rowToJob);
  },
  rewriteFinished(
    id: string,
    patch: { status: "succeeded" | "failed"; error: string | null; warnings?: string[]; result?: Record<string, unknown> | null },
  ): boolean {
    const current = jobs.byId(id);
    if (!current || current.status === "queued" || current.status === "running") return false;
    const res = db
      .query("UPDATE jobs SET status = ?, error = ?, warnings = ?, result = ?, finished_at = COALESCE(finished_at, ?) WHERE id = ?")
      .run(
        patch.status,
        patch.error,
        JSON.stringify(patch.warnings ?? current.warnings),
        patch.result === undefined ? (current.result === null ? null : JSON.stringify(current.result)) : patch.result === null ? null : JSON.stringify(patch.result),
        Date.now(),
        id,
      );
    return Number(res.changes) > 0;
  },
  finishCompletedSwaps(key: string, at: number): number {
    const rows = db.query("SELECT * FROM jobs WHERE status IN ('queued', 'running') AND result IS NOT NULL").all() as JobRow[];
    let n = 0;
    for (const r of rows) {
      const job = rowToJob(r);
      const note = job.result?.[key];
      if (typeof note !== "string" || !note) continue;
      const result: Record<string, unknown> = { ...job.result };
      delete result[key];
      const res = db
        .query("UPDATE jobs SET status = 'succeeded', error = NULL, warnings = ?, result = ?, finished_at = ? WHERE id = ? AND status IN ('queued', 'running')")
        .run(JSON.stringify([...job.warnings, note]), JSON.stringify({ ...result, completedAfterRestart: true }), at, job.id);
      n += Number(res.changes);
    }
    return n;
  },
  failInterrupted(message: string, at: number): number {
    const res = db
      .query(
        `UPDATE jobs SET status = 'failed', error = ?, finished_at = ?
         WHERE status IN ('queued', 'running')`,
      )
      .run(message, at);
    return Number(res.changes);
  },
  pruneFinishedBefore(cutoff: number): number {
    const res = db
      .query(
        `DELETE FROM jobs WHERE status IN ('succeeded', 'failed')
         AND COALESCE(finished_at, created_at) < ?`,
      )
      .run(cutoff);
    return Number(res.changes);
  },
};
