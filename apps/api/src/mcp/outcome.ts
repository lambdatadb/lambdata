import type { Context } from "hono";
import { APPROVAL_REQUIRED_CODE, type Approval, type Job } from "@lambdata/shared";
import { env } from "../env";
import { consoleLink } from "../notifications/emit";
import type { ApiResult } from "./call";
import { errorResult, plainId, toolResult, type ToolResult } from "./results";

export const APPROVALS_CONSOLE_PATH = "/access-tokens/approvals";

export function consoleUrl(c: Context, path: string): string {
  const configured = consoleLink(path);
  if (configured) return configured;
  const origin = env.webDist ? new URL(c.req.url).origin : env.webOrigin;
  return `${origin.replace(/\/+$/, "")}${path}`;
}

function errorText(body: unknown): string | null {
  if (body && typeof body === "object" && typeof (body as { error?: unknown }).error === "string") {
    return (body as { error: string }).error;
  }
  return null;
}

export function isApprovalRequired(res: ApiResult): res is ApiResult & { body: { approval: Approval } } {
  if (res.status !== 403 || !res.body || typeof res.body !== "object") return false;
  const body = res.body as { code?: unknown; approval?: unknown };
  return body.code === APPROVAL_REQUIRED_CODE && !!body.approval && typeof body.approval === "object";
}

export function compactApproval(a: Approval) {
  return {
    id: a.id,
    status: a.status,
    action: a.action,
    summary: a.summary,
    detail: a.detail,
    databaseId: a.databaseId,
    databaseName: a.databaseName,
    note: a.note,
    requestedAt: a.requestedAt,
    expiresAt: a.expiresAt,
    decidedAt: a.decidedAt,
    decidedBy: a.decidedByDisplayName,
    approvedUntil: a.approvedUntil ?? null,
    usedAt: a.usedAt,
  };
}

export function approvalNeeded(c: Context, tool: string, approval: Approval): ToolResult {
  const id = plainId(approval.id);
  const where = consoleUrl(c, APPROVALS_CONSOLE_PATH);
  const retry = id
    ? `Once it is approved, call ${tool} again with exactly the same arguments plus approval_id "${id}". An approval works once, for that exact request.`
    : `Once it is approved, call ${tool} again with exactly the same arguments plus the approval id from the data below.`;
  return toolResult(
    [
      "Nothing was done yet: this access token must ask first, and a person has to approve this action in the LambData console.",
      `Ask the owner to open ${where} and approve it.${id ? ` The approval id is ${id}.` : ""}`,
      retry,
      `You can check whether it was decided with get_approval${id ? ` (approval_id "${id}")` : ""}. Pending approvals expire after 24 hours.`,
    ],
    { approval: compactApproval(approval) },
  );
}

function refusalAdvice(res: ApiResult): string[] {
  switch (res.status) {
    case 400:
      return ["The request was not accepted. The reason is in the data below; fix the input and try again."];
    case 401:
      return ["The access token was not accepted. Ask the owner to check it in the LambData console under Access tokens, or to create a new one."];
    case 403:
      return [
        "This access token is not allowed to do that. The reason is in the data below.",
        "If the task really needs it, ask the owner for an access token with more access. Do not try to work around the refusal.",
      ];
    case 404:
      return ["It was not found, or this access token is not allowed to see it. Check the id with list_databases or the matching list tool."];
    case 409:
      return ["This conflicts with the current state, for example another job is running or the name is taken. The reason is in the data below."];
    case 413:
      return ["The request is too large."];
    case 415:
      return ["The request was sent in a form the server does not accept."];
    case 429: {
      const wait = Number(res.headers.get("retry-after"));
      const seconds = Number.isFinite(wait) && wait > 0 ? Math.ceil(wait) : 60;
      return [`This access token is over its request limit. Wait ${seconds} seconds, then try again.`];
    }
    case 503:
      return ["The server cannot do this right now. Wait a little and try again."];
    default:
      return res.status >= 500
        ? ["The server failed to do this. Wait a little and try again; if it keeps failing, tell the owner."]
        : [`The server answered with status ${res.status}.`];
  }
}

export function refusal(res: ApiResult): ToolResult {
  const message = errorText(res.body);
  return errorResult(refusalAdvice(res), { status: res.status, error: message ?? "no message" });
}

export function compactJob(job: Job) {
  return {
    id: job.id,
    kind: job.kind,
    databaseId: job.databaseId,
    status: job.status,
    stage: job.stage,
    progress: job.progress,
    error: job.error,
    warnings: job.warnings,
    result: job.result,
    createdAt: job.createdAt,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
  };
}

export function jobStarted(job: Job, lead: string): ToolResult {
  const id = plainId(job.id);
  return toolResult(
    [
      lead,
      id
        ? `It runs in the background as job ${id}. Call get_job with job_id "${id}" and wait_seconds (up to 50) to wait for it to finish.`
        : "It runs in the background. Call get_job with the job id from the data below and wait_seconds (up to 50) to wait for it to finish.",
    ],
    { job: compactJob(job) },
  );
}

export function jobOf(body: unknown): Job | null {
  const job = body && typeof body === "object" ? (body as { job?: unknown }).job : null;
  if (!job || typeof job !== "object" || typeof (job as Job).id !== "string") return null;
  return job as Job;
}

export function handle(
  c: Context,
  tool: string,
  res: ApiResult,
  ok: (body: unknown) => ToolResult,
): ToolResult {
  if (isApprovalRequired(res)) return approvalNeeded(c, tool, res.body.approval);
  if (res.status >= 400) return refusal(res);
  return ok(res.body);
}
