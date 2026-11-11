import type { Context, MiddlewareHandler } from "hono";
import { ACCESS_TOKEN_PREFIX, NOTE_HEADER, NOTE_MAX_LENGTH } from "@lambdata/shared";
import type { AccessTokenVia, IngressKind, TokenActivityOutcome } from "@lambdata/shared";
import { accessTokens, approvals, databases, imports, jobs, tokenActivity, users, type StoredAccessToken } from "../db/queries";
import { toPublicUser } from "../auth/middleware";
import { classifyRequest, type IngressInfo } from "../network/classify";
import { askFirst, releaseClaim } from "./approvals";
import { describeIngress, isAppFacingPath } from "../network/policy";
import {
  FOUND_EXISTING_SUMMARY,
  matchCapability,
  PRESET_ROLE,
  triedSummary,
  type Capability,
  type CapabilityMatch,
} from "./capabilities";
import {
  hashSecret,
  mcpOriginOf,
  scrubSecrets,
  tokenCanSeeDatabase,
  tokenSeesEverything,
  type AccessTokenRequest,
} from "./index";

const WINDOW_MS = 60_000;
const TOUCH_EVERY_MS = 30_000;
const DETAIL_MAX = 300;
const SAFE_PATH = /^[A-Za-z0-9_\-.$~/]+$/;
const CURRENT_PATH = "/api/access-tokens/current";

type Bucket = { count: number; resetAt: number; reported: boolean };
const buckets = new Map<string, Bucket>();

export function resetAccessTokenRateLimits(): void {
  buckets.clear();
}

function bearerSecret(c: Context): string | null {
  const header = c.req.header("authorization");
  if (!header) return null;
  const start = /^\s*bearer\s+(\S*)/i.exec(header);
  if (!start || !start[1]!.startsWith(ACCESS_TOKEN_PREFIX)) return null;
  const exact = /^\s*bearer\s+(ld_[A-Za-z0-9]+)\s*$/i.exec(header);
  return exact ? exact[1]! : "";
}

function refuse(c: Context, status: 401 | 403 | 404 | 429, message: string, headers: Record<string, string> = {}): Response {
  const extra = status === 401 ? { "WWW-Authenticate": 'Bearer realm="LambData"', ...headers } : headers;
  return c.json({ error: message }, status, extra);
}

function formatWhen(at: number): string {
  return `${new Date(at).toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

function decodeNote(raw: string): string {
  if (!/%[0-9A-Fa-f]{2}/.test(raw)) return raw;
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

export function cleanNote(header: string | undefined | null): string | null {
  if (!header) return null;
  const raw = decodeNote(header);
  const text = scrubSecrets(raw.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, " ").replace(/\s+/g, " ").trim());
  if (!text) return null;
  return [...text].slice(0, NOTE_MAX_LENGTH).join("");
}

function takeRequest(tokenId: string, limit: number, now: number): { ok: true } | { ok: false; retryAfter: number; first: boolean } {
  if (buckets.size > 10_000) {
    for (const [k, b] of buckets) if (now >= b.resetAt) buckets.delete(k);
  }
  let bucket = buckets.get(tokenId);
  if (!bucket || now >= bucket.resetAt) {
    bucket = { count: 0, resetAt: now + WINDOW_MS, reported: false };
    buckets.set(tokenId, bucket);
  }
  bucket.count += 1;
  if (bucket.count <= limit) return { ok: true };
  const first = !bucket.reported;
  bucket.reported = true;
  return { ok: false, retryAfter: Math.max(1, Math.ceil((bucket.resetAt - now) / 1000)), first };
}

interface ScopeResult {
  allowed: boolean;
  databaseId: string | null;
  databaseName: string | null;
  notFound: string;
}

function databaseScope(token: StoredAccessToken, row: ReturnType<typeof databases.byId>, id: string | null): ScopeResult {
  if (!row) return { allowed: true, databaseId: id, databaseName: null, notFound: "database not found" };
  const allowed = tokenCanSeeDatabase(token, row);
  return {
    allowed,
    databaseId: row.id,
    databaseName: allowed ? row.displayName : null,
    notFound: "database not found",
  };
}

function resolveScope(token: StoredAccessToken, match: CapabilityMatch, url: URL): ScopeResult {
  const scope = match.capability.scope;
  const none: ScopeResult = { allowed: true, databaseId: null, databaseName: null, notFound: "not found" };
  switch (scope.kind) {
    case "none":
      return none;
    case "database": {
      const id = match.params[scope.param] ?? "";
      return databaseScope(token, databases.byId(id), id);
    }
    case "databaseName": {
      const name = match.params[scope.param] ?? "";
      const row = databases.byName(name);
      return databaseScope(token, row ? databases.byId(row.id) : null, null);
    }
    case "databaseQuery": {
      const id = url.searchParams.get(scope.query);
      if (id === null) return none;
      return databaseScope(token, databases.byId(id), id);
    }
    case "job": {
      const id = match.params[scope.param] ?? "";
      const job = jobs.byId(id);
      const result: ScopeResult = { allowed: true, databaseId: null, databaseName: null, notFound: "job not found" };
      if (!job || tokenSeesEverything(token)) return { ...result, databaseId: job?.databaseId ?? null };
      const row = job.databaseId ? databases.byId(job.databaseId) : null;
      if (row) {
        const scoped = databaseScope(token, row, row.id);
        return { ...scoped, notFound: "job not found" };
      }
      return { ...result, allowed: job.createdByUserId === token.actorUserId, databaseId: job.databaseId };
    }
    case "upload": {
      const id = match.params[scope.param] ?? "";
      const upload = imports.uploadById(id);
      return {
        allowed: !upload || upload.userId === token.actorUserId,
        databaseId: null,
        databaseName: null,
        notFound: "upload not found or expired",
      };
    }
    case "approval": {
      const id = match.params[scope.param] ?? "";
      const approval = approvals.byId(id);
      return {
        allowed: !approval || approval.tokenId === token.id,
        databaseId: approval && approval.tokenId === token.id ? approval.databaseId : null,
        databaseName: approval && approval.tokenId === token.id ? approval.databaseName : null,
        notFound: "approval not found",
      };
    }
  }
}

function outcomeFor(status: number): TokenActivityOutcome {
  if (status < 400) return "ok";
  if (status === 401 || status === 403 || status === 404 || status === 429) return "refused";
  return "error";
}

function fill(text: string, databaseName: string | null): string {
  return text.replace("{db}", databaseName ?? "a database");
}

function summarize(capability: Capability, databaseName: string | null): string {
  return fill(capability.summary, databaseName);
}

function summarizeTried(capability: Capability, databaseName: string | null): string {
  return fill(triedSummary(capability), databaseName);
}

async function responseError(res: Response): Promise<string | null> {
  if (res.status < 400) return null;
  if (!(res.headers.get("content-type") ?? "").includes("json")) return null;
  try {
    const body = (await res.clone().json()) as { error?: unknown } | null;
    if (!body || typeof body.error !== "string") return null;
    return [...scrubSecrets(body.error)].slice(0, DETAIL_MAX).join("");
  } catch {
    return null;
  }
}

async function createdDatabase(res: Response): Promise<{ id: string; name: string; found: boolean } | null> {
  if (res.status >= 300) return null;
  try {
    const body = (await res.clone().json()) as { database?: { id?: unknown; displayName?: unknown }; created?: unknown } | null;
    const d = body?.database;
    if (!d || typeof d.id !== "string" || typeof d.displayName !== "string") return null;
    return { id: d.id, name: d.displayName, found: body?.created === false };
  } catch {
    return null;
  }
}

interface ActivityInput {
  token: StoredAccessToken;
  via: AccessTokenVia;
  action: string;
  summary: string;
  databaseId: string | null;
  databaseName: string | null;
  status: number;
  note: string | null;
  from: string | null;
  detail: string | null;
  outcome?: TokenActivityOutcome;
}

function record(input: ActivityInput): void {
  try {
    tokenActivity.insert({
      tokenId: input.token.id,
      via: input.via,
      action: input.action,
      summary: input.summary,
      databaseId: input.databaseId,
      databaseName: input.databaseName,
      outcome: input.outcome ?? outcomeFor(input.status),
      status: input.status,
      note: input.note,
      from: input.from,
      detail: input.detail,
    });
  } catch (err) {
    console.warn("[access-tokens] could not record activity:", err instanceof Error ? err.message : String(err));
  }
}

function touch(token: StoredAccessToken, now: number, from: string, via: AccessTokenVia): void {
  if (token.lastUsedAt !== null && now - token.lastUsedAt < TOUCH_EVERY_MS && token.lastUsedVia === via) return;
  try {
    accessTokens.touch(token.id, now, from, via);
  } catch (err) {
    console.warn("[access-tokens] could not update last use:", err instanceof Error ? err.message : String(err));
  }
}

function creatorProblem(token: StoredAccessToken): string | null {
  if (token.createdByUserId === null) return "This access token was revoked because the admin who created it was removed.";
  const creator = users.personById(token.createdByUserId);
  if (!creator) return "This access token was revoked because the admin who created it was removed.";
  if (creator.role !== "admin") return "This access token no longer works because the person who created it is no longer an admin.";
  return null;
}

async function connection(
  c: Context,
  mcp: ReturnType<typeof mcpOriginOf>,
): Promise<{ ingress: IngressKind; checks: IngressKind[]; clientIp: string; info: IngressInfo }> {
  if (mcp) return { ingress: mcp.ingress, checks: mcp.checks, clientIp: mcp.clientIp, info: mcp.info };
  const info = await classifyRequest(c);
  return { ingress: info.ingress, checks: info.checks.length > 0 ? info.checks : [info.ingress], clientIp: info.clientIp, info };
}

export const accessTokenGate: MiddlewareHandler = async (c, next) => {
  c.set("accessToken", undefined);
  c.set("accessTokenDetail", undefined);
  const secret = bearerSecret(c);
  if (secret === null) return next();

  const path = c.req.path;
  const method = c.req.method.toUpperCase();
  if (isAppFacingPath(path, method)) {
    return refuse(
      c,
      401,
      "Access tokens are not accepted here. This address is part of the app-facing API, which uses App Auth tokens.",
    );
  }

  const stored = accessTokens.bySecretHash(hashSecret(secret));
  const mcp = mcpOriginOf(c.req.raw);
  if (!stored || (mcp && mcp.tokenId !== stored.id)) {
    return refuse(c, 401, "This access token is not known. Check that it was copied in full. An admin creates access tokens in the console under Access tokens.");
  }
  const token = stored;
  const now = Date.now();
  if (token.revokedAt !== null) {
    return refuse(c, 401, `This access token was revoked on ${formatWhen(token.revokedAt)}. Ask an admin for a new one.`);
  }
  if (token.expiresAt !== null && token.expiresAt <= now) {
    return refuse(c, 401, `This access token expired on ${formatWhen(token.expiresAt)}. Ask an admin for a new one.`);
  }
  const creator = creatorProblem(token);
  if (creator) return refuse(c, 401, creator);
  const actor = users.byId(token.actorUserId);
  if (!actor || actor.kind !== "token" || actor.role !== PRESET_ROLE[token.preset]) {
    return refuse(c, 401, "This access token is not set up correctly. Ask an admin for a new one.");
  }

  const via: AccessTokenVia = mcp ? "mcp" : "api";
  const conn = await connection(c, mcp);
  const note = cleanNote(c.req.header(NOTE_HEADER));
  const url = new URL(c.req.url);
  const rawPath = url.pathname;
  const match = SAFE_PATH.test(rawPath) && !/(^|\/)\.\.?(\/|$)/.test(rawPath) && !rawPath.includes("//")
    ? matchCapability(method, rawPath)
    : null;
  const base = {
    token,
    via,
    note,
    from: conn.clientIp,
    detail: null,
  };
  const refuseLogged = (
    status: 403 | 404 | 429,
    message: string,
    action: string,
    summary: string,
    db: { id: string | null; name: string | null } = { id: null, name: null },
    headers: Record<string, string> = {},
  ): Response => {
    record({ ...base, action, summary, databaseId: db.id, databaseName: db.name, status, detail: message, outcome: "refused" });
    return refuse(c, status, message, headers);
  };
  const actionName = match?.capability.action ?? "request.refused";
  const plainSummary = match ? summarizeTried(match.capability, null) : `Tried ${method} ${[...rawPath].slice(0, 120).join("")}.`;

  const isCurrent = match?.capability.path === CURRENT_PATH;
  if (!isCurrent && (token.paused || accessTokens.allPaused())) {
    const message = token.paused
      ? "This access token is paused. An admin can resume it on the Access tokens page."
      : "All access tokens are paused right now. An admin can resume them on the Access tokens page.";
    return refuseLogged(403, message, actionName, plainSummary);
  }

  const blocked = conn.checks.find((kind) => !token.allowedFrom.includes(kind));
  if (blocked) {
    return refuseLogged(
      403,
      `This access token is not allowed from ${describeIngress(blocked)}, and this request arrived on it. An admin can allow it in the token's settings.`,
      actionName,
      plainSummary,
    );
  }

  if (!mcp) {
    const rate = takeRequest(token.id, token.requestsPerMinute, now);
    if (!rate.ok) {
      const message = `This access token made more than ${token.requestsPerMinute} requests in a minute. Wait ${rate.retryAfter} seconds and try again.`;
      const headers = { "Retry-After": String(rate.retryAfter) };
      if (rate.first) return refuseLogged(429, message, actionName, plainSummary, undefined, headers);
      return refuse(c, 429, message, headers);
    }
  }

  if (!match || !match.capability.presets.includes(token.preset)) {
    return refuseLogged(403, `${method} ${[...path].slice(0, 120).join("")} is not available to access tokens of this kind.`, actionName, plainSummary);
  }
  const capability = match.capability;
  if (capability.credentials && (token.preset === "read_only" || !token.revealCredentials)) {
    return refuseLogged(
      403,
      "This access token may not see database passwords. An admin can allow it in the token's settings.",
      capability.action,
      plainSummary,
    );
  }

  const scope = resolveScope(token, match, url);
  if (!scope.allowed) {
    return refuseLogged(404, scope.notFound, capability.action, summarizeTried(capability, null), { id: scope.databaseId, name: null });
  }

  const asked = await askFirst(c, {
    token,
    match,
    method: method === "HEAD" ? "GET" : method,
    path: `${rawPath}${url.search}`,
    databaseId: scope.databaseId,
    databaseName: scope.databaseName,
    note,
  });
  if (asked.kind === "refused") {
    record({
      ...base,
      action: capability.action,
      summary: summarizeTried(capability, scope.databaseName),
      databaseId: scope.databaseId,
      databaseName: scope.databaseName,
      status: asked.status,
      detail: asked.message,
      outcome: "refused",
    });
    return c.json({ error: asked.message }, asked.status);
  }
  if (asked.kind === "parked") {
    touch(token, now, conn.clientIp, via);
    record({
      ...base,
      action: capability.action,
      summary: asked.approval.summary,
      databaseId: scope.databaseId,
      databaseName: scope.databaseName,
      status: 403,
      detail: `Waiting for approval ${asked.approval.id}.`,
      outcome: "waiting-approval",
    });
    return asked.response;
  }

  const request: AccessTokenRequest = {
    token,
    via,
    ingress: conn.ingress,
    checks: conn.checks,
    clientIp: conn.clientIp,
    info: conn.info,
  };
  c.set("accessToken", request);
  c.set("user" as never, toPublicUser(actor) as never);
  if (!capability.transport) touch(token, now, conn.clientIp, via);

  try {
    await next();
  } finally {
    if (asked.kind === "claimed") releaseClaim(asked.approvalId, c.res.status);
  }

  if (capability.transport) return;
  const res = c.res;
  let databaseId = scope.databaseId;
  let databaseName = scope.databaseName;
  let found = false;
  if (capability.creates) {
    const created = await createdDatabase(res);
    if (created) {
      databaseId = created.id;
      databaseName = created.name;
      found = created.found;
    }
  }
  const succeeded = res.status < 400;
  const summary = !succeeded
    ? summarizeTried(capability, databaseName)
    : found
      ? fill(FOUND_EXISTING_SUMMARY, databaseName)
      : summarize(capability, databaseName);
  const failure = capability.action === "sql.run" ? (c.get("accessTokenDetail") ?? null) : await responseError(res);
  const detail = asked.kind === "claimed" ? [`Approved as ${asked.approvalId}.`, failure].filter(Boolean).join(" ") : failure;
  record({
    ...base,
    action: capability.action,
    summary,
    databaseId,
    databaseName,
    status: res.status,
    detail,
  });
};
