import { createHmac } from "node:crypto";
import type { Database } from "@lambdata/shared";
import type { ApiClient } from "./client";
import { ACCOUNTS } from "./seed";

export interface ReceivedRequest {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: string;
  at: number;
}

export interface Receiver {
  url: string;
  received: ReceivedRequest[];
  stop: () => void;
}

export function startReceiver(port: number): Receiver {
  const received: ReceivedRequest[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port,
    async fetch(req) {
      const url = new URL(req.url);
      received.push({
        method: req.method,
        path: url.pathname,
        headers: Object.fromEntries(req.headers.entries()),
        body: await req.text(),
        at: Date.now(),
      });
      if (url.pathname.startsWith("/missing")) return new Response("no such hook", { status: 404 });
      return new Response(null, { status: 204 });
    },
  });
  return { url: `http://127.0.0.1:${port}`, received, stop: () => void server.stop(true) };
}

export function signatureMatches(request: ReceivedRequest, secret: string): boolean {
  const timestamp = request.headers["x-lambdata-timestamp"];
  const signature = request.headers["x-lambdata-signature"];
  if (!timestamp || !signature) return false;
  const expected = `sha256=${createHmac("sha256", secret).update(`${timestamp}.${request.body}`).digest("hex")}`;
  return signature === expected;
}

export async function waitForRequest(receiver: Receiver, match: (r: ReceivedRequest) => boolean, timeoutMs = 20_000): Promise<ReceivedRequest | null> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const hit = receiver.received.find(match);
    if (hit) return hit;
    await Bun.sleep(200);
  }
  return null;
}

export async function seedForNotifications(admin: ApiClient, log: (message: string) => void): Promise<Database[]> {
  log("Adding a viewer and three databases for the notifications tour");
  await admin.post("/api/users", { ...ACCOUNTS.viewer, role: "viewer" });
  const created: Database[] = [];
  for (const body of [
    { displayName: "Storefront", versioned: true },
    { displayName: "Ledger", versioned: true },
    { displayName: "Game Mirror", kind: "mirror" },
  ]) {
    const res = await admin.post<{ database: Database }>("/api/databases", body);
    created.push(res.database);
  }
  return created;
}
