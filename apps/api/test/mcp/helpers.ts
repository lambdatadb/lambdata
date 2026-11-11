import { matchCapability } from "../../src/accessTokens/capabilities";
import { DATA_TAG_PREFIX } from "../../src/mcp/results";
import { LOOPBACK, type App } from "../accessTokens/helpers";

export const STAGE_TWO = matchCapability("GET", "/api/approvals/sample") !== null && matchCapability("POST", "/api/databases/sample/undo") !== null;

let nextId = 1;

export interface RpcReply {
  status: number;
  headers: Headers;
  body: any;
}

export async function mcpPost(
  app: App,
  secret: string | null,
  message: unknown,
  opts: { headers?: Record<string, string>; env?: unknown; raw?: string } = {},
): Promise<RpcReply> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    ...(secret ? { Authorization: `Bearer ${secret}` } : {}),
    ...(opts.headers ?? {}),
  };
  const res = await app.request(
    "/mcp",
    { method: "POST", headers, body: opts.raw ?? JSON.stringify(message) },
    (opts.env ?? LOOPBACK) as never,
  );
  const text = await res.text();
  let body: unknown = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  return { status: res.status, headers: res.headers, body };
}

export async function rpc(app: App, secret: string, method: string, params?: unknown, headers?: Record<string, string>): Promise<RpcReply> {
  return mcpPost(app, secret, { jsonrpc: "2.0", id: nextId++, method, ...(params === undefined ? {} : { params }) }, { headers });
}

export interface ToolReply {
  isError: boolean;
  text: string;
  data: any;
  guidance: string;
  raw: any;
}

export function parseData(text: string): { guidance: string; data: any } {
  const open = new RegExp(`<(${DATA_TAG_PREFIX}[0-9a-f]{32})>\\n`);
  const m = open.exec(text);
  if (!m) return { guidance: text, data: undefined };
  const tag = m[1]!;
  const start = m.index + m[0].length;
  const end = text.indexOf(`\n</${tag}>`, start);
  if (end < 0) throw new Error("data block is not closed");
  return { guidance: text.slice(0, m.index), data: JSON.parse(text.slice(start, end)) };
}

export async function callTool(app: App, secret: string, name: string, args: Record<string, unknown> = {}): Promise<ToolReply> {
  const reply = await rpc(app, secret, "tools/call", { name, arguments: args });
  if (reply.status !== 200) throw new Error(`tools/call ${name} answered ${reply.status}: ${JSON.stringify(reply.body)}`);
  if (reply.body.error) throw new Error(`tools/call ${name} failed: ${JSON.stringify(reply.body.error)}`);
  const result = reply.body.result;
  const text = result.content.map((c: { text: string }) => c.text).join("\n");
  const { guidance, data } = parseData(text);
  return { isError: result.isError === true, text, data, guidance, raw: result };
}

export async function toolNames(app: App, secret: string): Promise<string[]> {
  const reply = await rpc(app, secret, "tools/list", {});
  return reply.body.result.tools.map((t: { name: string }) => t.name);
}
