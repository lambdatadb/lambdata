import type { Context, MiddlewareHandler } from "hono";
import { effectivePolicy, isOpenPolicy, loadNetworkConfig } from "./config";
import { classifyRaw, classifyRequest, needsUserspaceLookup } from "./classify";
import { evaluateAccess, isExemptPath } from "./policy";
import { hasLoopbackHostEvidence, requestFacts } from "./request";
import { mcpOriginOf } from "../accessTokens/index";

interface RequestIpSource {
  requestIP(req: Request): { address: string; port: number } | null;
}

function wantsJson(path: string): boolean {
  return path.startsWith("/api/") || path === "/api" || path.startsWith("/functions/");
}

function deny(c: Context, message: string): Response {
  if (wantsJson(c.req.path)) return c.json({ error: message }, 403);
  return c.text(message, 403);
}

export const accessGuard: MiddlewareHandler = async (c, next) => {
  const config = loadNetworkConfig();
  const facts = requestFacts(c, config.trustedCidrs);
  const path = c.req.path;
  if (isExemptPath(path)) return next();
  const policy = effectivePolicy(config);
  const inner = mcpOriginOf(c.req.raw);
  if (isOpenPolicy(policy)) {
    if (!inner && (needsUserspaceLookup(facts) || hasLoopbackHostEvidence(facts))) await classifyRequest(c);
    return next();
  }
  const info = inner ? inner.info : await classifyRequest(c);
  const verdict = evaluateAccess(policy, info, path, c.req.method);
  if (!verdict.allowed) return deny(c, verdict.message ?? "This connection is not allowed.");
  return next();
};

export async function guardUpgradeRequest(req: Request, server: RequestIpSource): Promise<Response | null> {
  const policy = effectivePolicy(loadNetworkConfig());
  if (isOpenPolicy(policy)) return null;
  let peer: { address: string | null; port: number | null } | null = null;
  try {
    const info = server.requestIP(req);
    peer = info ? { address: info.address, port: info.port } : null;
  } catch {
    peer = null;
  }
  const url = new URL(req.url);
  const info = await classifyRaw(req, peer);
  const verdict = evaluateAccess(policy, info, url.pathname, req.method);
  if (verdict.allowed) return null;
  return Response.json({ error: verdict.message ?? "This connection is not allowed." }, { status: 403 });
}
