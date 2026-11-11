import type { AccessToken, CreateAccessTokenRequest, CreateAccessTokenResponse } from "@lambdata/shared";
import { authHeaders, type SeededUser } from "../harness/sqlite";
import type { buildApp } from "../../src/server";

export type App = ReturnType<typeof buildApp>;

export const LOOPBACK = { server: { requestIP: () => ({ address: "127.0.0.1", family: "IPv4", port: 40001 }) } };
export const LAN = { server: { requestIP: () => ({ address: "192.168.1.20", family: "IPv4", port: 40002 }) } };
export const TAILNET = { server: { requestIP: () => ({ address: "100.101.102.103", family: "IPv4", port: 40003 }) } };

export async function session(app: App, user: SeededUser, path: string, method = "GET", body?: unknown): Promise<Response> {
  return app.request(
    path,
    {
      method,
      headers: await authHeaders(user, body === undefined ? {} : { "Content-Type": "application/json" }),
      body: body === undefined ? undefined : JSON.stringify(body),
    },
    LOOPBACK,
  );
}

export async function createToken(
  app: App,
  admin: SeededUser,
  req: CreateAccessTokenRequest,
): Promise<{ token: AccessToken; secret: string }> {
  const res = await session(app, admin, "/api/access-tokens", "POST", req);
  if (res.status !== 201) throw new Error(`token create failed: ${res.status} ${await res.text()}`);
  return (await res.json()) as CreateAccessTokenResponse;
}

export function withToken(
  app: App,
  secret: string,
  path: string,
  opts: { method?: string; body?: unknown; headers?: Record<string, string>; env?: unknown } = {},
): Promise<Response> {
  const headers: Record<string, string> = { Authorization: `Bearer ${secret}`, ...(opts.headers ?? {}) };
  if (opts.body !== undefined) headers["Content-Type"] = "application/json";
  return Promise.resolve(
    app.request(
      path,
      {
        method: opts.method ?? "GET",
        headers,
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      },
      (opts.env ?? LOOPBACK) as never,
    ),
  );
}
