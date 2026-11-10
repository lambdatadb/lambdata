import type { Context } from "hono";
import type { IngressKind } from "@lambdata/shared";
import { tailscaleRuntime, tailscaleWhois } from "../tailscale/cli";
import { loadNetworkConfig, type AccessConfig } from "./config";
import { verifyAccessToken, accessVerifierFor, type AccessVerification } from "./cfAccess";
import { formatIp, isLoopbackIp, isTailnetIp, parseIp, type Cidr } from "./ip";
import {
  UNKNOWN_CLIENT,
  computeFacts,
  hasCloudflareEvidence,
  hasFunnelEvidence,
  noteLoopbackForwarding,
  peerOf,
  rememberClientIp,
  requestFacts,
  type Peer,
  type RequestFacts,
} from "./request";

export interface IngressInfo {
  ingress: IngressKind;
  checks: IngressKind[];
  clientIp: string;
  peerIp: string;
  accessVerified: boolean;
  accessEmail: string | null;
  accessError: string | null;
  hasAccessAssertion: boolean;
  funnel: boolean;
  untrustedProxy: boolean;
  forwardedHost: string | null;
}

export interface ClassifyOverrides {
  trustedCidrs?: readonly Cidr[];
  access?: AccessConfig | null;
}

const ACCESS_HEADER = "cf-access-jwt-assertion";
const cache = new WeakMap<object, Promise<IngressInfo>>();

export function needsUserspaceLookup(facts: RequestFacts): boolean {
  if (!facts.peerLoopback || facts.proxyHeaders || facts.peer === null || facts.peerPort === null) return false;
  const rt = tailscaleRuntime();
  return rt.running && rt.userspace;
}

async function userspaceTailnetPeer(facts: RequestFacts): Promise<string | null> {
  if (!needsUserspaceLookup(facts) || facts.peer === null) return null;
  const host = facts.peer.family === 6 ? `[${formatIp(facts.peer)}]` : formatIp(facts.peer);
  const ip = parseIp(await tailscaleWhois(`${host}:${facts.peerPort}`));
  return ip && isTailnetIp(ip) ? formatIp(ip) : null;
}

interface Base {
  kind: IngressKind;
  clientIp?: string;
  forwardedHost?: string;
}

function asLoopback(facts: RequestFacts): Base {
  if (!facts.loopbackTrusted) return { kind: "lan" };
  if (facts.namedHost !== null) return { kind: "lan", forwardedHost: facts.namedHost };
  return { kind: "loopback" };
}

async function baseIngress(headers: Headers, facts: RequestFacts, cloudflare: boolean, funnel: boolean): Promise<Base> {
  const peer = facts.peer;
  if (!peer) return { kind: "lan" };
  if (!facts.peerTrusted) {
    if (isTailnetIp(peer)) return { kind: "tailnet" };
    const tailnetIp = await userspaceTailnetPeer(facts);
    return tailnetIp ? { kind: "tailnet", clientIp: tailnetIp } : { kind: "lan" };
  }
  const client = facts.client;
  if (client && isTailnetIp(client)) return { kind: "tailnet" };
  if (cloudflare) return { kind: "cloudflare" };
  if (!facts.peerLoopback) return { kind: "lan" };
  if (headers.has("tailscale-user-login") && !funnel) return { kind: "tailnet" };
  if (!facts.proxyHeaders) {
    const tailnetIp = await userspaceTailnetPeer(facts);
    return tailnetIp ? { kind: "tailnet", clientIp: tailnetIp } : asLoopback(facts);
  }
  if (!funnel && headers.has("x-forwarded-for") && client && isLoopbackIp(client)) return asLoopback(facts);
  return { kind: "lan" };
}

export async function classifyParts(
  headers: Headers,
  facts: RequestFacts,
  access: AccessConfig | null,
  fresh = false,
): Promise<IngressInfo> {
  const assertion = headers.get(ACCESS_HEADER);
  let verification: AccessVerification | null = null;
  if (assertion && access) {
    verification = fresh
      ? await accessVerifierFor(access, true).verify(assertion)
      : await verifyAccessToken(access, assertion);
  }
  const cloudflare = hasCloudflareEvidence(headers);
  const funnel = hasFunnelEvidence(headers);
  const base = await baseIngress(headers, facts, cloudflare, funnel);
  const internet = (cloudflare || funnel) && base.kind !== "cloudflare";
  const checks: IngressKind[] = internet ? ["cloudflare", base.kind] : [base.kind];
  return {
    ingress: checks[0]!,
    checks,
    clientIp: base.clientIp ?? facts.clientIp,
    peerIp: facts.peer ? formatIp(facts.peer) : UNKNOWN_CLIENT,
    accessVerified: verification?.ok === true,
    accessEmail: verification?.ok ? verification.email : null,
    accessError: verification && !verification.ok ? verification.error : null,
    hasAccessAssertion: assertion !== null,
    funnel,
    untrustedProxy: (cloudflare || funnel) && !facts.peerTrusted,
    forwardedHost: base.forwardedHost ?? null,
  };
}

function remember(info: IngressInfo): IngressInfo {
  if (info.forwardedHost !== null) noteLoopbackForwarding(info.forwardedHost);
  return info;
}

export async function classifyRaw(
  req: Request,
  peer: Peer | null,
  overrides: ClassifyOverrides = {},
): Promise<IngressInfo> {
  const config = loadNetworkConfig();
  const trusted = overrides.trustedCidrs ?? config.trustedCidrs;
  const access = overrides.access !== undefined ? overrides.access : config.access;
  const facts = computeFacts({ headers: req.headers, peer, url: req.url }, trusted);
  return remember(await classifyParts(req.headers, facts, access));
}

export function classifyRequest(c: Context, overrides?: ClassifyOverrides): Promise<IngressInfo> {
  if (overrides) {
    const config = loadNetworkConfig();
    const trusted = overrides.trustedCidrs ?? config.trustedCidrs;
    const access = overrides.access !== undefined ? overrides.access : config.access;
    const facts = computeFacts({ headers: c.req.raw.headers, peer: peerOf(c), url: c.req.url }, trusted);
    return classifyParts(c.req.raw.headers, facts, access, overrides.access !== undefined);
  }
  const cached = cache.get(c);
  if (cached) return cached;
  const facts = requestFacts(c);
  const pending = classifyParts(c.req.raw.headers, facts, loadNetworkConfig().access).then((info) => {
    if (info.clientIp !== facts.clientIp) rememberClientIp(c, info.clientIp);
    return remember(info);
  });
  cache.set(c, pending);
  return pending;
}
