import type { RenderedRequest } from "./format";
import type { ParsedIp } from "../network/ip";
import { checkAtSend, notificationTransport, pinTarget, UnsafeDestinationError } from "./safety";

export const notificationTuning = {
  requestTimeoutMs: 10_000,
  backoffMs: [10_000, 60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000],
  retryAfterCapMs: 15 * 60_000,
  minRetryMs: 1_000,
  windowMs: 60_000,
  maxPerWindow: 20,
  summaryGatherMs: 5_000,
  keepPerDestination: 200,
  keepMs: 14 * 24 * 60 * 60_000,
};

export interface AttemptOutcome {
  ok: boolean;
  retryable: boolean;
  aborted: boolean;
  responseStatus: number | null;
  error: string | null;
  retryAfterMs: number | null;
  durationMs: number;
}

const REASONS: Record<number, string> = {
  400: "Bad Request",
  401: "Unauthorized",
  403: "Forbidden",
  404: "Not Found",
  405: "Method Not Allowed",
  408: "Request Timeout",
  409: "Conflict",
  410: "Gone",
  413: "Payload Too Large",
  415: "Unsupported Media Type",
  422: "Unprocessable Entity",
  429: "Too Many Requests",
  500: "Internal Server Error",
  501: "Not Implemented",
  502: "Bad Gateway",
  503: "Service Unavailable",
  504: "Gateway Timeout",
};

export function statusText(status: number): string {
  const reason = REASONS[status];
  return reason ? `HTTP ${status} ${reason}` : `HTTP ${status}`;
}

export function parseRetryAfter(raw: string | null, now: number = Date.now()): number | null {
  if (!raw) return null;
  const s = raw.trim();
  let ms: number | null = null;
  if (/^\d+(\.\d+)?$/.test(s)) ms = Math.round(Number(s) * 1000);
  else {
    const at = Date.parse(s);
    if (Number.isFinite(at)) ms = at - now;
  }
  if (ms === null || !Number.isFinite(ms)) return null;
  return Math.min(Math.max(ms, notificationTuning.minRetryMs), notificationTuning.retryAfterCapMs);
}

function codeOf(err: unknown): string {
  if (err && typeof err === "object") {
    const code = (err as { code?: unknown }).code;
    if (typeof code === "string") return code;
    const name = (err as { name?: unknown }).name;
    if (typeof name === "string") return name;
  }
  return "";
}

export function networkErrorText(err: unknown): string {
  const code = codeOf(err);
  if (/refused/i.test(code)) return "connection refused";
  if (/notfound|enotfound|eai_again|dns/i.test(code)) return "host not found";
  if (/reset|closed|epipe|socket/i.test(code)) return "connection closed by the server";
  if (/cert|tls|ssl|self_signed|altname/i.test(code)) return "TLS certificate problem";
  if (/timeout|timedout/i.test(code)) return "timed out";
  if (/unreachable/i.test(code)) return "network unreachable";
  return "network error";
}

function done(started: number, partial: Partial<AttemptOutcome>): AttemptOutcome {
  return {
    ok: false,
    retryable: false,
    aborted: false,
    responseStatus: null,
    error: null,
    retryAfterMs: null,
    ...partial,
    durationMs: Math.round(performance.now() - started),
  };
}

export async function attemptRequest(req: RenderedRequest, signal?: AbortSignal): Promise<AttemptOutcome> {
  const started = performance.now();
  const deadline = Date.now() + notificationTuning.requestTimeoutMs;
  let url: URL;
  try {
    url = new URL(req.url);
  } catch {
    return done(started, { error: "the destination address is not valid" });
  }
  let addresses: ParsedIp[];
  try {
    addresses = await checkAtSend(url);
  } catch (err) {
    if (err instanceof UnsafeDestinationError) return done(started, { error: `refused: ${err.message.replace(/^URL /, "the address ")}` });
    if (signal?.aborted) return done(started, { aborted: true });
    return done(started, { retryable: true, error: "host not found" });
  }
  const remaining = Math.max(1, deadline - Date.now());
  const timeout = AbortSignal.timeout(remaining);
  const combined = signal ? AbortSignal.any([timeout, signal]) : timeout;
  const pinned = pinTarget(url, addresses);
  let res: Response;
  try {
    res = await notificationTransport.fetch(pinned.url, {
      method: "POST",
      headers: { ...req.headers, ...pinned.headers },
      body: req.body,
      redirect: "manual",
      signal: combined,
      ...(pinned.tls ? { tls: pinned.tls } : {}),
    });
  } catch (err) {
    if (signal?.aborted) return done(started, { aborted: true });
    if (timeout.aborted) {
      return done(started, { retryable: true, error: `timed out after ${Math.round(notificationTuning.requestTimeoutMs / 1000)} seconds` });
    }
    return done(started, { retryable: true, error: networkErrorText(err) });
  }
  try {
    await res.body?.cancel();
  } catch {}
  const status = res.status;
  if (status >= 200 && status < 300) return done(started, { ok: true, responseStatus: status });
  if (status >= 300 && status < 400) {
    return done(started, { responseStatus: status, error: `${statusText(status)}: redirect not followed` });
  }
  if (status === 408 || status === 429 || status >= 500) {
    return done(started, {
      retryable: true,
      responseStatus: status,
      error: statusText(status),
      retryAfterMs: parseRetryAfter(res.headers.get("retry-after")),
    });
  }
  return done(started, { responseStatus: status, error: statusText(status) });
}
