import type { NotificationDelivery, NotificationDestination } from "@lambdata/shared";
import { env } from "../../src/env";
import { notificationTransport } from "../../src/notifications/safety";
import { notificationTuning } from "../../src/notifications/send";
import { db } from "../../src/db/client";
import { diskProbe } from "../../src/util/disk";

export const FAKE_PORTS = [4366, 4367, 4368, 4369] as const;
export const OWN_API_PORT = 4361;

export interface Captured {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: string;
  at: number;
}

type Handler = (req: Request, n: number) => Response | Promise<Response>;

export class FakeDestination {
  readonly port: number;
  readonly requests: Captured[] = [];
  handler: Handler = () => new Response("ok");
  private server: ReturnType<typeof Bun.serve>;

  constructor(port: number) {
    this.port = port;
    this.server = Bun.serve({
      port,
      hostname: "127.0.0.1",
      fetch: async (req) => {
        const url = new URL(req.url);
        const body = await req.text();
        const headers: Record<string, string> = {};
        req.headers.forEach((v, k) => {
          headers[k] = v;
        });
        this.requests.push({ method: req.method, path: url.pathname + url.search, headers, body, at: Date.now() });
        return this.handler(req, this.requests.length);
      },
    });
  }

  url(path = "/hook"): string {
    return `http://127.0.0.1:${this.port}${path}`;
  }

  reset(handler?: Handler): void {
    this.requests.length = 0;
    this.handler = handler ?? (() => new Response("ok"));
  }

  json<T = Record<string, unknown>>(i = 0): T {
    return JSON.parse(this.requests[i]!.body) as T;
  }

  stop(): void {
    this.server.stop(true);
  }
}

export interface HostRoute {
  addresses: string[] | (() => string[]);
  port?: number;
}

const originalResolve = notificationTransport.resolve;
const originalFetch = notificationTransport.fetch;
const originalTuning = { ...notificationTuning, backoffMs: [...notificationTuning.backoffMs] };
const originalPort = env.port;
const originalSpace = diskProbe.space;
const TB = 1024 ** 4;

export const routes = new Map<string, HostRoute>();
export const transportLog: string[] = [];
export const transportCalls: { url: string; host: string | null; serverName: string | null }[] = [];
export const extraTls: { ca: string[] } = { ca: [] };

function hostHeader(headers: HeadersInit | undefined): string | null {
  if (!headers) return null;
  const value = new Headers(headers).get("host");
  return value && value.length > 0 ? value : null;
}

function allowedTarget(url: URL): boolean {
  return url.hostname === "127.0.0.1" && FAKE_PORTS.includes(Number(url.port) as (typeof FAKE_PORTS)[number]);
}

export function installFakeNetwork(): void {
  env.port = OWN_API_PORT;
  diskProbe.space = () => ({ freeBytes: TB, totalBytes: 2 * TB });
  notificationTransport.resolve = async (host: string) => {
    const route = routes.get(host.toLowerCase());
    if (!route) throw Object.assign(new Error("test resolver: unknown host"), { code: "ENOTFOUND" });
    return typeof route.addresses === "function" ? route.addresses() : route.addresses;
  };
  notificationTransport.fetch = (raw: string, init: BunFetchRequestInit) => {
    const url = new URL(raw);
    const host = hostHeader(init.headers);
    const name = host ? new URL(`http://${host}`).hostname : url.hostname;
    transportCalls.push({ url: raw, host, serverName: init.tls?.serverName ?? null });
    const route = routes.get(name.toLowerCase());
    const target = route?.port ? new URL(`http://127.0.0.1:${route.port}${url.pathname}${url.search}`) : url;
    if (!allowedTarget(target)) {
      transportLog.push(`refused ${target.hostname}:${target.port}`);
      return Promise.reject(Object.assign(new Error("test transport refused a non-fake target"), { code: "ConnectionRefused" }));
    }
    const tls = init.tls && extraTls.ca.length > 0 ? { ...init.tls, ca: extraTls.ca } : init.tls;
    return fetch(target.toString(), { ...init, ...(tls ? { tls } : {}) });
  };
}

export function restoreFakeNetwork(): void {
  notificationTransport.resolve = originalResolve;
  notificationTransport.fetch = originalFetch;
  env.port = originalPort;
  diskProbe.space = originalSpace;
  restoreTuning();
  routes.clear();
  transportCalls.length = 0;
  extraTls.ca = [];
}

export function restoreTuning(): void {
  Object.assign(notificationTuning, { ...originalTuning, backoffMs: [...originalTuning.backoffMs] });
}

export async function until<T>(fn: () => T | Promise<T>, timeoutMs = 8_000, label = "condition"): Promise<NonNullable<T>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value) return value as NonNullable<T>;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await Bun.sleep(20);
  }
}

export async function json<T>(res: Response, status = 200): Promise<T> {
  const text = await res.text();
  if (res.status !== status) throw new Error(`expected ${status}, got ${res.status}: ${text}`);
  return (text ? JSON.parse(text) : null) as T;
}

export function deliveryRows(destinationId?: string): (NotificationDelivery & { payload: string })[] {
  const rows = db
    .query(
      `SELECT * FROM notification_deliveries ${destinationId ? "WHERE destination_id = ?" : ""} ORDER BY created_at ASC, rowid ASC`,
    )
    .all(...(destinationId ? [destinationId] : [])) as Record<string, unknown>[];
  return rows.map((r) => ({
    id: String(r.id),
    destinationId: String(r.destination_id),
    eventType: r.event_type as NotificationDelivery["eventType"],
    title: String(r.title),
    status: r.status as NotificationDelivery["status"],
    attempts: Number(r.attempts),
    responseStatus: r.response_status === null ? null : Number(r.response_status),
    lastError: r.last_error === null ? null : String(r.last_error),
    createdAt: Number(r.created_at),
    sentAt: r.sent_at === null ? null : Number(r.sent_at),
    nextAttemptAt: r.next_attempt_at === null ? null : Number(r.next_attempt_at),
    payload: String(r.payload),
  }));
}

export function clearNotifications(): void {
  db.query("DELETE FROM notification_deliveries").run();
  db.query("DELETE FROM notification_destinations").run();
  db.query("DELETE FROM notification_state").run();
}

export type { NotificationDestination };
