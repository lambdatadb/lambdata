import type { AccessPolicy, CloudflareTunnelMode } from "@lambdata/shared";
import { db } from "../db/client";
import { settings } from "../db/queries";
import { readEnv } from "../env";
import { parseCidr, type Cidr } from "./ip";

export const OPEN_POLICY: Readonly<AccessPolicy> = Object.freeze({
  allowLan: true,
  allowTailnet: true,
  allowCloudflare: true,
  requireCloudflareAccess: false,
  restrictAppApis: false,
});

export const KEYS = {
  policy: "network_access_policy",
  publicUrls: "network_public_urls",
  trustedProxies: "network_trusted_proxies",
  tunnelMode: "cloudflare_tunnel_mode",
  tunnelToken: "cloudflare_tunnel_token_enc",
  tunnelAutostart: "cloudflare_tunnel_autostart",
  accessTeamDomain: "cloudflare_access_team_domain",
  accessAudience: "cloudflare_access_audience",
  accessVerifiedAt: "cloudflare_access_last_verified_at",
  serveUrl: "tailscale_serve_url",
} as const;

const ALL_KEYS = Object.values(KEYS);

export interface AccessConfig {
  teamDomain: string;
  audience: string;
}

export interface NetworkConfig {
  storedPolicy: AccessPolicy;
  publicUrls: string[];
  trustedProxies: string[];
  trustedCidrs: Cidr[];
  tunnelMode: CloudflareTunnelMode;
  tunnelTokenEnc: string | null;
  tunnelAutostart: boolean;
  access: AccessConfig | null;
  accessTeamDomain: string | null;
  accessAudience: string | null;
  accessVerifiedAt: number | null;
  serveUrl: string | null;
}

const EMPTY: NetworkConfig = {
  storedPolicy: { ...OPEN_POLICY },
  publicUrls: [],
  trustedProxies: [],
  trustedCidrs: [],
  tunnelMode: "off",
  tunnelTokenEnc: null,
  tunnelAutostart: false,
  access: null,
  accessTeamDomain: null,
  accessAudience: null,
  accessVerifiedAt: null,
  serveUrl: null,
};

let lastGood: NetworkConfig = EMPTY;

function parsePolicy(raw: string | undefined): AccessPolicy {
  const policy: AccessPolicy = { ...OPEN_POLICY };
  if (!raw) return policy;
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    for (const key of Object.keys(policy) as (keyof AccessPolicy)[]) {
      if (typeof value[key] === "boolean") policy[key] = value[key] as boolean;
    }
  } catch {
    return policy;
  }
  return policy;
}

function parseList(raw: string | undefined): string[] {
  if (!raw) return [];
  try {
    const value = JSON.parse(raw) as unknown;
    return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
  } catch {
    return [];
  }
}

function text(raw: string | undefined): string | null {
  return raw ? raw : null;
}

function parseMode(raw: string | undefined): CloudflareTunnelMode {
  return raw === "managed" || raw === "external" ? raw : "off";
}

export function loadNetworkConfig(): NetworkConfig {
  let rows: { key: string; value: string }[];
  try {
    rows = db
      .query(`SELECT key, value FROM settings WHERE key IN (${ALL_KEYS.map(() => "?").join(", ")})`)
      .all(...ALL_KEYS) as { key: string; value: string }[];
  } catch {
    return lastGood;
  }
  const map = new Map(rows.map((r) => [r.key, r.value]));
  const trustedProxies = parseList(map.get(KEYS.trustedProxies));
  const teamDomain = text(map.get(KEYS.accessTeamDomain));
  const audience = text(map.get(KEYS.accessAudience));
  const verifiedAt = Number(map.get(KEYS.accessVerifiedAt));
  const config: NetworkConfig = {
    storedPolicy: parsePolicy(map.get(KEYS.policy)),
    publicUrls: parseList(map.get(KEYS.publicUrls)),
    trustedProxies,
    trustedCidrs: trustedProxies.map((p) => parseCidr(p)).filter((c): c is Cidr => c !== null),
    tunnelMode: parseMode(map.get(KEYS.tunnelMode)),
    tunnelTokenEnc: text(map.get(KEYS.tunnelToken)),
    tunnelAutostart: map.get(KEYS.tunnelAutostart) === "1",
    access: teamDomain && audience ? { teamDomain, audience } : null,
    accessTeamDomain: teamDomain,
    accessAudience: audience,
    accessVerifiedAt: Number.isFinite(verifiedAt) && verifiedAt > 0 ? verifiedAt : null,
    serveUrl: text(map.get(KEYS.serveUrl)),
  };
  lastGood = config;
  return config;
}

export function policyLockedByEnv(): boolean {
  return (readEnv("ACCESS_POLICY") ?? "").trim().toLowerCase() === "open";
}

export function effectivePolicy(config: NetworkConfig = loadNetworkConfig()): AccessPolicy {
  return policyLockedByEnv() ? { ...OPEN_POLICY } : config.storedPolicy;
}

export function isOpenPolicy(policy: AccessPolicy): boolean {
  return (
    policy.allowLan && policy.allowTailnet && policy.allowCloudflare && !policy.requireCloudflareAccess
  );
}

export function samePolicy(a: AccessPolicy, b: AccessPolicy): boolean {
  return (Object.keys(OPEN_POLICY) as (keyof AccessPolicy)[]).every((k) => a[k] === b[k]);
}

export function savePolicy(policy: AccessPolicy): void {
  const clean: AccessPolicy = {
    allowLan: policy.allowLan,
    allowTailnet: policy.allowTailnet,
    allowCloudflare: policy.allowCloudflare,
    requireCloudflareAccess: policy.requireCloudflareAccess,
    restrictAppApis: policy.restrictAppApis,
  };
  settings.set(KEYS.policy, JSON.stringify(clean));
}

export function savePublicUrls(urls: string[]): void {
  settings.set(KEYS.publicUrls, JSON.stringify(urls));
}

export function saveTrustedProxies(proxies: string[]): void {
  settings.set(KEYS.trustedProxies, JSON.stringify(proxies));
}

export function saveTunnelMode(mode: CloudflareTunnelMode): void {
  settings.set(KEYS.tunnelMode, mode);
}

export function saveTunnelTokenEnc(enc: string | null): void {
  settings.set(KEYS.tunnelToken, enc ?? "");
}

export function saveTunnelAutostart(on: boolean): void {
  settings.set(KEYS.tunnelAutostart, on ? "1" : "0");
}

export function saveAccessConfig(access: AccessConfig | null): void {
  settings.set(KEYS.accessTeamDomain, access?.teamDomain ?? "");
  settings.set(KEYS.accessAudience, access?.audience ?? "");
  settings.set(KEYS.accessVerifiedAt, "");
}

export function markAccessVerified(at: number): void {
  settings.set(KEYS.accessVerifiedAt, String(at));
}

export function saveServeUrl(url: string | null): void {
  settings.set(KEYS.serveUrl, url ?? "");
}
