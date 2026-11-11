import { normalizeIp, parseIp } from "../network/ip";

export type CaptureSource = "audit" | "errorlog";

export interface RawRejection {
  at: number;
  user: string;
  address: string;
  code: number;
}

export const ER_ACCESS_DENIED = 1045;
export const ER_HOST_NOT_PRIVILEGED = 1130;
export const ER_ACCOUNT_LOCKED = 4151;

const MAX_FIELD = 128;

const AUDIT_LINE =
  /^(\d{4})(\d{2})(\d{2}) (\d{2}):(\d{2}):(\d{2}),[^,]*,(.*),([^,]*),\d+,\d+,FAILED_CONNECT,.*,(-?\d+)\s*$/;

const ERRORLOG_LINE =
  /^(\d{4})-(\d{2})-(\d{2})\s+(\d{1,2}):(\d{2}):(\d{2})\s+\d+\s+\[Warning\]\s+Access denied for user '(.*)'@'([^']*)' \(using password: (?:YES|NO)\)\s*$/;

function localTime(parts: string[], now: number): number {
  const [y, mo, d, h, mi, s] = parts.map(Number) as [number, number, number, number, number, number];
  const at = new Date(y, mo - 1, d, h, mi, s).getTime();
  if (!Number.isFinite(at)) return now;
  return Math.min(at, now);
}

function cleanAddress(raw: string): string | null {
  const value = raw.trim();
  if (!value) return null;
  const direct = normalizeIp(value);
  const withPort = /^(.+):(\d{1,5})$/.exec(value);
  if (withPort) {
    const host = withPort[1]!;
    const parsed = parseIp(host);
    if (parsed && (parsed.family === 4 || !direct)) return normalizeIp(host);
  }
  if (direct) return direct;
  return value.length <= MAX_FIELD && /^[A-Za-z0-9._:-]+$/.test(value) ? value : null;
}

function cleanUser(raw: string): string {
  return raw.slice(0, MAX_FIELD);
}

export function parseAuditLine(line: string, now = Date.now()): RawRejection | null {
  if (!line.includes(",FAILED_CONNECT,")) return null;
  const m = AUDIT_LINE.exec(line);
  if (!m) return null;
  const address = cleanAddress(m[8]!);
  if (!address) return null;
  return {
    at: localTime(m.slice(1, 7), now),
    user: cleanUser(m[7]!),
    address,
    code: Number(m[9]),
  };
}

export function parseErrorLogLine(line: string, now = Date.now()): RawRejection | null {
  if (!line.includes("Access denied for user")) return null;
  const m = ERRORLOG_LINE.exec(line);
  if (!m) return null;
  const address = cleanAddress(m[8]!);
  if (!address) return null;
  return {
    at: localTime(m.slice(1, 7), now),
    user: cleanUser(m[7]!),
    address,
    code: ER_ACCESS_DENIED,
  };
}

export function parseLine(source: CaptureSource, line: string, now = Date.now()): RawRejection | null {
  return source === "audit" ? parseAuditLine(line, now) : parseErrorLogLine(line, now);
}
