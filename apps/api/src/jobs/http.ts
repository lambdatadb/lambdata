import type { Context } from "hono";
import type { Job, JobConflictResponse, JobResponse } from "@lambdata/shared";
import { JobConflictError } from "./runner";

export function jobConflictResponse(c: Context, err: JobConflictError): Response {
  const body: JobConflictResponse = { error: err.message, jobId: err.jobId };
  return c.json(body, 409);
}

export function jobAcceptedResponse(c: Context, job: Job): Response {
  const body: JobResponse = { job };
  return c.json(body, 202);
}

export function disableRequestTimeout(c: Context): void {
  const server = (c.env as { server?: { timeout?: (req: Request, seconds: number) => void } } | undefined)
    ?.server;
  try {
    server?.timeout?.(c.req.raw, 0);
  } catch {}
}
