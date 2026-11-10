import { useQuery } from "@tanstack/react-query";
import type {
  AppSettings,
  AuditLogEntry,
  DashboardSummary,
  Database,
  HealthDetail,
  NetworkStatus,
  NetworkStatusResponse,
  SetupState,
  TailscaleStatus,
  User,
} from "@lambdata/shared";
import { api, ApiError } from "./api";

export const queryKeys = {
  auth: ["auth", "me"] as const,
  setup: ["setup", "state"] as const,
  settings: ["settings"] as const,
  databases: ["databases"] as const,
  database: (id: string) => ["databases", id] as const,
  databaseTables: (id: string) => ["database-tables", id] as const,
  metrics: (id: string, range: string) => ["metrics", id, range] as const,
  sync: (id: string) => ["sync", id] as const,
  dashboardSummary: ["dashboard", "summary"] as const,
  dashboardVitals: (range: string) => ["dashboard", "vitals", range] as const,
  health: ["health", "detail"] as const,
  tailscale: ["tailscale", "status"] as const,
  network: ["network", "status"] as const,
  auditLogs: (limit: number) => ["audit-logs", limit] as const,
  users: ["users"] as const,
  jobs: ["jobs"] as const,
  job: (id: string) => ["jobs", "detail", id] as const,
  activeJobs: (databaseId?: string) => ["jobs", "active", databaseId ?? "all"] as const,
  recentJobs: (limit: number) => ["jobs", "recent", limit] as const,
};

export function pollEvery(ms: number) {
  return (query: { state: { error: Error | null } }): number | false => {
    const error = query.state.error;
    if (error instanceof ApiError && (error.status === 401 || error.status === 403)) return false;
    return error ? Math.max(ms, 30_000) : ms;
  };
}

export function isForbidden(error: unknown): boolean {
  return error instanceof ApiError && error.status === 403;
}

export function isNotFound(error: unknown): boolean {
  return error instanceof ApiError && error.status === 404;
}

export function useDatabases(options: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: queryKeys.databases,
    queryFn: () => api.get<{ databases: Database[] }>("/databases"),
    select: (data) => data.databases,
    enabled: options.enabled ?? true,
    staleTime: 15_000,
  });
}

export function useDatabase(id: string | null | undefined) {
  return useQuery({
    queryKey: queryKeys.database(id ?? ""),
    queryFn: () => api.get<{ database: Database }>(`/databases/${id}`),
    select: (data) => data.database,
    enabled: !!id,
  });
}

export function useDashboardSummary(options: { poll?: boolean } = {}) {
  return useQuery({
    queryKey: queryKeys.dashboardSummary,
    queryFn: () => api.get<DashboardSummary>("/dashboard/summary"),
    refetchInterval: options.poll ? 10_000 : false,
    staleTime: 5_000,
  });
}

export function useHealth() {
  return useQuery({
    queryKey: queryKeys.health,
    queryFn: () => api.get<HealthDetail>("/health/detail"),
    refetchInterval: (query) => (query.state.error ? 60_000 : 30_000),
    staleTime: 10_000,
  });
}

export function useTailscaleStatus(options: { enabled?: boolean; fast?: boolean } = {}) {
  return useQuery({
    queryKey: queryKeys.tailscale,
    queryFn: () => api.get<TailscaleStatus>("/tailscale/status"),
    enabled: options.enabled ?? true,
    refetchInterval: (query) => (query.state.error ? 60_000 : options.fast ? 10_000 : 30_000),
    staleTime: 8_000,
  });
}

export async function fetchNetworkStatus(): Promise<NetworkStatus | null> {
  try {
    const res = await api.get<NetworkStatusResponse>("/network/status");
    return res.status ?? null;
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
}

export function useNetworkStatus(options: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: queryKeys.network,
    queryFn: fetchNetworkStatus,
    enabled: options.enabled ?? true,
    refetchInterval: (query) => (query.state.error || query.state.data === null ? 120_000 : 30_000),
    staleTime: 10_000,
  });
}

export function useAppSettings(options: { enabled?: boolean; poll?: number } = {}) {
  return useQuery({
    queryKey: queryKeys.settings,
    queryFn: () => api.get<AppSettings>("/settings"),
    enabled: options.enabled ?? true,
    staleTime: 60_000,
    refetchInterval: (query) => (query.state.error ? false : (options.poll ?? false)),
  });
}

export function useSetupState() {
  return useQuery({
    queryKey: queryKeys.setup,
    queryFn: () => api.get<SetupState>("/setup/state"),
    staleTime: Infinity,
  });
}

export function useAuditLogs(limit: number, options: { enabled?: boolean; poll?: number } = {}) {
  return useQuery({
    queryKey: queryKeys.auditLogs(limit),
    queryFn: () => api.get<{ logs: AuditLogEntry[] }>(`/system/audit-logs?limit=${limit}`),
    select: (data) => data.logs,
    enabled: options.enabled ?? true,
    refetchInterval: (query) => (query.state.error ? false : (options.poll ?? false)),
  });
}

export function useConsoleUsers(options: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: queryKeys.users,
    queryFn: () => api.get<{ users: User[] }>("/users"),
    enabled: options.enabled ?? true,
    staleTime: 30_000,
  });
}

export interface AuditTarget {
  label: string;
  href: string | null;
}

export function useAuditTargets(enabled = true): (target: string | null) => AuditTarget | null {
  const databases = useDatabases({ enabled });
  const users = useConsoleUsers({ enabled });
  return (target) => {
    if (!target) return null;
    const db = databases.data?.find((d) => d.id === target);
    if (db) return { label: db.displayName, href: `/databases/${encodeURIComponent(db.id)}` };
    const user = users.data?.users.find((u) => u.id === target);
    if (user) return { label: user.displayName ?? user.email, href: "/users" };
    return { label: target, href: null };
  };
}
