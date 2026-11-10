import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Cloud, Router, Server, Waypoints, type LucideIcon } from "lucide-react";
import type { AccessPolicy, IngressKind, NetworkStatusResponse } from "@lambdata/shared";
import { api, ApiError } from "../../lib/api";
import { fetchNetworkStatus, queryKeys } from "../../lib/queries";

export { tunnelPhase, type TunnelPhase } from "../../lib/network";

export interface IngressMeta {
  label: string;
  phrase: string;
  icon: LucideIcon;
}

export const INGRESS: Record<IngressKind, IngressMeta> = {
  lan: { label: "Local network", phrase: "your local network", icon: Router },
  tailnet: { label: "Tailnet", phrase: "your tailnet", icon: Waypoints },
  cloudflare: { label: "Cloudflare", phrase: "Cloudflare", icon: Cloud },
  loopback: { label: "This server", phrase: "this server itself", icon: Server },
};

export type PolicySwitch = "allowLan" | "allowTailnet" | "allowCloudflare";

export const SWITCH_INGRESS: Record<PolicySwitch, IngressKind> = {
  allowLan: "lan",
  allowTailnet: "tailnet",
  allowCloudflare: "cloudflare",
};

export function blocksIngress(policy: AccessPolicy, ingress: IngressKind): boolean {
  if (ingress === "loopback") return false;
  if (ingress === "lan") return !policy.allowLan;
  if (ingress === "tailnet") return !policy.allowTailnet;
  return !policy.allowCloudflare;
}

export function useNetworkPageStatus() {
  return useQuery({
    queryKey: queryKeys.network,
    queryFn: fetchNetworkStatus,
    refetchInterval: (query) => {
      if (query.state.error) return 60_000;
      const tunnel = query.state.data?.cloudflare.tunnel;
      if (tunnel && tunnel.mode === "managed" && tunnel.running && !tunnel.connections) return 2_000;
      if (tunnel && tunnel.mode === "managed" && (tunnel.lastError || tunnel.desired)) return 5_000;
      return 10_000;
    },
    staleTime: 2_000,
  });
}

export function useNetworkMutation<V>(request: (vars: V) => Promise<NetworkStatusResponse>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: request,
    onSuccess: (res) => {
      qc.setQueryData(queryKeys.network, res.status);
      void qc.invalidateQueries({ queryKey: queryKeys.tailscale });
    },
  });
}

export function isLockout(error: unknown): boolean {
  return error instanceof ApiError && error.status === 409 && /^Refusing to/i.test(error.message);
}

export const putPolicy = (policy: AccessPolicy) => api.put<NetworkStatusResponse>("/network/policy", { policy });
