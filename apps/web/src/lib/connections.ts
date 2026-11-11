import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  ConnectionRejectionReason,
  DashboardSummary,
  DatabasePortResponse,
  RejectedConnection,
  RejectedConnectionsResponse,
} from "@lambdata/shared";
import { api } from "./api";
import { pollEvery, queryKeys, useDashboardSummary } from "./queries";

export type DatabaseReach = "outside" | "this-machine" | "not-yet";

export const DATABASE_SWITCH_PATH = "/network#database-connections";
export const LOCAL_HOST = "127.0.0.1";

type ReachFacts = Pick<DashboardSummary["system"], "outsideConnections" | "inContainer">;

export function reachFromSystem(system: ReachFacts | null | undefined): DatabaseReach {
  if (!system || system.outsideConnections === undefined || system.outsideConnections) return "outside";
  return system.inContainer === false ? "this-machine" : "not-yet";
}

export function useDatabaseReach(): DatabaseReach {
  const summary = useDashboardSummary();
  return reachFromSystem(summary.data?.system);
}

export const rejectionKeys = {
  all: ["rejected-connections"] as const,
  database: (id: string) => ["rejected-connections", "database", id] as const,
  network: ["rejected-connections", "network"] as const,
};

export function useDatabaseRejections(databaseId: string) {
  return useQuery({
    queryKey: rejectionKeys.database(databaseId),
    queryFn: () => api.get<RejectedConnectionsResponse>(`/databases/${encodeURIComponent(databaseId)}/rejected-connections`),
    refetchInterval: pollEvery(30_000),
    staleTime: 10_000,
  });
}

export function useNetworkRejections(enabled: boolean) {
  return useQuery({
    queryKey: rejectionKeys.network,
    queryFn: () => api.get<RejectedConnectionsResponse>("/network/rejected-connections"),
    enabled,
    refetchInterval: pollEvery(30_000),
    staleTime: 10_000,
  });
}

export function useClearRejections() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.delete<RejectedConnectionsResponse>("/network/rejected-connections"),
    onSuccess: (data) => {
      qc.setQueryData(rejectionKeys.network, data);
      void qc.invalidateQueries({ queryKey: rejectionKeys.all });
    },
  });
}

export function useDatabasePortSwitch() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (outsideConnections: boolean) =>
      api.put<DatabasePortResponse>("/network/database-port", { outsideConnections }),
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: queryKeys.network });
      void qc.invalidateQueries({ queryKey: queryKeys.dashboardSummary });
    },
  });
}

export const REASON_LABELS: Record<ConnectionRejectionReason, string> = {
  "address-not-allowed": "Address not allowed",
  "wrong-password": "Wrong password",
  "unknown-account": "Unknown account",
  "closed-for-operation": "Closed for an operation",
  other: "Refused",
};

export function isUnknownAccount(r: Pick<RejectedConnection, "databaseId">): boolean {
  return r.databaseId === null;
}

export function timesLabel(count: number): string {
  return count === 1 ? "once" : `${count.toLocaleString()} times`;
}
