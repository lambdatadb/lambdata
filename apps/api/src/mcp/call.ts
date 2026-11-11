import type { Context } from "hono";
import { APPROVAL_HEADER, NOTE_HEADER, NOTE_MAX_LENGTH } from "@lambdata/shared";
import { markMcpRequest } from "../accessTokens/index";
import { dispatchInternal } from "./dispatch";

export type ApiMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export interface ApiCall {
  method: ApiMethod;
  path: string;
  query?: Record<string, string>;
  body?: unknown;
  note?: string | null;
  approvalId?: string | null;
}

export interface ApiResult {
  status: number;
  body: unknown;
  headers: Headers;
}

export function encodeNote(note: string | null | undefined): string | null {
  if (!note) return null;
  const text = note
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return null;
  return encodeURIComponent([...text].slice(0, NOTE_MAX_LENGTH).join(""));
}

export async function callApi(outer: Context, call: ApiCall): Promise<ApiResult> {
  const url = new URL(call.path, new URL(outer.req.url).origin);
  for (const [key, value] of Object.entries(call.query ?? {})) url.searchParams.set(key, value);
  const headers = new Headers({ Accept: "application/json" });
  const authorization = outer.req.header("authorization");
  if (authorization) headers.set("Authorization", authorization);
  const note = encodeNote(call.note);
  if (note) headers.set(NOTE_HEADER, note);
  if (call.approvalId) headers.set(APPROVAL_HEADER, call.approvalId);
  let body: string | undefined;
  if (call.body !== undefined) {
    body = JSON.stringify(call.body);
    headers.set("Content-Type", "application/json");
    headers.set("Content-Length", String(new TextEncoder().encode(body).byteLength));
  }
  const request = new Request(url, { method: call.method, headers, body });
  markMcpRequest(request, outer);
  const res = await dispatchInternal(request);
  let parsed: unknown = null;
  const text = await res.text();
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = null;
    }
  }
  return { status: res.status, body: parsed, headers: res.headers };
}
