import { Hono, type MiddlewareHandler } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import type {
  AccessTokenIdentity,
  AccessTokenListResponse,
  AccessTokenPreset,
  AccessTokenResponse,
  CreateAccessTokenResponse,
  IngressKind,
  PauseAllAccessTokensResponse,
  TokenActivityResponse,
} from "@lambdata/shared";
import { accessTokens, audit, databases, tokenActivity, type StoredAccessToken } from "../db/queries";
import { requireAuth, requireRole, type AuthVariables } from "../auth/middleware";
import { ACTOR_EMAIL_DOMAIN, PREFIX_LENGTH, currentAccessToken, generateSecret, hashSecret } from "../accessTokens/index";
import { PRESET_DEFAULTS, PRESET_ROLE, allPresetInfo, presetCan, presetCannot } from "../accessTokens/capabilities";
import { newId } from "../util/id";
import { parseJson, parseQuery } from "../util/validate";

export const accessTokensRoute = new Hono<{ Variables: AuthVariables }>();

const ingressSchema = z.enum(["loopback", "lan", "tailnet", "cloudflare"]);
const nameSchema = z.string().trim().min(1, "name required").max(100, "name is too long");
const idListSchema = z.array(z.string().trim().min(1).max(128)).max(500).nullable();
const allowedFromSchema = z.array(ingressSchema).min(1, "allow at least one connection group").max(4);
const limitsSchema = z
  .object({
    maxDatabases: z.number().int().min(0).max(10_000).nullable().optional(),
    requestsPerMinute: z.number().int().min(1).max(6000).optional(),
  })
  .strict();
const expiresSchema = z.number().int().positive().nullable();

const createSchema = z
  .object({
    name: nameSchema,
    preset: z.enum(["read_only", "builder", "admin"], { error: "preset must be read_only, builder or admin" }),
    expiresAt: expiresSchema.optional(),
    databaseIds: idListSchema.optional(),
    allowedFrom: allowedFromSchema.optional(),
    revealCredentials: z.boolean().optional(),
    askFirst: z.boolean().optional(),
    limits: limitsSchema.optional(),
  })
  .strict();

const updateSchema = z
  .object({
    name: nameSchema.optional(),
    paused: z.boolean().optional(),
    expiresAt: expiresSchema.optional(),
    databaseIds: idListSchema.optional(),
    allowedFrom: allowedFromSchema.optional(),
    revealCredentials: z.boolean().optional(),
    askFirst: z.boolean().optional(),
    limits: limitsSchema.optional(),
  })
  .strict();

const pauseAllSchema = z.object({ paused: z.boolean() }).strict();

const activityQuery = z.object({
  before: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

const sessionOnly: MiddlewareHandler<{ Variables: AuthVariables }> = async (c, next) => {
  if (currentAccessToken(c)) {
    throw new HTTPException(403, { message: "Access tokens cannot manage access tokens." });
  }
  await next();
};

function uniqueKinds(list: IngressKind[]): IngressKind[] {
  return [...new Set(list)];
}

function checkDatabaseIds(ids: string[] | null): string[] | null {
  if (ids === null) return null;
  const unique = [...new Set(ids)];
  const missing = unique.filter((id) => !databases.byId(id));
  if (missing.length > 0) {
    throw new HTTPException(400, { message: `No database has the id ${missing[0]}. Choose databases that exist.` });
  }
  return unique;
}

function checkExpiry(expiresAt: number | null | undefined): void {
  if (expiresAt !== undefined && expiresAt !== null && expiresAt <= Date.now()) {
    throw new HTTPException(400, { message: "The expiry date must be in the future." });
  }
}

function checkReveal(preset: AccessTokenPreset, reveal: boolean | undefined): void {
  if (preset === "read_only" && reveal === true) {
    throw new HTTPException(400, { message: "Read only tokens can never see database passwords." });
  }
}

function requireToken(id: string): StoredAccessToken {
  const token = accessTokens.byId(id);
  if (!token) throw new HTTPException(404, { message: "access token not found" });
  return token;
}

function tokenResponse(id: string): AccessTokenResponse {
  return { token: accessTokens.toPublic(requireToken(id)) };
}

accessTokensRoute.get("/current", requireAuth, (c) => {
  const req = currentAccessToken(c);
  if (!req) {
    throw new HTTPException(401, { message: "This address answers only requests made with an access token." });
  }
  const token = accessTokens.byId(req.token.id) ?? req.token;
  const res: AccessTokenIdentity = {
    token: accessTokens.toPublic(token),
    can: presetCan(token.preset),
    cannot: presetCannot(token.preset),
    allPaused: accessTokens.allPaused(),
  };
  return c.json(res);
});

accessTokensRoute.use("*", requireAuth, sessionOnly, requireRole("admin"));

accessTokensRoute.get("/", (c) => {
  const now = Date.now();
  const res: AccessTokenListResponse = {
    tokens: accessTokens.list().map((t) => accessTokens.toPublic(t, now)),
    allPaused: accessTokens.allPaused(),
    presets: allPresetInfo(),
  };
  return c.json(res);
});

accessTokensRoute.post("/", async (c) => {
  const me = c.get("user");
  const body = await parseJson(c, createSchema);
  const preset = body.preset;
  const defaults = PRESET_DEFAULTS[preset];
  checkExpiry(body.expiresAt);
  checkReveal(preset, body.revealCredentials);
  const databaseIds = checkDatabaseIds(body.databaseIds ?? null);
  const id = newId("tok");
  const actorUserId = newId("u");
  const secret = generateSecret();
  const maxDatabases = preset === "read_only"
    ? null
    : body.limits?.maxDatabases !== undefined
      ? body.limits.maxDatabases
      : defaults.limits.maxDatabases;
  accessTokens.insert({
    id,
    name: body.name,
    preset,
    prefix: secret.slice(0, PREFIX_LENGTH),
    secretHash: hashSecret(secret),
    actorUserId,
    actorEmail: `${id}@${ACTOR_EMAIL_DOMAIN}`,
    actorRole: PRESET_ROLE[preset],
    createdByUserId: me.id,
    createdByDisplayName: me.displayName ?? me.email,
    expiresAt: body.expiresAt ?? null,
    databaseIds,
    allowedFrom: uniqueKinds(body.allowedFrom ?? defaults.allowedFrom),
    revealCredentials: preset === "read_only" ? false : (body.revealCredentials ?? defaults.revealCredentials),
    askFirst: body.askFirst ?? defaults.askFirst,
    maxDatabases,
    requestsPerMinute: body.limits?.requestsPerMinute ?? defaults.limits.requestsPerMinute,
  });
  audit.log(me.id, "access_token.create", id, { name: body.name, preset });
  const res: CreateAccessTokenResponse = { token: accessTokens.toPublic(requireToken(id)), secret };
  return c.json(res, 201);
});

accessTokensRoute.put("/pause-all", async (c) => {
  const body = await parseJson(c, pauseAllSchema);
  accessTokens.setAllPaused(body.paused);
  audit.log(c.get("user").id, "access_token.pause_all", null, { paused: body.paused });
  const res: PauseAllAccessTokensResponse = { allPaused: accessTokens.allPaused() };
  return c.json(res);
});

accessTokensRoute.get("/:id", (c) => c.json(tokenResponse(c.req.param("id"))));

accessTokensRoute.patch("/:id", async (c) => {
  const id = c.req.param("id");
  const token = requireToken(id);
  if (token.revokedAt !== null) {
    throw new HTTPException(409, { message: "This access token was revoked and can no longer be changed." });
  }
  const raw = await c.req.text();
  let parsed: unknown = {};
  if (raw.trim() !== "") {
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new HTTPException(400, { message: "request body must be valid JSON" });
    }
  }
  if (parsed && typeof parsed === "object" && "preset" in parsed) {
    throw new HTTPException(400, { message: "The preset of an access token cannot change. Create a new token instead." });
  }
  const result = updateSchema.safeParse(parsed);
  if (!result.success) {
    throw new HTTPException(400, { message: `invalid request body: ${result.error.issues[0]?.message ?? "invalid"}` });
  }
  const body = result.data;
  checkExpiry(body.expiresAt);
  checkReveal(token.preset, body.revealCredentials);
  const patch: Parameters<typeof accessTokens.update>[1] = {};
  if (body.name !== undefined) patch.name = body.name;
  if (body.paused !== undefined) patch.paused = body.paused;
  if (body.expiresAt !== undefined) patch.expiresAt = body.expiresAt;
  if (body.databaseIds !== undefined) patch.databaseIds = checkDatabaseIds(body.databaseIds);
  if (body.allowedFrom !== undefined) patch.allowedFrom = uniqueKinds(body.allowedFrom);
  if (body.revealCredentials !== undefined) patch.revealCredentials = body.revealCredentials;
  if (body.askFirst !== undefined) patch.askFirst = body.askFirst;
  if (body.limits?.maxDatabases !== undefined && token.preset !== "read_only") patch.maxDatabases = body.limits.maxDatabases;
  if (body.limits?.requestsPerMinute !== undefined) patch.requestsPerMinute = body.limits.requestsPerMinute;
  accessTokens.update(id, patch);
  if (Object.keys(patch).length > 0) audit.log(c.get("user").id, "access_token.update", id, patch);
  return c.json(tokenResponse(id));
});

accessTokensRoute.delete("/:id", (c) => {
  const id = c.req.param("id");
  const token = requireToken(id);
  if (accessTokens.revoke(id)) audit.log(c.get("user").id, "access_token.revoke", id, { name: token.name });
  return c.json(tokenResponse(id));
});

accessTokensRoute.get("/:id/activity", (c) => {
  const id = c.req.param("id");
  requireToken(id);
  const q = parseQuery(c, activityQuery);
  const entries = tokenActivity.list(id, { before: q.before, limit: q.limit });
  const res: TokenActivityResponse = {
    entries,
    nextBefore: entries.length === q.limit ? entries[entries.length - 1]!.id : null,
  };
  return c.json(res);
});
