import { useQuery } from "@tanstack/react-query";
import type { DashboardSummary } from "@kilndb/shared";
import { api } from "./api";

export function useConnectionInfo(): { host: string; port: number } {
  const q = useQuery({
    queryKey: ["dashboard", "summary"],
    queryFn: () => api.get<DashboardSummary>("/dashboard/summary"),
    staleTime: 60_000,
  });
  const bind = q.data?.system.host;
  return {
    host: !bind || bind === "0.0.0.0" ? window.location.hostname : bind,
    port: q.data?.system.port ?? 3307,
  };
}
