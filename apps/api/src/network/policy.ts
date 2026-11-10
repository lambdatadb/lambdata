import type { AccessPolicy, IngressKind } from "@lambdata/shared";
import type { IngressInfo } from "./classify";

export interface Verdict {
  allowed: boolean;
  message: string | null;
}

const INGRESS_LABEL: Record<IngressKind, string> = {
  loopback: "this machine (loopback)",
  lan: "the local network (LAN)",
  tailnet: "your tailnet",
  cloudflare: "Cloudflare",
};

export function describeIngress(kind: IngressKind): string {
  return INGRESS_LABEL[kind];
}

export function isExemptPath(path: string): boolean {
  return path === "/api/health" || path === "/api/health/";
}

function under(path: string, prefix: string): boolean {
  return path === prefix || path.startsWith(`${prefix}/`);
}

export function isAppFacingPath(path: string, method: string): boolean {
  if (under(path, "/api/data")) return true;
  if (under(path, "/functions/v1") || under(path, "/api/functions/v1")) return true;
  if (path === "/api/app-auth/signup" || path === "/api/app-auth/token" || path === "/api/app-auth/user") return true;
  if (path === "/api/realtime/broadcast" || under(path, "/api/realtime/v1")) return true;
  if ((method === "GET" || method === "HEAD") && path.startsWith("/api/storage/public/")) return true;
  return false;
}

const ALLOWED: Verdict = { allowed: true, message: null };

function ruleFor(policy: AccessPolicy, kind: IngressKind, info: IngressInfo): Verdict {
  switch (kind) {
    case "loopback":
      return ALLOWED;
    case "lan":
      if (policy.allowLan) return ALLOWED;
      if (info.funnel) {
        return {
          allowed: false,
          message: "This connection came through Tailscale Funnel, so it must pass the rules for both the internet and the local network, and this server does not accept connections from the local network.",
        };
      }
      if (info.ingress !== "lan") {
        return {
          allowed: false,
          message: `This connection carries Cloudflare headers but came from ${info.peerIp}, which LambData does not trust as a proxy, so it must also pass the rule for the local network, and this server does not accept connections from the local network. An admin can add that address under Network, trusted proxies.`,
        };
      }
      return { allowed: false, message: "This LambData server does not accept connections from the local network." };
    case "tailnet":
      return policy.allowTailnet
        ? ALLOWED
        : { allowed: false, message: "This LambData server does not accept connections over Tailscale." };
    case "cloudflare":
      if (!policy.allowCloudflare) {
        return {
          allowed: false,
          message: info.funnel
            ? "This LambData server does not accept connections from the internet (this one came through Tailscale Funnel)."
            : "This LambData server does not accept connections through Cloudflare.",
        };
      }
      if (policy.requireCloudflareAccess && !info.accessVerified) {
        return {
          allowed: false,
          message: info.funnel
            ? "This LambData server requires a verified Cloudflare Access session for connections from the internet (this one came through Tailscale Funnel)."
            : "This LambData server requires a verified Cloudflare Access session for connections through Cloudflare.",
        };
      }
      return ALLOWED;
  }
  return { allowed: false, message: "This connection is not allowed." };
}

export function evaluateAccess(policy: AccessPolicy, info: IngressInfo, path: string, method: string): Verdict {
  if (isExemptPath(path) || info.ingress === "loopback") return ALLOWED;
  if (!policy.restrictAppApis && isAppFacingPath(path, method)) return ALLOWED;
  const checks = info.checks.length > 0 ? info.checks : [info.ingress];
  for (const kind of checks) {
    const verdict = ruleFor(policy, kind, info);
    if (!verdict.allowed) return verdict;
  }
  return ALLOWED;
}

export function describeConnection(info: IngressInfo): string {
  if (info.funnel) return "Tailscale Funnel (the public internet)";
  const via = describeIngress(info.ingress);
  if (info.checks.length > 1) {
    const others = info.checks.filter((k) => k !== info.ingress).map(describeIngress).join(" and ");
    return `${via}, through an untrusted proxy at ${info.peerIp} (so the rule for ${others} applies too)`;
  }
  return via;
}

export function lockoutMessage(info: IngressInfo, verdict: Verdict, action: string): string {
  const via = describeConnection(info);
  const extra =
    info.ingress === "cloudflare" && !info.accessVerified
      ? info.hasAccessAssertion
        ? ` without a verified Cloudflare Access token (${info.accessError ?? "verification failed"})`
        : " without a Cloudflare Access token"
      : "";
  const reason = verdict.message ? ` ${verdict.message}` : "";
  return `Refusing to ${action}: you are connected via ${via}${extra} from ${info.clientIp}, and the new settings would block this connection.${reason} Make the change from a connection the new settings allow, or allow ${describeIngress(info.ingress)} too.`;
}
