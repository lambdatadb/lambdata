import { useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import type {
  CheckpointDetailResponse,
  CheckpointDiffResponse,
  CheckpointListResponse,
  CheckpointStatusResponse,
  Database,
  Job,
  JobListResponse,
  JobResponse,
  RestoreCheckpointRequest,
  User,
  WorkingCopyStatus,
} from "@lambdata/shared";
import { api } from "../../lib/api";
import { canWriteDatabase } from "../../lib/auth";
import { queryKeys } from "../../lib/queries";

export const checkpointKeys = {
  all: (databaseId: string) => ["checkpoints", databaseId] as const,
  list: (databaseId: string) => ["checkpoints", databaseId, "list"] as const,
  status: (databaseId: string) => ["checkpoints", databaseId, "status"] as const,
  detail: (databaseId: string, checkpointId: string) => ["checkpoints", databaseId, "detail", checkpointId] as const,
  diff: (databaseId: string, checkpointId: string, against: string) =>
    ["checkpoints", databaseId, "diff", checkpointId, against] as const,
  jobs: (databaseId: string) => ["jobs", "recent", "database", databaseId] as const,
};

export function checkpointPath(databaseId: string, rest = ""): string {
  return `/databases/${encodeURIComponent(databaseId)}/checkpoints${rest}`;
}

export function startRollback(databaseId: string, checkpointId: string, body?: RestoreCheckpointRequest): Promise<JobResponse> {
  return api.post<JobResponse>(checkpointPath(databaseId, `/${encodeURIComponent(checkpointId)}/restore`), body);
}

export function useCheckpointList(databaseId: string) {
  return useQuery({
    queryKey: checkpointKeys.list(databaseId),
    queryFn: () => api.get<CheckpointListResponse>(checkpointPath(databaseId)),
    staleTime: 10_000,
    refetchInterval: (q) => (q.state.error ? false : 60_000),
  });
}

export function useWorkingCopyStatus(databaseId: string, options: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: checkpointKeys.status(databaseId),
    queryFn: async () => (await api.get<CheckpointStatusResponse>(checkpointPath(databaseId, "/status"))).status,
    enabled: options.enabled ?? true,
    staleTime: 20_000,
    refetchInterval: (q) => (q.state.error ? false : 45_000),
    retry: 1,
  });
}

export function useCachedWorkingCopyStatus(databaseId: string): WorkingCopyStatus | undefined {
  const query = useQuery({
    queryKey: checkpointKeys.status(databaseId),
    queryFn: async () => (await api.get<CheckpointStatusResponse>(checkpointPath(databaseId, "/status"))).status,
    enabled: false,
  });
  return query.data;
}

export async function refreshWorkingCopyStatus(qc: QueryClient, databaseId: string): Promise<WorkingCopyStatus> {
  const res = await api.get<CheckpointStatusResponse>(checkpointPath(databaseId, "/status?refresh=1"));
  qc.setQueryData(checkpointKeys.status(databaseId), res.status);
  return res.status;
}

export function useCheckpointDetail(databaseId: string, checkpointId: string | null) {
  return useQuery({
    queryKey: checkpointKeys.detail(databaseId, checkpointId ?? ""),
    queryFn: () => api.get<CheckpointDetailResponse>(checkpointPath(databaseId, `/${encodeURIComponent(checkpointId!)}`)),
    enabled: !!checkpointId,
    staleTime: 30_000,
    retry: (count, error) => count < 1 && !(error instanceof Error && /not found/i.test(error.message)),
  });
}

export function useCheckpointDiff(
  databaseId: string,
  checkpointId: string | null,
  against: string,
  options: { enabled?: boolean } = {},
) {
  return useQuery({
    queryKey: checkpointKeys.diff(databaseId, checkpointId ?? "", against),
    queryFn: async () =>
      (
        await api.get<CheckpointDiffResponse>(
          checkpointPath(databaseId, `/${encodeURIComponent(checkpointId!)}/diff?against=${encodeURIComponent(against)}`),
        )
      ).diff,
    enabled: !!checkpointId && (options.enabled ?? true),
    staleTime: against === "working" ? 15_000 : Infinity,
    retry: false,
  });
}

export function useDatabaseJobs(databaseId: string, poll: boolean) {
  return useQuery({
    queryKey: checkpointKeys.jobs(databaseId),
    queryFn: async () =>
      (await api.get<JobListResponse>(`/jobs?databaseId=${encodeURIComponent(databaseId)}&limit=8`)).jobs as Job[],
    refetchInterval: (q) => (q.state.error ? 60_000 : poll ? 2_000 : 30_000),
  });
}

export function useInvalidateHistory(databaseId: string) {
  const qc = useQueryClient();
  return () => invalidateHistory(qc, databaseId);
}

export function invalidateHistory(qc: QueryClient, databaseId: string): Promise<unknown> {
  return Promise.all([
    qc.invalidateQueries({ queryKey: checkpointKeys.all(databaseId) }),
    qc.invalidateQueries({ queryKey: queryKeys.database(databaseId) }),
    qc.invalidateQueries({ queryKey: queryKeys.databases, exact: true }),
    qc.invalidateQueries({ queryKey: queryKeys.dashboardSummary }),
    qc.invalidateQueries({ queryKey: checkpointKeys.jobs(databaseId) }),
  ]);
}

export interface HistoryPermissions {
  canWrite: boolean;
  canRestore: boolean;
}

export function historyPermissions(user: User | null, db: Database): HistoryPermissions {
  const allowed = canWriteDatabase(user, db);
  return { canWrite: allowed, canRestore: allowed };
}
