export type IpFamily = 4 | 6;

export interface ParsedIp {
  family: IpFamily;
  bytes: Uint8Array;
}

export interface Cidr {
  family: IpFamily;
  bytes: Uint8Array;
  prefix: number;
}

function parseV4(s: string): Uint8Array | null {
  const parts = s.split(".");
  if (parts.length !== 4) return null;
  const out = new Uint8Array(4);
  for (let i = 0; i < 4; i++) {
    const part = parts[i]!;
    if (!/^(0|[1-9]\d{0,2})$/.test(part)) return null;
    const n = Number(part);
    if (n > 255) return null;
    out[i] = n;
  }
  return out;
}

function parseV6(input: string): Uint8Array | null {
  let s = input;
  const zone = s.indexOf("%");
  if (zone >= 0) s = s.slice(0, zone);
  if (!s.includes(":")) return null;
  const lastColon = s.lastIndexOf(":");
  const tail = s.slice(lastColon + 1);
  if (tail.includes(".")) {
    const v4 = parseV4(tail);
    if (!v4) return null;
    const hi = ((v4[0]! << 8) | v4[1]!).toString(16);
    const lo = ((v4[2]! << 8) | v4[3]!).toString(16);
    s = `${s.slice(0, lastColon + 1)}${hi}:${lo}`;
  }
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const rest = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  let words: string[];
  if (halves.length === 1) {
    if (head.length !== 8) return null;
    words = head;
  } else {
    const missing = 8 - head.length - rest.length;
    if (missing < 1) return null;
    words = [...head, ...new Array<string>(missing).fill("0"), ...rest];
  }
  const out = new Uint8Array(16);
  for (let i = 0; i < 8; i++) {
    const word = words[i]!;
    if (!/^[0-9a-fA-F]{1,4}$/.test(word)) return null;
    const n = parseInt(word, 16);
    out[i * 2] = n >> 8;
    out[i * 2 + 1] = n & 0xff;
  }
  return out;
}

function unmapV4(bytes: Uint8Array): Uint8Array | null {
  for (let i = 0; i < 10; i++) if (bytes[i] !== 0) return null;
  if (bytes[10] !== 0xff || bytes[11] !== 0xff) return null;
  return bytes.slice(12);
}

export function parseIp(raw: string | null | undefined): ParsedIp | null {
  if (!raw) return null;
  let s = raw.trim();
  if (s.startsWith("[") && s.endsWith("]")) s = s.slice(1, -1);
  if (!s || s.length > 64) return null;
  if (s.includes(":")) {
    const bytes = parseV6(s);
    if (!bytes) return null;
    const v4 = unmapV4(bytes);
    return v4 ? { family: 4, bytes: v4 } : { family: 6, bytes };
  }
  const bytes = parseV4(s);
  return bytes ? { family: 4, bytes } : null;
}

export function formatIp(ip: ParsedIp): string {
  if (ip.family === 4) return Array.from(ip.bytes).join(".");
  const words: number[] = [];
  for (let i = 0; i < 8; i++) words.push((ip.bytes[i * 2]! << 8) | ip.bytes[i * 2 + 1]!);
  let bestStart = -1;
  let bestLen = 0;
  for (let i = 0; i < 8; ) {
    if (words[i] !== 0) {
      i++;
      continue;
    }
    let j = i;
    while (j < 8 && words[j] === 0) j++;
    if (j - i > bestLen && j - i > 1) {
      bestStart = i;
      bestLen = j - i;
    }
    i = j;
  }
  const hex = words.map((w) => w.toString(16));
  if (bestStart < 0) return hex.join(":");
  const left = hex.slice(0, bestStart).join(":");
  const right = hex.slice(bestStart + bestLen).join(":");
  return `${left}::${right}`;
}

export function normalizeIp(raw: string | null | undefined): string | null {
  const ip = parseIp(raw);
  return ip ? formatIp(ip) : null;
}

export function parseCidr(raw: string): Cidr | null {
  const s = raw.trim();
  const slash = s.indexOf("/");
  const ip = parseIp(slash >= 0 ? s.slice(0, slash) : s);
  if (!ip) return null;
  const max = ip.family === 4 ? 32 : 128;
  let prefix = max;
  if (slash >= 0) {
    const p = s.slice(slash + 1);
    if (!/^\d{1,3}$/.test(p)) return null;
    prefix = Number(p);
    const mappedV4 = ip.family === 4 && s.slice(0, slash).includes(":");
    if (mappedV4) prefix -= 96;
    if (prefix < 0 || prefix > max) return null;
  }
  const bytes = ip.bytes.slice();
  for (let bit = prefix; bit < max; bit++) {
    bytes[bit >> 3] = bytes[bit >> 3]! & ~(0x80 >> (bit & 7));
  }
  return { family: ip.family, bytes, prefix };
}

export function formatCidr(cidr: Cidr): string {
  const max = cidr.family === 4 ? 32 : 128;
  const base = formatIp({ family: cidr.family, bytes: cidr.bytes });
  return cidr.prefix === max ? base : `${base}/${cidr.prefix}`;
}

export function cidrContains(cidr: Cidr, ip: ParsedIp): boolean {
  if (cidr.family !== ip.family) return false;
  const full = cidr.prefix >> 3;
  for (let i = 0; i < full; i++) if (cidr.bytes[i] !== ip.bytes[i]) return false;
  const rem = cidr.prefix & 7;
  if (rem === 0) return true;
  const mask = (0xff << (8 - rem)) & 0xff;
  return (cidr.bytes[full]! & mask) === (ip.bytes[full]! & mask);
}

const LOOPBACK = [parseCidr("127.0.0.0/8")!, parseCidr("::1/128")!];
const TAILNET = [parseCidr("100.64.0.0/10")!, parseCidr("fd7a:115c:a1e0::/48")!];

export function isLoopbackIp(ip: ParsedIp): boolean {
  return LOOPBACK.some((c) => cidrContains(c, ip));
}

export function isTailnetIp(ip: ParsedIp): boolean {
  return TAILNET.some((c) => cidrContains(c, ip));
}
