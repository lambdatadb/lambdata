import type { CodeObjectFailure } from "./checkpoints";

export type JobKind =
  | "checkpoint.create"
  | "checkpoint.restore"
  | "sync.run"
  | "import.sqlite"
  | "import.sql";

export type JobStatus = "queued" | "running" | "succeeded" | "failed";

export type JobErrorCode = "restore.code-unrestorable";

export interface JobErrorDetails {
  checkpointId?: string;
  codeFailures?: CodeObjectFailure[];
}

export interface Job {
  id: string;
  kind: JobKind;
  databaseId: string | null;
  status: JobStatus;
  stage: string | null;
  progress: number | null;
  error: string | null;
  errorCode?: JobErrorCode | null;
  errorDetails?: JobErrorDetails | null;
  warnings: string[];
  result: Record<string, unknown> | null;
  createdByUserId: string | null;
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
}

export interface JobResponse {
  job: Job;
}

export interface JobListResponse {
  jobs: Job[];
}

export interface JobConflictResponse {
  error: string;
  jobId: string;
}
