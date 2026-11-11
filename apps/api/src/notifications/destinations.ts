import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import type {
  NotificationDestination,
  NotificationEventType,
  NotificationKind,
} from "@lambdata/shared";
import { databases } from "../db/queries";
import {
  notificationDeliveries,
  notificationDestinations,
  type DestinationPatch,
  type DestinationRecord,
} from "../db/queries/notifications";
import { decryptSecret, encryptSecret } from "../util/crypto";
import { newId } from "../util/id";
import { parseValue } from "../util/validate";
import { EVENT_TYPES } from "./catalog";
import type { StoredConfig } from "./format";
import {
  assertDiscordUrl,
  checkAtSave,
  headerNameProblem,
  headerValueProblem,
  isPrivateHost,
  MAX_CUSTOM_HEADERS,
  parseOutboundUrl,
  UnsafeDestinationError,
} from "./safety";

export const DEFAULT_NTFY_SERVER = "https://ntfy.sh";

const url = z.string().trim().min(1, "url is required").max(2048);
const secretText = z.string().min(1).max(500);
const priority = z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5)]);
const topic = z
  .string()
  .trim()
  .regex(/^[-_A-Za-z0-9]{1,64}$/, "topic must be 1 to 64 letters, digits, - or _");

const discordConfig = z.object({ url }).strict();
const slackConfig = z.object({ url }).strict();
const webhookConfig = z
  .object({ url, secret: secretText.nullable().optional(), headers: z.record(z.string(), z.string()).optional() })
  .strict();
const ntfyConfig = z
  .object({
    server: z.string().trim().max(2048).optional(),
    topic,
    token: secretText.nullable().optional(),
    priority: priority.optional(),
  })
  .strict();

const discordPatch = z.object({ url: url.optional() }).strict();
const slackPatch = z.object({ url: url.optional() }).strict();
const webhookPatch = webhookConfig.extend({ url: url.optional() }).strict();
const ntfyPatch = ntfyConfig.extend({ topic: topic.optional(), priority: priority.nullable().optional() }).strict();

const name = z.string().trim().min(1, "name is required").max(100);
const events = z.array(z.enum(EVENT_TYPES)).max(EVENT_TYPES.length * 2);
const databaseIds = z.array(z.string().trim().min(1).max(128)).max(1000).nullable();
const iconUrl = z.string().trim().max(2000).nullable();

const common = {
  name,
  enabled: z.boolean().optional(),
  events,
  databaseIds: databaseIds.optional(),
  iconUrl: iconUrl.optional(),
  skipUnchanged: z.boolean().optional(),
};

export const createSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("discord"), config: discordConfig, ...common }),
  z.object({ kind: z.literal("slack"), config: slackConfig, ...common }),
  z.object({ kind: z.literal("webhook"), config: webhookConfig, ...common }),
  z.object({ kind: z.literal("ntfy"), config: ntfyConfig, ...common }),
]);

export const updateSchema = z.object({
  name: name.optional(),
  enabled: z.boolean().optional(),
  events: events.optional(),
  databaseIds: databaseIds.optional(),
  iconUrl: iconUrl.optional(),
  skipUnchanged: z.boolean().optional(),
  config: z.record(z.string(), z.unknown()).optional(),
});

type ConfigInput = {
  url?: string;
  secret?: string | null;
  headers?: Record<string, string>;
  server?: string;
  topic?: string;
  token?: string | null;
  priority?: number | null;
};

function bad(message: string): never {
  throw new HTTPException(400, { message });
}

async function guard<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof UnsafeDestinationError) bad(err.message);
    throw err;
  }
}

function last4(s: string): string {
  return s.slice(-4);
}

export function targetOf(config: StoredConfig): string {
  switch (config.kind) {
    case "discord":
    case "slack":
      return `${new URL(config.url).host}/…${last4(config.url)}`;
    case "webhook": {
      const u = new URL(config.url);
      return `${u.protocol}//${u.host}`;
    }
    case "ntfy":
      return `${new URL(config.server).host}/${config.topic.slice(0, 2)}…`;
  }
}

function metaOf(config: StoredConfig): Pick<DestinationRecord, "target" | "hasSecret" | "headerNames" | "ntfyPriority"> {
  return {
    target: targetOf(config),
    hasSecret: config.kind === "webhook" ? config.secret !== null : config.kind === "ntfy" ? config.token !== null : false,
    headerNames: config.kind === "webhook" ? Object.keys(config.headers) : [],
    ntfyPriority: config.kind === "ntfy" ? config.priority : null,
  };
}

function mergeHeaders(input: Record<string, string> | undefined, existing: Record<string, string>): Record<string, string> {
  if (input === undefined) return existing;
  const entries = Object.entries(input);
  if (entries.length > MAX_CUSTOM_HEADERS) bad(`at most ${MAX_CUSTOM_HEADERS} custom headers are allowed`);
  const out: Record<string, string> = {};
  const seen = new Set<string>();
  const existingByLower = new Map(Object.entries(existing).map(([k, v]) => [k.toLowerCase(), v]));
  for (const [rawName, value] of entries) {
    const headerName = rawName.trim();
    const problem = headerNameProblem(headerName);
    if (problem) bad(problem);
    const lower = headerName.toLowerCase();
    if (seen.has(lower)) bad(`header ${headerName} is listed twice`);
    seen.add(lower);
    let v = value;
    if (v === "") {
      const kept = existingByLower.get(lower);
      if (kept === undefined) bad(`header ${headerName} needs a value`);
      v = kept;
    }
    const valueProblem = headerValueProblem(headerName, v);
    if (valueProblem) bad(valueProblem);
    out[headerName] = v;
  }
  return out;
}

function secretOf(input: string | null | undefined, existing: string | null): string | null {
  if (input === null) return null;
  if (input === undefined) return existing;
  return input;
}

export async function buildConfig(kind: NotificationKind, input: ConfigInput, existing: StoredConfig | null): Promise<StoredConfig> {
  return guard(async () => {
    switch (kind) {
      case "discord": {
        const raw = input.url ?? (existing?.kind === "discord" ? existing.url : undefined);
        if (!raw) bad("url is required");
        const u = parseOutboundUrl(raw);
        assertDiscordUrl(u);
        await checkAtSave(u);
        return { kind, url: u.toString() };
      }
      case "slack": {
        const raw = input.url ?? (existing?.kind === "slack" ? existing.url : undefined);
        if (!raw) bad("url is required");
        const u = parseOutboundUrl(raw);
        const resolved = await checkAtSave(u);
        if (u.protocol !== "https:" && !isPrivateHost(u, resolved)) {
          bad("Slack-compatible webhook URL must use https:// unless it points at a private address");
        }
        return { kind, url: u.toString() };
      }
      case "webhook": {
        const prior = existing?.kind === "webhook" ? existing : null;
        const raw = input.url ?? prior?.url;
        if (!raw) bad("url is required");
        const u = parseOutboundUrl(raw);
        await checkAtSave(u);
        return {
          kind,
          url: u.toString(),
          secret: secretOf(input.secret, prior?.secret ?? null),
          headers: mergeHeaders(input.headers, prior?.headers ?? {}),
        };
      }
      case "ntfy": {
        const prior = existing?.kind === "ntfy" ? existing : null;
        const rawServer = input.server === undefined ? (prior?.server ?? DEFAULT_NTFY_SERVER) : input.server || DEFAULT_NTFY_SERVER;
        const server = parseOutboundUrl(rawServer, "server");
        if (server.search || server.hash) bad("server must not contain a query or fragment");
        await checkAtSave(server, "server");
        const t = input.topic ?? prior?.topic;
        if (!t) bad("topic is required");
        const p = input.priority === undefined ? (prior?.priority ?? null) : input.priority;
        return {
          kind,
          server: server.toString(),
          topic: t,
          token: secretOf(input.token, prior?.token ?? null),
          priority: p,
        };
      }
    }
  });
}

function validIcon(raw: string | null | undefined): string | null | undefined {
  if (raw === undefined || raw === null) return raw;
  if (raw === "") return null;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    bad("iconUrl is not a valid address");
  }
  if (u.protocol !== "https:") bad("iconUrl must start with https://");
  if (u.username || u.password) bad("iconUrl must not contain a user name or password");
  return u.toString();
}

function validDatabases(ids: string[] | null | undefined, stored: string[] | null = null): string[] | null | undefined {
  if (ids === undefined || ids === null) return ids;
  const known = new Set(stored ?? []);
  const out: string[] = [];
  for (const id of new Set(ids)) {
    if (databases.byId(id)) out.push(id);
    else if (!known.has(id)) bad(`unknown database ${id.slice(0, 64)}`);
  }
  return out;
}

function uniqueEvents(list: NotificationEventType[]): NotificationEventType[] {
  return [...new Set(list)];
}

export async function decodeConfig(rec: Pick<DestinationRecord, "configEnc" | "kind">): Promise<StoredConfig> {
  const parsed = JSON.parse(await decryptSecret(rec.configEnc)) as StoredConfig;
  if (!parsed || parsed.kind !== rec.kind) throw new Error("stored notification config does not match its kind");
  return parsed;
}

export async function createDestination(body: unknown, userId: string | null): Promise<NotificationDestination> {
  const input = parseValue(createSchema, body, "request body");
  const config = await buildConfig(input.kind, input.config as ConfigInput, null);
  const now = Date.now();
  const rec: DestinationRecord = {
    id: newId("nd"),
    name: input.name,
    kind: input.kind,
    enabled: input.enabled !== false,
    configEnc: await encryptSecret(JSON.stringify(config)),
    ...metaOf(config),
    events: uniqueEvents(input.events),
    databaseIds: validDatabases(input.databaseIds) ?? null,
    iconUrl: validIcon(input.iconUrl) ?? null,
    skipUnchanged: input.skipUnchanged === true,
    createdByUserId: userId,
    createdAt: now,
    updatedAt: now,
  };
  notificationDestinations.insert(rec);
  return notificationDestinations.byId(rec.id)!;
}

function patchConfigSchema(kind: NotificationKind) {
  switch (kind) {
    case "discord":
      return discordPatch;
    case "slack":
      return slackPatch;
    case "webhook":
      return webhookPatch;
    case "ntfy":
      return ntfyPatch;
  }
}

export async function updateDestination(id: string, body: unknown): Promise<{ destination: NotificationDestination; disabled: boolean } | null> {
  const rec = notificationDestinations.recordById(id);
  if (!rec) return null;
  const input = parseValue(updateSchema, body, "request body");
  const patch: DestinationPatch = {};
  if (input.config !== undefined) {
    const cfg = parseValue(patchConfigSchema(rec.kind), input.config, "config") as ConfigInput;
    const config = await buildConfig(rec.kind, cfg, await decodeConfig(rec));
    patch.configEnc = await encryptSecret(JSON.stringify(config));
    Object.assign(patch, metaOf(config));
  }
  if (input.name !== undefined) patch.name = input.name;
  if (input.enabled !== undefined) patch.enabled = input.enabled;
  if (input.events !== undefined) patch.events = uniqueEvents(input.events);
  if (input.databaseIds !== undefined) patch.databaseIds = validDatabases(input.databaseIds, rec.databaseIds) ?? null;
  if (input.iconUrl !== undefined) patch.iconUrl = validIcon(input.iconUrl) ?? null;
  if (input.skipUnchanged !== undefined) patch.skipUnchanged = input.skipUnchanged;
  notificationDestinations.update(id, patch, Date.now());
  const disabled = rec.enabled && input.enabled === false;
  if (disabled) notificationDeliveries.dropQueued(id, "destination was turned off");
  return { destination: notificationDestinations.byId(id)!, disabled };
}
