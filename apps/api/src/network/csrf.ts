import type { Context, MiddlewareHandler } from "hono";
import { getCookie } from "hono/cookie";
import { SESSION_COOKIE_NAMES } from "../auth/jwt";
import { isAllowedOrigin } from "./origins";
import { isAppFacingPath } from "./policy";
import { requestFacts } from "./request";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const BODY_METHODS = new Set(["POST", "PUT", "PATCH"]);
const STORAGE_UPLOAD = /^\/api\/storage\/buckets\/[^/]+\/objects\/?$/;
const JSON_SUFFIX = /^application\/[a-z0-9!#$&^_.+-]+\+json$/;

export const JSON_REQUIRED_MESSAGE =
  "This request must be sent as JSON with the header Content-Type: application/json.";

export interface RequestOrigin {
  origin: string | null;
  fetchSite: string | null;
  host: string | null;
  forwardedHost: string | null;
  https: boolean;
}

export type OriginVerdict = { ok: true } | { ok: false; message: string };

interface HostPort {
  host: string;
  port: string | null;
}

export function isUploadRoute(method: string, path: string): boolean {
  if (method !== "POST") return false;
  return path === "/api/imports/uploads" || path === "/api/imports/uploads/" || STORAGE_UPLOAD.test(path);
}

export function isJsonContentType(value: string | null | undefined): boolean {
  if (!value) return false;
  const essence = value.split(";")[0]!.trim().toLowerCase();
  return essence === "application/json" || JSON_SUFFIX.test(essence);
}

function defaultPort(protocol: string): string {
  return protocol === "https:" ? "443" : "80";
}

function parseHostHeader(raw: string | null): HostPort | null {
  if (!raw) return null;
  const value = raw.split(",")[0]!.trim().toLowerCase();
  const match = /^(\[[0-9a-f:.]+(?:%[\w.-]+)?\]|[^:\s/\[\]]+)(?::(\d{1,5}))?$/.exec(value);
  if (!match) return null;
  return { host: match[1]!, port: match[2] ?? null };
}

function sameHost(origin: URL, candidate: HostPort | null): boolean {
  if (!candidate) return false;
  if (origin.hostname.toLowerCase() !== candidate.host) return false;
  const originPort = origin.port || defaultPort(origin.protocol);
  return candidate.port === null ? originPort === defaultPort(origin.protocol) : candidate.port === originPort;
}

export function isSameServerOrigin(origin: string, req: Omit<RequestOrigin, "origin" | "fetchSite">): boolean {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  if (req.https && url.protocol === "http:") return false;
  return sameHost(url, parseHostHeader(req.host)) || sameHost(url, parseHostHeader(req.forwardedHost));
}

function refusedOrigin(origin: string): string {
  return `Request blocked: it was sent from ${origin.slice(0, 120)}, which is not an address of this LambData server. If you opened the console through a proxy or tunnel that changes the Host header, add its address under Network, public URLs (or set LAMBDATA_EXTRA_ORIGINS), or, if the proxy sends X-Forwarded-Host, list it under Network, trusted proxies.`;
}

export function checkRequestOrigin(req: RequestOrigin): OriginVerdict {
  const origin = req.origin?.trim() || null;
  if (origin && origin !== "null") {
    if (isAllowedOrigin(origin) || isSameServerOrigin(origin, req)) return { ok: true };
    return { ok: false, message: refusedOrigin(origin) };
  }
  const site = req.fetchSite?.trim().toLowerCase() || null;
  if (site) {
    if (site === "same-origin" || site === "none") return { ok: true };
    return { ok: false, message: "Request blocked: the browser reports it was sent by another site." };
  }
  if (origin === "null") return { ok: false, message: "Request blocked: it was sent from an opaque origin." };
  return { ok: true };
}

export function hasSessionCookie(c: Context): boolean {
  return SESSION_COOKIE_NAMES.some((name) => !!getCookie(c, name));
}

function requestHost(c: Context): string | null {
  const header = c.req.header("host");
  if (header) return header;
  try {
    return new URL(c.req.url).host;
  } catch {
    return null;
  }
}

export function requestOrigin(c: Context): RequestOrigin {
  const facts = requestFacts(c);
  return {
    origin: c.req.header("origin") ?? null,
    fetchSite: c.req.header("sec-fetch-site") ?? null,
    host: requestHost(c),
    forwardedHost: facts.peerTrusted ? (c.req.header("x-forwarded-host") ?? null) : null,
    https: facts.https,
  };
}

function guardsPath(path: string, method: string): boolean {
  return (path === "/api" || path.startsWith("/api/")) && !isAppFacingPath(path, method);
}

export const requestForgeryGuard: MiddlewareHandler = async (c, next) => {
  const method = c.req.method.toUpperCase();
  if (SAFE_METHODS.has(method)) return next();
  const path = c.req.path;
  if (!guardsPath(path, method)) return next();
  if (BODY_METHODS.has(method) && !isUploadRoute(method, path) && !isJsonContentType(c.req.header("content-type"))) {
    return c.json({ error: JSON_REQUIRED_MESSAGE }, 415);
  }
  if (hasSessionCookie(c)) {
    const verdict = checkRequestOrigin(requestOrigin(c));
    if (!verdict.ok) return c.json({ error: verdict.message }, 403);
  }
  return next();
};
