import { useCallback, useEffect, useRef } from "react";
import { useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import type { Job, JobConflictResponse, JobListResponse, JobResponse } from "@lambdata/shared";
import { api, ApiError } from "./api";
import { queryKeys } from "./queries";

export { jobBusyText, jobKindLabel, jobKindNoun } from "./jobKinds";

export const JOB_POLL_MS = 1_000;

export function isJobActive(job: Pick<Job, "status"> | null | undefined): boolean {
  return job?.status === "queued" || job?.status === "running";
}

export function isJobFinished(job: Pick<Job, "status"> | null | undefined): boolean {
  return job?.status === "succeeded" || job?.status === "failed";
}

export function isJobConflict(error: unknown): error is ApiError & { body: JobConflictResponse } {
  if (!(error instanceof ApiError) || error.status !== 409) return false;
  const body = error.body as Partial<JobConflictResponse> | null;
  return !!body && typeof body.jobId === "string" && body.jobId.length > 0;
}

export function jobConflictId(error: unknown): string | null {
  return isJobConflict(error) ? error.body.jobId : null;
}

export function invalidateAfterJob(qc: QueryClient, job: Pick<Job, "databaseId">): void {
  void qc.invalidateQueries({ queryKey: ["jobs", "active"] });
  void qc.invalidateQueries({ queryKey: ["jobs", "recent"] });
  void qc.invalidateQueries({ queryKey: queryKeys.databases });
  void qc.invalidateQueries({ queryKey: queryKeys.dashboardSummary });
  if (job.databaseId) {
    void qc.invalidateQueries({ queryKey: ["checkpoints", job.databaseId] });
    void qc.invalidateQueries({ queryKey: queryKeys.databaseTables(job.databaseId) });
    void qc.invalidateQueries({ queryKey: ["imports", "history", job.databaseId] });
  }
}

export interface UseJobOptions {
  onDone?: (job: Job) => void;
  initialJob?: Job | null;
}

export interface UseJobResult {
  job: Job | undefined;
  isActive: boolean;
  isFinished: boolean;
  isLoading: boolean;
  error: Error | null;
}

export function useJob(jobId: string | null | undefined, options: UseJobOptions = {}): UseJobResult {
  const qc = useQueryClient();
  const onDoneRef = useRef(options.onDone);
  onDoneRef.current = options.onDone;
  const reported = useRef<string | null>(null);
  const initial = options.initialJob && options.initialJob.id === jobId ? options.initialJob : undefined;

  const query = useQuery({
    queryKey: queryKeys.job(jobId ?? ""),
    queryFn: async () => (await api.get<JobResponse>(`/jobs/${jobId}`)).job,
    enabled: !!jobId,
    initialData: initial,
    initialDataUpdatedAt: initial ? 0 : undefined,
    refetchInterval: (q) => {
      if (q.state.error) return q.state.errorUpdateCount > 5 ? false : 3_000;
      const data = q.state.data;
      return !data || isJobActive(data) ? JOB_POLL_MS : false;
    },
    refetchIntervalInBackground: true,
    retry: 2,
  });

  const job = query.data;

  useEffect(() => {
    if (!job || !jobId || job.id !== jobId) return;
    if (!isJobFinished(job)) return;
    if (reported.current === job.id) return;
    reported.current = job.id;
    invalidateAfterJob(qc, job);
    onDoneRef.current?.(job);
  }, [job, jobId, qc]);

  return {
    job,
    isActive: isJobActive(job),
    isFinished: isJobFinished(job),
    isLoading: !!jobId && query.isPending,
    error: query.error,
  };
}

export function useActiveJobs(databaseId?: string) {
  const query = useQuery({
    queryKey: queryKeys.activeJobs(databaseId),
    queryFn: async () => {
      const params = new URLSearchParams({ active: "1", limit: "50" });
      if (databaseId) params.set("databaseId", databaseId);
      return (await api.get<JobListResponse>(`/jobs?${params}`)).jobs;
    },
    refetchInterval: (q) => {
      if (q.state.error) return 30_000;
      return (q.state.data?.length ?? 0) > 0 ? 2_000 : 10_000;
    },
  });
  const jobs = query.data ?? [];
  return {
    jobs,
    hasActive: jobs.length > 0,
    isLoading: query.isPending,
    error: query.error,
    refetch: query.refetch,
  };
}

export function useRecentJobs(limit = 10, options: { enabled?: boolean } = {}) {
  const qc = useQueryClient();
  const seenActive = useRef(new Set<string>());
  const query = useQuery({
    queryKey: queryKeys.recentJobs(limit),
    queryFn: async () => (await api.get<JobListResponse>(`/jobs?limit=${limit}`)).jobs,
    enabled: options.enabled ?? true,
    refetchInterval: (q) => {
      if (q.state.error) return 60_000;
      return (q.state.data ?? []).some(isJobActive) ? 2_000 : 15_000;
    },
  });
  useEffect(() => {
    for (const job of query.data ?? []) {
      if (isJobActive(job)) seenActive.current.add(job.id);
      else if (seenActive.current.delete(job.id)) invalidateAfterJob(qc, job);
    }
  }, [query.data, qc]);

  return { jobs: query.data ?? [], isLoading: query.isPending, error: query.error };
}

export function useTrackJob(): (job: Job) => void {
  const qc = useQueryClient();
  return useCallback(
    (job: Job) => {
      qc.setQueryData(queryKeys.job(job.id), job);
      void qc.invalidateQueries({ queryKey: ["jobs", "active"] });
      void qc.invalidateQueries({ queryKey: ["jobs", "recent"] });
    },
    [qc],
  );
}
