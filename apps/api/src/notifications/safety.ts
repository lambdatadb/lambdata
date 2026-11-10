import { lookup } from "node:dns/promises";
import { checkServerIdentity } from "node:tls";
import { env } from "../env";
import { cidrContains, formatIp, isLoopbackIp, parseCidr, parseIp, type Cidr, type ParsedIp } from "../network/ip";

export const RESOLVE_TIMEOUT_MS = 3_000;

export const notificationTransport = {
  async resolve(host: string): Promise<string[]> {
    const found = await lookup(host, { all: true, verbatim: true });
    return found.map((r) => r.address);
  },
  fetch(url: string, init: BunFetchRequestInit): Promise<Response> {
    return fetch(url, init);
  },
};

export class UnsafeDestinationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsafeDestinationError";
  }
}

function cidrs(list: string[]): Cidr[] {
  return list.map((c) => parseCidr(c)!);
}

const REFUSED: { label: string; ranges: Cidr[] }[] = [
  { label: "a link-local address", ranges: cidrs(["169.254.0.0/16", "fe80::/10"]) },
  { label: "a cloud metadata address", ranges: cidrs(["100.100.100.200/32", "fd00:ec2::254/128"]) },
  { label: "the unspecified address", ranges: cidrs(["0.0.0.0/8", "::/128"]) },
  { label: "a multicast address", ranges: cidrs(["224.0.0.0/4", "ff00::/8"]) },
  { label: "a reserved address", ranges: cidrs(["240.0.0.0/4", "::/96"]) },
];

const PRIVATE = cidrs([
  "10.0.0.0/8",
  "172.16.0.0/12",
  "192.168.0.0/16",
  "127.0.0.0/8",
  "100.64.0.0/10",
  "::1/128",
  "fc00::/7",
]);

const NAT64 = parseCidr("64:ff9b::/96")!;

function embeddedV4(ip: ParsedIp): ParsedIp | null {
  if (ip.family === 6 && cidrContains(NAT64, ip)) return { family: 4, bytes: ip.bytes.slice(12) };
  return null;
}

export function refusedReason(ip: ParsedIp, port: number): string | null {
  const inner = embeddedV4(ip);
  if (inner) return refusedReason(inner, port);
  if (isLoopbackIp(ip)) {
    return port === env.port ? "LambData's own API port" : null;
  }
  for (const group of REFUSED) {
    if (group.ranges.some((c) => cidrContains(c, ip))) return group.label;
  }
  return null;
}

export function isPrivateIp(ip: ParsedIp): boolean {
  const inner = embeddedV4(ip) ?? ip;
  return PRIVATE.some((c) => cidrContains(c, inner));
}

export function portOf(url: URL): number {
  if (url.port) return Number(url.port);
  return url.protocol === "https:" ? 443 : 80;
}

function hostOf(url: URL): string {
  const h = url.hostname;
  return h.startsWith("[") && h.endsWith("]") ? h.slice(1, -1) : h;
}

function isLocalhostName(host: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, "");
  return h === "localhost" || h.endsWith(".localhost");
}

export function parseOutboundUrl(raw: string, label = "URL"): URL {
  if (typeof raw !== "string" || raw.length === 0) throw new UnsafeDestinationError(`${label} is required`);
  if (raw.length > 2048) throw new UnsafeDestinationError(`${label} is too long`);
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new UnsafeDestinationError(`${label} is not a valid address`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new UnsafeDestinationError(`${label} must start with http:// or https://`);
  }
  if (url.username || url.password) throw new UnsafeDestinationError(`${label} must not contain a user name or password`);
  if (!url.hostname) throw new UnsafeDestinationError(`${label} must include a host`);
  return url;
}

export function literalCheck(url: URL, label = "URL"): ParsedIp | null {
  const host = hostOf(url);
  const port = portOf(url);
  if (isLocalhostName(host)) {
    if (port === env.port) throw new UnsafeDestinationError(`${label} points at LambData's own API port`);
    return parseIp("127.0.0.1");
  }
  const ip = parseIp(host);
  if (!ip) return null;
  const reason = refusedReason(ip, port);
  if (reason) throw new UnsafeDestinationError(`${label} points at ${reason}, which is not allowed`);
  return ip;
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const cap = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("timed out")), ms);
    (timer as { unref?: () => void }).unref?.();
  });
  return Promise.race([p, cap]).finally(() => clearTimeout(timer));
}

export async function resolveAddresses(url: URL): Promise<ParsedIp[]> {
  const host = hostOf(url);
  const literal = literalCheck(url);
  if (literal) return [literal];
  const raw = await withTimeout(notificationTransport.resolve(host), RESOLVE_TIMEOUT_MS);
  const out: ParsedIp[] = [];
  for (const a of raw) {
    const ip = parseIp(a);
    if (ip) out.push(ip);
  }
  if (out.length === 0) throw new Error("host not found");
  return out;
}

export function assertAddressesAllowed(url: URL, addresses: ParsedIp[], label = "URL"): void {
  const port = portOf(url);
  for (const ip of addresses) {
    const reason = refusedReason(ip, port);
    if (reason) throw new UnsafeDestinationError(`${label} resolves to ${reason}, which is not allowed`);
  }
}

export async function checkAtSave(url: URL, label = "URL"): Promise<ParsedIp[] | null> {
  literalCheck(url, label);
  let addresses: ParsedIp[];
  try {
    addresses = await resolveAddresses(url);
  } catch (err) {
    if (err instanceof UnsafeDestinationError) throw err;
    return null;
  }
  assertAddressesAllowed(url, addresses, label);
  return addresses;
}

export async function checkAtSend(url: URL): Promise<ParsedIp[]> {
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new UnsafeDestinationError("only http and https are allowed");
  const addresses = await resolveAddresses(url);
  assertAddressesAllowed(url, addresses);
  return addresses;
}

export interface PinnedTarget {
  url: string;
  headers: Record<string, string>;
  tls?: BunFetchRequestInit["tls"];
}

export function pinTarget(url: URL, addresses: ParsedIp[]): PinnedTarget {
  const host = hostOf(url);
  const ip = [...addresses].sort((a, b) => a.family - b.family)[0];
  if (parseIp(host) || !ip) return { url: url.toString(), headers: {} };
  const connect = new URL(url.toString());
  connect.hostname = ip.family === 6 ? `[${formatIp(ip)}]` : formatIp(ip);
  const pinned: PinnedTarget = { url: connect.toString(), headers: { Host: url.host } };
  if (url.protocol === "https:") {
    pinned.tls = { serverName: host, checkServerIdentity: (_name, cert) => checkServerIdentity(host, cert) };
  }
  return pinned;
}

const DISCORD_HOSTS = new Set(["discord.com", "discordapp.com"]);

export function assertDiscordUrl(url: URL): void {
  const ok =
    url.protocol === "https:" &&
    DISCORD_HOSTS.has(url.hostname.toLowerCase()) &&
    url.port === "" &&
    /^\/api\/webhooks\/[^/]+\/[^/]+/.test(url.pathname);
  if (!ok) {
    throw new UnsafeDestinationError(
      "Discord webhook URL must look like https://discord.com/api/webhooks/… (copy it from the channel's Integrations → Webhooks)",
    );
  }
}

export function isPrivateHost(url: URL, resolved: ParsedIp[] | null): boolean {
  const host = hostOf(url);
  if (isLocalhostName(host)) return true;
  const ip = parseIp(host);
  if (ip) return isPrivateIp(ip);
  return resolved !== null && resolved.length > 0 && resolved.every(isPrivateIp);
}

const HEADER_NAME = /^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,100}$/;
const FORBIDDEN_HEADERS = new Set([
  "host",
  "content-length",
  "content-type",
  "user-agent",
  "transfer-encoding",
  "connection",
  "keep-alive",
  "upgrade",
  "te",
  "trailer",
  "proxy-connection",
]);
export const MAX_CUSTOM_HEADERS = 10;

export function headerNameProblem(name: string): string | null {
  if (!HEADER_NAME.test(name)) return `header name "${name.slice(0, 40)}" is not valid`;
  const lower = name.toLowerCase();
  if (FORBIDDEN_HEADERS.has(lower)) return `header ${name} cannot be set`;
  if (lower.startsWith("x-lambdata-")) return `headers starting with X-LambData- are reserved`;
  return null;
}

export function headerValueProblem(name: string, value: string): string | null {
  if (value.length > 2000) return `header ${name} is too long`;
  if (/[\u0000-\u0008\u000a-\u001f\u007f]/.test(value)) return `header ${name} contains characters that are not allowed`;
  return null;
}
