import type { DatabasePortStatus } from "./connections";
import type { TailscaleStatus } from "./types";

export type IngressKind = "loopback" | "lan" | "tailnet" | "cloudflare";

export interface AccessPolicy {
  allowLan: boolean;
  allowTailnet: boolean;
  allowCloudflare: boolean;
  requireCloudflareAccess: boolean;
  restrictAppApis: boolean;
}

export type CloudflareTunnelMode = "off" | "managed" | "external";

export interface CloudflareTunnelStatus {
  mode: CloudflareTunnelMode;
  installed: boolean;
  version: string | null;
  tokenConfigured: boolean;
  running: boolean;
  desired: boolean;
  connections: number | null;
  lastError: string | null;
  startedAt: number | null;
}

export interface CloudflareAccessStatus {
  teamDomain: string | null;
  audience: string | null;
  configured: boolean;
  lastVerifiedAt: number | null;
}

export interface TailscaleServeStatus {
  supported: boolean;
  enabled: boolean;
  url: string | null;
}

export interface NetworkStatus {
  yourIngress: IngressKind;
  yourIp: string;
  yourAccessVerified: boolean;
  warnings: string[];
  policy: AccessPolicy;
  policyLockedByEnv: boolean;
  publicUrls: string[];
  trustedProxies: string[];
  cloudflare: {
    tunnel: CloudflareTunnelStatus;
    access: CloudflareAccessStatus;
  };
  tailscale: TailscaleStatus & { serve: TailscaleServeStatus };
  bind: { host: string; port: number; mariadbBind: string; mariadbPort: number };
  databasePort?: DatabasePortStatus;
}

export interface NetworkStatusResponse {
  status: NetworkStatus;
}

export interface UpdateAccessPolicyRequest {
  policy: AccessPolicy;
}

export interface UpdatePublicUrlsRequest {
  publicUrls: string[];
  trustedProxies?: string[];
}

export interface UpdateCloudflareTunnelRequest {
  mode: CloudflareTunnelMode;
  token?: string;
}

export interface UpdateCloudflareAccessRequest {
  teamDomain: string | null;
  audience: string | null;
}

export interface CloudflareAccessTestResponse {
  ok: boolean;
  email: string | null;
  error: string | null;
}

export interface TailscaleServeRequest {
  enabled: boolean;
}

export interface SetupGate {
  tokenRequired: boolean;
}

export interface SetupTokenRequest {
  setupToken: string;
}
