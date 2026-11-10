import type { Context } from "hono";
import type { CloudflareTunnelStatus, NetworkStatus, TailscaleServeStatus } from "@lambdata/shared";
import { env } from "../env";
import { tailscaleServeStatus, tailscaleStatus } from "../tailscale/cli";
import { effectivePolicy, loadNetworkConfig, policyLockedByEnv, saveServeUrl, type NetworkConfig } from "./config";
import { classifyRequest, type IngressInfo } from "./classify";
import { loopbackForwardingSeen, loopbackTrusted, type LoopbackForwarding } from "./request";
import { cloudflaredBinary, cloudflaredVersion, tunnelConnections, tunnelDesired, tunnelState } from "./cloudflared";

export async function tunnelStatus(config: NetworkConfig): Promise<CloudflareTunnelStatus> {
  const bin = cloudflaredBinary();
  const version = bin ? await cloudflaredVersion(bin) : null;
  const proc = tunnelState();
  return {
    mode: config.tunnelMode,
    installed: bin !== null,
    version,
    tokenConfigured: config.tunnelTokenEnc !== null,
    running: proc.running,
    desired: tunnelDesired(),
    connections: proc.running ? await tunnelConnections() : null,
    lastError: proc.lastError,
    startedAt: proc.startedAt,
  };
}

export async function serveStatus(installedAndRunning: boolean, config: NetworkConfig): Promise<TailscaleServeStatus> {
  if (!installedAndRunning) return { supported: false, enabled: false, url: null };
  const serve = await tailscaleServeStatus(env.port);
  if (serve.supported && serve.url !== config.serveUrl) {
    try {
      saveServeUrl(serve.url);
    } catch {
      return serve;
    }
  }
  return serve;
}

export const EXTERNAL_TUNNEL_UNTRUSTED_WARNING =
  "Cloudflare Tunnel is set to “Running elsewhere” but no trusted proxy is set. LambData cannot tell your cloudflared's traffic from LAN traffic, so tunnel visitors must pass both the LAN and the Cloudflare rules, and every visitor appears to come from the cloudflared container's address. Add that address under trusted proxies.";

export function loopbackForwardingWarning(seen: LoopbackForwarding): string {
  return `LambData has received ${seen.count} request(s) from this machine addressed to ${seen.host}, which is not a name of this machine. Something on this machine is forwarding remote traffic to LambData without adding forwarding headers, so LambData treats those requests as coming from the local network, never as local, and asks them for the setup token. If that forwarder is yours, make it add X-Forwarded-For (a proxy on another address must also be listed under trusted proxies), or set LAMBDATA_TRUST_LOOPBACK=0 so that no connection from this machine is treated as local.`;
}

export const APP_APIS_OPEN_WARNING =
  "Cloudflare Access is required for the console, but app-facing APIs are not restricted: the Data API, App Auth, functions and realtime endpoints (and public Storage files) can still be reached through Cloudflare without an Access session, protected only by their own tokens and policies. To put them behind Access too, turn on “Also restrict app-facing APIs” under Network, access policy.";

export function networkWarnings(config: NetworkConfig, info: IngressInfo, policy = effectivePolicy(config)): string[] {
  const out: string[] = [];
  if (policy.allowCloudflare && policy.requireCloudflareAccess && !policy.restrictAppApis) out.push(APP_APIS_OPEN_WARNING);
  const seen = loopbackTrusted() ? loopbackForwardingSeen() : null;
  if (seen) out.push(loopbackForwardingWarning(seen));
  const externalUntrusted = config.tunnelMode === "external" && config.trustedCidrs.length === 0;
  if (externalUntrusted) out.push(EXTERNAL_TUNNEL_UNTRUSTED_WARNING);
  if (info.funnel) {
    out.push(
      "You are connected through Tailscale Funnel, which publishes LambData on the public internet. LambData applies both the Cloudflare rule and the rule for where Funnel delivered it. Turn Funnel off if you did not mean to publish the console.",
    );
  } else if (info.untrustedProxy && !externalUntrusted) {
    out.push(
      `This request carries Cloudflare headers but came from ${info.peerIp}, which is not a trusted proxy, so LambData applies both the Cloudflare rule and the LAN rule to it. If that address is your cloudflared, add it under trusted proxies.`,
    );
  }
  return out;
}

export async function buildNetworkStatus(c: Context): Promise<NetworkStatus> {
  const config = loadNetworkConfig();
  const [info, tunnel, tailscale] = await Promise.all([
    classifyRequest(c),
    tunnelStatus(config),
    tailscaleStatus(),
  ]);
  const serve = await serveStatus(tailscale.installed && tailscale.running, config);
  return {
    yourIngress: info.ingress,
    yourIp: info.clientIp,
    yourAccessVerified: info.accessVerified,
    warnings: networkWarnings(config, info),
    policy: effectivePolicy(config),
    policyLockedByEnv: policyLockedByEnv(),
    publicUrls: config.publicUrls,
    trustedProxies: config.trustedProxies,
    cloudflare: {
      tunnel,
      access: {
        teamDomain: config.accessTeamDomain,
        audience: config.accessAudience,
        configured: config.access !== null,
        lastVerifiedAt: config.accessVerifiedAt,
      },
    },
    tailscale: { ...tailscale, serve },
    bind: { host: env.host, port: env.port, mariadbBind: env.mariadbBind, mariadbPort: env.mariadbPort },
  };
}
