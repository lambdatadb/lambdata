import { cidrContains, parseCidr, parseIp, type ParsedIp } from "../network/ip";

function likeToRegExp(pattern: string): RegExp {
  let out = "";
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i]!;
    if (ch === "\\" && i + 1 < pattern.length) {
      out += pattern[++i]!.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    } else if (ch === "%") {
      out += ".*";
    } else if (ch === "_") {
      out += ".";
    } else {
      out += ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${out}$`, "i");
}

function maskPrefix(mask: ParsedIp): number | null {
  let prefix = 0;
  let ended = false;
  for (const byte of mask.bytes) {
    for (let bit = 7; bit >= 0; bit--) {
      const set = (byte >> bit) & 1;
      if (set && ended) return null;
      if (set) prefix++;
      else ended = true;
    }
  }
  return prefix;
}

function matchesNetmask(pattern: string, ip: ParsedIp): boolean | null {
  const slash = pattern.indexOf("/");
  if (slash < 0) return null;
  const base = pattern.slice(0, slash);
  const suffix = pattern.slice(slash + 1);
  if (/^\d{1,3}$/.test(suffix)) {
    const cidr = parseCidr(pattern);
    return cidr ? cidrContains(cidr, ip) : false;
  }
  const baseIp = parseIp(base);
  const mask = parseIp(suffix);
  if (!baseIp || !mask || baseIp.family !== mask.family) return false;
  const prefix = maskPrefix(mask);
  if (prefix === null) return false;
  const cidr = parseCidr(`${base}/${prefix}`);
  return cidr ? cidrContains(cidr, ip) : false;
}

export function hostPatternMatches(pattern: string, address: string): boolean {
  const p = pattern.trim();
  if (!p) return false;
  if (p === "%") return true;
  const ip = parseIp(address);
  if (ip) {
    const viaMask = matchesNetmask(p, ip);
    if (viaMask !== null) return viaMask;
  }
  if (p.toLowerCase() === "localhost") return false;
  return likeToRegExp(p).test(address.trim());
}
