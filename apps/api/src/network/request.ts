import type { Context } from "hono";
import { getConnInfo } from "hono/bun";
import { env, readEnv } from "../env";
import { loadNetworkConfig } from "./config";
import { cidrContains, formatIp, isLoopbackIp, parseIp, type Cidr, type ParsedIp } from "./ip";

export interface Peer {
  address: string | null;
  port: number | null;
}

export interface RequestFacts {
  peer: ParsedIp | null;
  peerPort: number | null;
  peerTrusted: boolean;
  peerLoopback: boolean;
  proxyHeaders: boolean;
  loopbackTrusted: boolean;
  namedHost: string | null;
  client: ParsedIp | null;
  clientIp: string;
  secure: boolean;
  https: boolean;
}

export const PROXY_HEADERS = [
  "x-forwarded-for",
  "x-forwarded-proto",
  "x-forwarded-host",
  "x-real-ip",
  "forwarded",
  "cf-connecting-ip",
  "cf-ray",
  "cf-visitor",
  "cf-access-jwt-assertion",
  "tailscale-user-login",
  "tailscale-funnel-request",
] as const;

export const UNKNOWN_CLIENT = "unknown";

const peerCache = new WeakMap<object, Peer | null>();
const factsCache = new WeakMap<object, RequestFacts>();
const resolvedClient = new WeakMap<object, string>();
const OFF_VALUES = new Set(["0", "false", "no", "off"]);
const SHOWN_HOST = /^[a-z0-9._:\[\]-]{1,100}$/i;

export interface LoopbackForwarding {
  host: string;
  count: number;
  firstAt: number;
  lastAt: number;
}

let forwarding: LoopbackForwarding | null = null;

export function loopbackTrusted(): boolean {
  return !OFF_VALUES.has((readEnv("TRUST_LOOPBACK") ?? "").trim().toLowerCase());
}

export function isTrustedProxy(ip: ParsedIp, trusted: readonly Cidr[], loopback: boolean = loopbackTrusted()): boolean {
  return (loopback && isLoopbackIp(ip)) || trusted.some((c) => cidrContains(c, ip));
}

export function isLoopbackHostName(name: string): boolean {
  const host = name.trim().toLowerCase().replace(/\.$/, "");
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  const ip = parseIp(host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host);
  return ip !== null && isLoopbackIp(ip);
}

function hostHeaderName(raw: string | null): string | null {
  if (raw === null) return null;
  const value = raw.trim();
  if (!value) return null;
  const match = /^(\[[^\]]*\])(?::\d*)?$/.exec(value) ?? /^([^:]*)(?::\d*)?$/.exec(value);
  return match ? match[1]! : value;
}

function urlHostName(raw: string | null): string | null {
  if (raw === null) return null;
  const value = raw.trim();
  if (!value || value === "null") return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.hostname;
  } catch {
    return null;
  }
}

function nonLoopbackName(headers: Headers): string | null {
  for (const name of [hostHeaderName(headers.get("host")), urlHostName(headers.get("origin")), urlHostName(headers.get("referer"))]) {
    if (name !== null && !isLoopbackHostName(name)) return name;
  }
  return null;
}

export function hasLoopbackHostEvidence(facts: RequestFacts): boolean {
  return facts.peerLoopback && facts.loopbackTrusted && !facts.proxyHeaders && facts.namedHost !== null;
}

export function noteLoopbackForwarding(host: string, now: number = Date.now()): void {
  const shown = SHOWN_HOST.test(host) ? host.toLowerCase() : "another name";
  if (forwarding) {
    forwarding.count++;
    forwarding.lastAt = now;
    forwarding.host = shown;
    return;
  }
  forwarding = { host: shown, count: 1, firstAt: now, lastAt: now };
  console.warn(
    `[network] a request from this machine was addressed to ${shown}; treating loopback requests that name another host as coming from the local network`,
  );
}

export function loopbackForwardingSeen(): LoopbackForwarding | null {
  return forwarding ? { ...forwarding } : null;
}

export function resetLoopbackForwarding(): void {
  forwarding = null;
}

function forwardedFor(headers: Headers): string[] {
  const raw = headers.get("x-forwarded-for");
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function resolveClient(peer: ParsedIp, headers: Headers, trusted: readonly Cidr[], loopback: boolean): ParsedIp {
  const chain = forwardedFor(headers);
  if (chain.length === 0) {
    const cf = parseIp(headers.get("cf-connecting-ip"));
    return cf ?? peer;
  }
  let client = peer;
  for (let i = chain.length - 1; i >= 0; i--) {
    const hop = parseIp(chain[i]);
    if (!hop) break;
    client = hop;
    if (!isTrustedProxy(hop, trusted, loopback)) break;
  }
  return client;
}

function forwardedProto(headers: Headers): string | null {
  const xfp = headers.get("x-forwarded-proto");
  if (xfp) return xfp.split(",")[0]!.trim().toLowerCase();
  const visitor = headers.get("cf-visitor");
  if (visitor) {
    try {
      const scheme = (JSON.parse(visitor) as { scheme?: unknown }).scheme;
      if (typeof scheme === "string") return scheme.toLowerCase();
    } catch {
      return null;
    }
  }
  return null;
}

export function computeFacts(
  input: { headers: Headers; peer: Peer | null; url: string },
  trusted: readonly Cidr[],
): RequestFacts {
  const peer = parseIp(input.peer?.address ?? null);
  const loopback = loopbackTrusted();
  const peerTrusted = peer !== null && isTrustedProxy(peer, trusted, loopback);
  const proxyHeaders = PROXY_HEADERS.some((h) => input.headers.has(h)) || hasCloudflareEvidence(input.headers);
  const client = peer === null ? null : peerTrusted ? resolveClient(peer, input.headers, trusted, loopback) : peer;
  const peerLoopback = peer !== null && isLoopbackIp(peer);
  let urlHttps = false;
  try {
    urlHttps = new URL(input.url).protocol === "https:";
  } catch {
    urlHttps = false;
  }
  const https = urlHttps || (peerTrusted && forwardedProto(input.headers) === "https");
  const secure = env.cookieSecure || https;
  return {
    peer,
    peerPort: input.peer?.port ?? null,
    peerTrusted,
    peerLoopback,
    proxyHeaders,
    loopbackTrusted: loopback,
    namedHost: peerLoopback ? nonLoopbackName(input.headers) : null,
    client,
    clientIp: client ? formatIp(client) : UNKNOWN_CLIENT,
    secure,
    https,
  };
}

export function peerOf(c: Context): Peer | null {
  if (peerCache.has(c)) return peerCache.get(c) ?? null;
  let peer: Peer | null;
  try {
    const info = getConnInfo(c);
    peer = info.remote.address ? { address: info.remote.address, port: info.remote.port ?? null } : null;
  } catch {
    peer = null;
  }
  peerCache.set(c, peer);
  return peer;
}

export function requestFacts(c: Context, trusted?: readonly Cidr[]): RequestFacts {
  const cached = factsCache.get(c);
  if (cached) return cached;
  const facts = computeFacts(
    { headers: c.req.raw.headers, peer: peerOf(c), url: c.req.url },
    trusted ?? loadNetworkConfig().trustedCidrs,
  );
  factsCache.set(c, facts);
  return facts;
}

export function rememberClientIp(c: Context, ip: string): void {
  resolvedClient.set(c, ip);
}

export function clientIp(c: Context): string {
  return resolvedClient.get(c) ?? requestFacts(c).clientIp;
}

export function isSecureRequest(c: Context): boolean {
  return requestFacts(c).secure;
}

export function isLocalFacts(facts: RequestFacts): boolean {
  return facts.peerLoopback && facts.loopbackTrusted && !facts.proxyHeaders && facts.namedHost === null;
}

export function isLocalRequest(c: Context): boolean {
  return isLocalFacts(requestFacts(c));
}

export function hasCloudflareEvidence(headers: Headers): boolean {
  for (const [name] of headers) {
    if (name.toLowerCase().startsWith("cf-")) return true;
  }
  return false;
}

export function hasFunnelEvidence(headers: Headers): boolean {
  return headers.has("tailscale-funnel-request");
}
