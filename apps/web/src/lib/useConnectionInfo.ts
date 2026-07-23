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
  const pageHost = typeof window === "undefined" ? "localhost" : window.location.hostname;
  return {
    host: !bind || isInternalBind(bind) ? pageHost : bind,
    port: q.data?.system.port ?? 3307,
  };
}

export function formatConnectionAddress(host: string, port: number): string {
  const bareHost = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  return bareHost.includes(":") ? `[${bareHost}]:${port}` : `${bareHost}:${port}`;
}

function isInternalBind(host: string): boolean {
  const normalized = host.replace(/^\[|\]$/g, "").toLowerCase();
  return (
    normalized === "0.0.0.0" ||
    normalized === "::" ||
    normalized === "::1" ||
    normalized === "localhost" ||
    normalized.startsWith("127.")
  );
}
