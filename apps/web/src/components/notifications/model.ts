import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Hash, MessagesSquare, Smartphone, Webhook, type LucideIcon } from "lucide-react";
import type {
  CreateNotificationDestinationRequest,
  NotificationCatalogResponse,
  NotificationDelivery,
  NotificationDeliveryListResponse,
  NotificationDestination,
  NotificationDestinationConfigPatch,
  NotificationDestinationListResponse,
  NotificationDestinationResponse,
  NotificationEventInfo,
  NotificationEventType,
  NotificationKind,
  NotificationTestResponse,
  NtfyDestinationConfig,
  UpdateNotificationDestinationRequest,
  WebhookDestinationConfig,
} from "@lambdata/shared";
import { api } from "../../lib/api";
import { isNotFound } from "../../lib/queries";

export const DOCS_URL = "https://github.com/lambdatadb/lambdata/blob/main/docs/notifications.md";
export const DEFAULT_ICON_SRC = "/lambdata-mark.png";
export const DELIVERY_LIMIT = 20;
export const MAX_HEADERS = 10;
export const NAME_MAX = 100;

export interface KindMeta {
  label: string;
  short: string;
  defaultName: string;
  description: string;
  icon: LucideIcon;
}

export const KIND_ORDER: NotificationKind[] = ["discord", "slack", "ntfy", "webhook"];

export const KINDS: Record<NotificationKind, KindMeta> = {
  discord: {
    label: "Discord",
    short: "A channel in your server",
    defaultName: "Discord",
    description: "Post to a channel in your Discord server.",
    icon: MessagesSquare,
  },
  slack: {
    label: "Slack or Mattermost",
    short: "An incoming webhook",
    defaultName: "Slack",
    description: "An incoming webhook in Slack, Mattermost or another Slack-compatible chat.",
    icon: Hash,
  },
  ntfy: {
    label: "ntfy",
    short: "Push to your phone",
    defaultName: "My phone",
    description: "Push notifications to your phone with the free ntfy app. No account needed.",
    icon: Smartphone,
  },
  webhook: {
    label: "Webhook",
    short: "JSON to your endpoint",
    defaultName: "Webhook",
    description: "Signed JSON to your own endpoint: Home Assistant, n8n, Node-RED or your own code.",
    icon: Webhook,
  },
};

export function isKind(value: string | null | undefined): value is NotificationKind {
  return value === "discord" || value === "slack" || value === "ntfy" || value === "webhook";
}

export const notificationKeys = {
  all: ["notifications"] as const,
  catalog: ["notifications", "catalog"] as const,
  destinations: ["notifications", "destinations"] as const,
  deliveries: (id: string) => ["notifications", "deliveries", id] as const,
};

const base = "/notifications";
const destinationPath = (id: string, rest = "") => `${base}/destinations/${encodeURIComponent(id)}${rest}`;

export async function fetchCatalog(): Promise<NotificationCatalogResponse | null> {
  try {
    return await api.get<NotificationCatalogResponse>(`${base}/events`);
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
}

export function useNotificationCatalog(options: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: notificationKeys.catalog,
    queryFn: fetchCatalog,
    enabled: options.enabled ?? true,
    staleTime: 5 * 60_000,
  });
}

export function useDestinations(options: { enabled?: boolean; poll?: number } = {}) {
  return useQuery({
    queryKey: notificationKeys.destinations,
    queryFn: async () => (await api.get<NotificationDestinationListResponse>(`${base}/destinations`)).destinations,
    enabled: options.enabled ?? true,
    staleTime: 5_000,
    refetchInterval: (query) => (query.state.error ? false : (options.poll ?? false)),
  });
}

export function hasPending(deliveries: NotificationDelivery[] | undefined): boolean {
  return !!deliveries?.some((d) => d.status === "queued" || d.status === "sending");
}

export function useDeliveries(id: string, enabled: boolean) {
  return useQuery({
    queryKey: notificationKeys.deliveries(id),
    queryFn: async () => (await api.get<NotificationDeliveryListResponse>(destinationPath(id, `/deliveries?limit=${DELIVERY_LIMIT}`))).deliveries,
    enabled,
    staleTime: 2_000,
    refetchInterval: (query) => (query.state.error ? false : hasPending(query.state.data) ? 3_000 : 60_000),
  });
}

export function createDestination(body: CreateNotificationDestinationRequest) {
  return api.post<NotificationDestinationResponse>(`${base}/destinations`, body);
}

export function updateDestination(id: string, body: UpdateNotificationDestinationRequest) {
  return api.patch<NotificationDestinationResponse>(destinationPath(id), body);
}

export function deleteDestination(id: string) {
  return api.delete<unknown>(destinationPath(id));
}

export function testDestination(id: string) {
  return api.post<NotificationTestResponse>(destinationPath(id, "/test"));
}

function upsert(list: NotificationDestination[] | undefined, next: NotificationDestination): NotificationDestination[] {
  if (!list) return [next];
  return list.some((d) => d.id === next.id) ? list.map((d) => (d.id === next.id ? next : d)) : [...list, next];
}

export function useDestinationMutations() {
  const qc = useQueryClient();
  const store = (destination: NotificationDestination) =>
    qc.setQueryData<NotificationDestination[]>(notificationKeys.destinations, (list) => upsert(list, destination));
  const refresh = () => qc.invalidateQueries({ queryKey: notificationKeys.destinations });

  const create = useMutation({
    mutationFn: createDestination,
    onSuccess: (res) => {
      store(res.destination);
      void refresh();
    },
  });
  const update = useMutation({
    mutationFn: ({ id, body }: { id: string; body: UpdateNotificationDestinationRequest }) => updateDestination(id, body),
    onSuccess: (res) => {
      store(res.destination);
      void refresh();
    },
  });
  const remove = useMutation({
    mutationFn: (id: string) => deleteDestination(id),
    onSuccess: (_res, id) => {
      qc.setQueryData<NotificationDestination[]>(notificationKeys.destinations, (list) => list?.filter((d) => d.id !== id));
      qc.removeQueries({ queryKey: notificationKeys.deliveries(id) });
      void refresh();
    },
  });
  return { create, update, remove };
}

export function defaultEvents(catalog: NotificationCatalogResponse): NotificationEventType[] {
  return catalog.events.filter((e) => e.defaultOn).map((e) => e.type);
}

export function eventLabel(catalog: NotificationCatalogResponse | null | undefined, type: NotificationEventType | "test"): string {
  if (type === "test") return "Test message";
  return catalog?.events.find((e) => e.type === type)?.label ?? type;
}

export function eventsByGroup(catalog: NotificationCatalogResponse): { group: string; label: string; events: NotificationEventInfo[] }[] {
  const known = new Set(catalog.groups.map((g) => g.group));
  const groups = catalog.groups.map((g) => ({ group: g.group as string, label: g.label, events: catalog.events.filter((e) => e.group === g.group) }));
  const orphans = catalog.events.filter((e) => !known.has(e.group));
  if (orphans.length > 0) groups.push({ group: "other", label: "Other", events: orphans });
  return groups.filter((g) => g.events.length > 0);
}

export function anyPerDatabase(catalog: NotificationCatalogResponse, events: NotificationEventType[]): boolean {
  const chosen = new Set(events);
  return catalog.events.some((e) => e.perDatabase && chosen.has(e.type));
}

export const ROUTINE_NOTES: Partial<Record<NotificationEventType, string>> = {
  "sync.finished": "A mirror that syncs every five minutes sends a message every five minutes.",
  "checkpoint.auto_created": "Scheduled checkpoints send one message per database every time they run.",
  "disk.recovered": "Sent each time free space climbs back above the floor.",
};

export function routineNote(event: NotificationEventInfo): string | null {
  if (event.defaultOn) return null;
  const note = ROUTINE_NOTES[event.type] ?? "Sent every time it happens, which can be often.";
  const description = event.description.toLowerCase();
  if (description.includes(note.toLowerCase().replace(/\.$/, "")) || /noisy|every five minutes/.test(description)) return null;
  return note;
}

export interface HeaderRow {
  key: string;
  name: string;
  value: string;
  saved: boolean;
}

let headerKey = 0;

export function headerRow(name = "", value = "", saved = false): HeaderRow {
  headerKey += 1;
  return { key: `h${headerKey}`, name, value, saved };
}

export type SecretMode = "keep" | "new" | "remove";
export type DraftMode = "add" | "edit";

export interface DestinationDraft {
  kind: NotificationKind | null;
  name: string;
  nameTouched: boolean;
  addressMode: "keep" | "replace";
  url: string;
  server: string;
  topic: string;
  secretMode: SecretMode;
  secret: string;
  tokenMode: SecretMode;
  token: string;
  headers: HeaderRow[];
  priority: string;
  events: NotificationEventType[];
  scope: "all" | "some";
  databaseIds: string[];
  iconMode: "default" | "custom";
  iconUrl: string;
}

export function newDraft(kind: NotificationKind | null, catalog: NotificationCatalogResponse): DestinationDraft {
  return {
    kind,
    name: kind ? KINDS[kind].defaultName : "",
    nameTouched: false,
    addressMode: "replace",
    url: "",
    server: "",
    topic: "",
    secretMode: "new",
    secret: "",
    tokenMode: "new",
    token: "",
    headers: [],
    priority: "event",
    events: defaultEvents(catalog),
    scope: "all",
    databaseIds: [],
    iconMode: "default",
    iconUrl: "",
  };
}

export function draftFrom(dest: NotificationDestination): DestinationDraft {
  return {
    kind: dest.kind,
    name: dest.name,
    nameTouched: true,
    addressMode: "keep",
    url: "",
    server: "",
    topic: "",
    secretMode: dest.kind === "webhook" && dest.hasSecret ? "keep" : "new",
    secret: "",
    tokenMode: dest.kind === "ntfy" && dest.hasSecret ? "keep" : "new",
    token: "",
    headers: dest.headerNames.map((name) => headerRow(name, "", true)),
    priority: dest.ntfyPriority ? String(dest.ntfyPriority) : "event",
    events: [...dest.events],
    scope: dest.databaseIds === null ? "all" : "some",
    databaseIds: dest.databaseIds ? [...dest.databaseIds] : [],
    iconMode: dest.iconUrl ? "custom" : "default",
    iconUrl: dest.iconUrl ?? "",
  };
}

export type DraftField =
  | "kind"
  | "name"
  | "url"
  | "secret"
  | "headers"
  | "server"
  | "topic"
  | "token"
  | "events"
  | "databases"
  | "iconUrl";

export type DraftErrors = Partial<Record<DraftField, string>>;

const SECRET_MAX = 500;

function parseUrl(value: string): URL | null {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

function ipv4(host: string): number[] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return null;
  const parts = m.slice(1).map(Number);
  return parts.every((n) => n <= 255) ? parts : null;
}

export function isPrivateIpv4(host: string): boolean {
  const ip = ipv4(host);
  if (!ip) return false;
  const [a, b] = ip as [number, number, number, number];
  return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
}

function reservedHost(host: string): boolean {
  const ip = ipv4(host);
  if (ip) {
    const [a, b] = ip as [number, number, number, number];
    return (a === 169 && b === 254) || a === 0 || (a >= 224 && a <= 239);
  }
  const bare = host.replace(/^\[|\]$/g, "").toLowerCase();
  return bare === "::" || /^fe[89ab][0-9a-f]:/.test(bare) || /^ff[0-9a-f]{2}:/.test(bare);
}

function outboundUrlError(value: string, empty: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return empty;
  if (trimmed.length > 2048) return "That address is too long.";
  const url = parseUrl(trimmed);
  if (!url || (url.protocol !== "https:" && url.protocol !== "http:")) return "Use an address that starts with http:// or https://.";
  if (url.username || url.password) return "Leave the user name and password out of the address. A custom header can carry a key instead.";
  if (reservedHost(url.hostname)) return "That address is reserved (link-local, multicast or cloud metadata), so LambData will not send to it.";
  return null;
}

export function discordUrlError(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return "Paste the webhook URL you copied from Discord.";
  const url = parseUrl(trimmed);
  const host = url?.hostname.toLowerCase();
  if (
    !url ||
    url.protocol !== "https:" ||
    url.port !== "" ||
    (host !== "discord.com" && host !== "discordapp.com") ||
    !/^\/api\/webhooks\/[^/]+\/[^/]+/.test(url.pathname)
  ) {
    return "That is not a Discord webhook URL. It starts with https://discord.com/api/webhooks/.";
  }
  return null;
}

export function slackUrlError(value: string): string | null {
  const problem = outboundUrlError(value, "Paste the incoming webhook URL.");
  if (problem) return problem;
  const url = parseUrl(value.trim())!;
  if (url.protocol === "http:" && ipv4(url.hostname) && !isPrivateIpv4(url.hostname)) {
    return "Use https. Plain http is only allowed for a chat server on your own network.";
  }
  return null;
}

export function webhookUrlError(value: string): string | null {
  return outboundUrlError(value, "Enter the address LambData should send to.");
}

export function ntfyServerError(value: string): string | null {
  if (!value.trim()) return null;
  const problem = outboundUrlError(value, "");
  if (problem) return problem;
  const url = parseUrl(value.trim())!;
  if (url.search || url.hash) return "Use just the server's address, without ? or #.";
  return null;
}

export function topicError(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return "Pick a topic name. It is the address your phone subscribes to.";
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(trimmed)) return "Use letters, numbers, - and _ only, up to 64 characters.";
  return null;
}

const HEADER_TOKEN = /^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,100}$/;
const FORBIDDEN_HEADERS = new Set([
  "host",
  "content-length",
  "content-type",
  "user-agent",
  "transfer-encoding",
  "connection",
  "keep-alive",
  "upgrade",
  "te",
  "trailer",
  "proxy-connection",
]);

export function headerNameError(name: string): string | null {
  const trimmed = name.trim();
  if (!trimmed) return "Give every header a name.";
  if (!HEADER_TOKEN.test(trimmed)) return `“${trimmed.slice(0, 40)}” is not a valid header name.`;
  const lower = trimmed.toLowerCase();
  if (FORBIDDEN_HEADERS.has(lower) || lower.startsWith("x-lambdata-")) return `LambData sets ${trimmed} itself.`;
  return null;
}

export function headersError(rows: HeaderRow[]): string | null {
  const filled = rows.filter((r) => r.saved || r.name.trim() || r.value.trim());
  if (filled.length > MAX_HEADERS) return `At most ${MAX_HEADERS} headers.`;
  const seen = new Set<string>();
  for (const row of filled) {
    const problem = headerNameError(row.name);
    if (problem) return problem;
    if (!row.value.trim() && !row.saved) return `Give ${row.name.trim()} a value.`;
    if (row.value.length > 2000) return `The value of ${row.name.trim()} is too long.`;
    if (/[\u0000-\u0008\u000a-\u001f\u007f]/.test(row.value)) return `The value of ${row.name.trim()} has characters a header cannot carry.`;
    const lower = row.name.trim().toLowerCase();
    if (seen.has(lower)) return `${row.name.trim()} is listed twice.`;
    seen.add(lower);
  }
  return null;
}

export function iconUrlError(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return "Paste the address of an image, or use the LambData icon.";
  if (trimmed.length > 2000) return "That address is too long.";
  const url = parseUrl(trimmed);
  if (!url || url.protocol !== "https:") return "Use an https:// address. Chat apps fetch the image themselves.";
  if (url.username || url.password) return "Leave the user name and password out of the address.";
  return null;
}

export function validateDraft(draft: DestinationDraft, catalog: NotificationCatalogResponse): DraftErrors {
  const errors: DraftErrors = {};
  const set = (field: DraftField, problem: string | null) => {
    if (problem) errors[field] = problem;
  };
  if (!draft.kind) {
    errors.kind = "Choose where the messages should go.";
    return errors;
  }
  const name = draft.name.trim();
  if (!name) errors.name = "Give it a name you will recognise in this list.";
  else if (name.length > NAME_MAX) errors.name = `Keep the name under ${NAME_MAX} characters.`;

  if (draft.addressMode === "replace") {
    if (draft.kind === "discord") set("url", discordUrlError(draft.url));
    if (draft.kind === "slack") set("url", slackUrlError(draft.url));
    if (draft.kind === "webhook") set("url", webhookUrlError(draft.url));
    if (draft.kind === "ntfy") {
      set("server", ntfyServerError(draft.server));
      set("topic", topicError(draft.topic));
    }
  }
  if (draft.kind === "webhook") {
    if (draft.secretMode === "new" && draft.secret.trim().length > SECRET_MAX) errors.secret = `Keep the secret under ${SECRET_MAX} characters.`;
    set("headers", headersError(draft.headers));
  }
  if (draft.kind === "ntfy" && draft.tokenMode === "new" && draft.token.trim().length > SECRET_MAX) errors.token = "That token is too long.";

  if (draft.events.length === 0) errors.events = "Pick at least one event, or nothing will be sent.";
  else if (draft.scope === "some" && anyPerDatabase(catalog, draft.events) && draft.databaseIds.length === 0) {
    errors.databases = "Pick at least one database, or choose all databases.";
  }
  if (draft.iconMode === "custom") set("iconUrl", iconUrlError(draft.iconUrl));
  return errors;
}

function headerRecord(rows: HeaderRow[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const row of rows) {
    const name = row.name.trim();
    if (name) out[name] = row.value.trim();
  }
  return out;
}

function headersChanged(rows: HeaderRow[], saved: string[]): boolean {
  const named = rows.filter((r) => r.name.trim());
  if (named.some((r) => !r.saved || r.value.trim())) return true;
  return !sameSet(
    named.map((r) => r.name.trim()),
    saved,
  );
}

function trimServer(value: string): string {
  return value.trim().replace(/\/+$/, "");
}

export function webhookConfig(draft: DestinationDraft): WebhookDestinationConfig {
  const config: WebhookDestinationConfig = { url: draft.url.trim() };
  if (draft.secretMode === "new" && draft.secret.trim()) config.secret = draft.secret.trim();
  const headers = headerRecord(draft.headers);
  if (Object.keys(headers).length > 0) config.headers = headers;
  return config;
}

export function ntfyConfig(draft: DestinationDraft): NtfyDestinationConfig {
  const config: NtfyDestinationConfig = { topic: draft.topic.trim() };
  if (draft.server.trim()) config.server = trimServer(draft.server);
  if (draft.tokenMode === "new" && draft.token.trim()) config.token = draft.token.trim();
  if (draft.priority !== "event") config.priority = Number(draft.priority) as NtfyDestinationConfig["priority"];
  return config;
}

function scopeIds(draft: DestinationDraft): string[] | null {
  return draft.scope === "all" ? null : [...draft.databaseIds];
}

function iconValue(draft: DestinationDraft): string | null {
  return draft.iconMode === "custom" ? draft.iconUrl.trim() : null;
}

export function createRequest(draft: DestinationDraft): CreateNotificationDestinationRequest {
  if (!draft.kind) throw new Error("A destination needs a kind");
  const common = {
    name: draft.name.trim(),
    enabled: true,
    events: [...draft.events],
    databaseIds: scopeIds(draft),
    iconUrl: iconValue(draft),
  };
  switch (draft.kind) {
    case "discord":
      return { kind: "discord", config: { url: draft.url.trim() }, ...common };
    case "slack":
      return { kind: "slack", config: { url: draft.url.trim() }, ...common };
    case "webhook":
      return { kind: "webhook", config: webhookConfig(draft), ...common };
    case "ntfy":
      return { kind: "ntfy", config: ntfyConfig(draft), ...common };
  }
}

function sameSet<T>(a: T[], b: T[]): boolean {
  if (a.length !== b.length) return false;
  const set = new Set(a);
  return b.every((x) => set.has(x));
}

type NtfyPriority = NonNullable<NtfyDestinationConfig["priority"]>;

export function configPatch(draft: DestinationDraft, original: NotificationDestination): NotificationDestinationConfigPatch {
  const replacing = draft.addressMode === "replace";
  if (draft.kind === "ntfy") {
    const patch: Partial<Omit<NtfyDestinationConfig, "priority">> & { priority?: NtfyPriority | null } = {};
    if (replacing) {
      patch.topic = draft.topic.trim();
      if (draft.server.trim()) patch.server = trimServer(draft.server);
    }
    if (draft.tokenMode === "new" && draft.token.trim()) patch.token = draft.token.trim();
    if (draft.tokenMode === "remove" && original.hasSecret) patch.token = null;
    const priority = draft.priority === "event" ? null : (Number(draft.priority) as NtfyPriority);
    if (priority !== (original.ntfyPriority ?? null)) patch.priority = priority;
    return patch;
  }
  if (draft.kind === "webhook") {
    const patch: Partial<WebhookDestinationConfig> = {};
    if (replacing) patch.url = draft.url.trim();
    if (draft.secretMode === "new" && draft.secret.trim()) patch.secret = draft.secret.trim();
    if (draft.secretMode === "remove" && original.hasSecret) patch.secret = null;
    if (headersChanged(draft.headers, original.headerNames)) patch.headers = headerRecord(draft.headers);
    return patch;
  }
  return replacing ? { url: draft.url.trim() } : {};
}

export function updateRequest(draft: DestinationDraft, original: NotificationDestination): UpdateNotificationDestinationRequest {
  const body: UpdateNotificationDestinationRequest = {};
  const name = draft.name.trim();
  if (name !== original.name) body.name = name;
  if (!sameSet(draft.events, original.events)) body.events = [...draft.events];
  const ids = scopeIds(draft);
  const before = original.databaseIds;
  if ((ids === null) !== (before === null) || (ids && before && !sameSet(ids, before))) body.databaseIds = ids;
  const icon = iconValue(draft);
  if (icon !== (original.iconUrl ?? null)) body.iconUrl = icon;
  const config = configPatch(draft, original);
  if (Object.keys(config).length > 0) body.config = config;
  return body;
}

export function isEmptyUpdate(body: UpdateNotificationDestinationRequest): boolean {
  return Object.keys(body).length === 0;
}

export type HealthTone = "muted" | "success" | "warn";

export interface HealthView {
  tone: HealthTone;
  label: string;
  at: number | null;
  detail: string | null;
}

export function healthView(dest: NotificationDestination): HealthView {
  if (dest.health === "failing") {
    return {
      tone: "warn",
      label: dest.consecutiveFailures > 1 ? `Failing · ${dest.consecutiveFailures} in a row` : "Failing",
      at: dest.lastFailureAt,
      detail: dest.lastError,
    };
  }
  const recentFailure = dest.consecutiveFailures > 0 && dest.lastFailureAt !== null && (dest.lastSuccessAt ?? 0) < dest.lastFailureAt;
  if (recentFailure) {
    return {
      tone: "warn",
      label: dest.consecutiveFailures === 1 ? "Last attempt failed" : `Last ${dest.consecutiveFailures} attempts failed`,
      at: dest.lastFailureAt,
      detail: dest.lastError,
    };
  }
  if (dest.health === "ok") return { tone: "success", label: "Delivered", at: dest.lastSuccessAt, detail: null };
  return { tone: "muted", label: "Nothing delivered yet", at: null, detail: null };
}

export interface TestOutcome {
  ok: boolean;
  title: string;
  detail: string;
  hint: string | null;
}

function durationText(ms: number): string {
  if (ms < 1) return "under 1 ms";
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`;
}

export function testOutcome(res: NotificationTestResponse): TestOutcome {
  if (res.ok) {
    return {
      ok: true,
      title: "Test message sent",
      detail: `${res.responseStatus ? `HTTP ${res.responseStatus}` : "Accepted"} in ${durationText(res.durationMs)}. Check that it arrived.`,
      hint: null,
    };
  }
  const status = res.responseStatus;
  const reason = res.error ?? (status ? `HTTP ${status}` : "No answer");
  let hint: string;
  if (status === 401 || status === 403) hint = "The destination refused the message. Check the token, secret or the webhook's permissions.";
  else if (status === 404 || status === 410) hint = "Nothing answers at that address any more. The webhook may have been deleted: copy a new URL and replace it.";
  else if (status === 400 || status === 422) hint = "The destination did not accept the message. Check that the URL belongs to the kind you chose.";
  else if (status === 429) hint = "The destination is limiting how often LambData may post. Try again in a minute.";
  else if (status && status >= 500) hint = "The destination had a problem of its own. LambData retries real events automatically.";
  else if (status && status >= 300 && status < 400) hint = "The address redirects somewhere else. LambData does not follow redirects; use the final address.";
  else if (/time|10 s/i.test(reason)) hint = "No answer within 10 seconds. Check that the server is up and reachable from the machine LambData runs on.";
  else hint = "LambData could not connect. Check the address, and remember that inside a container localhost is the container itself.";
  return { ok: false, title: "The test was not delivered", detail: reason, hint };
}

export interface DeliveryStatusMeta {
  label: string;
  tone: "info" | "success" | "warn" | "muted";
}

export const DELIVERY_STATUS: Record<NotificationDelivery["status"], DeliveryStatusMeta> = {
  queued: { label: "Queued", tone: "info" },
  sending: { label: "Sending", tone: "info" },
  sent: { label: "Sent", tone: "success" },
  failed: { label: "Failed", tone: "warn" },
  dropped: { label: "Dropped", tone: "muted" },
};

export function generateSecret(bytes = 24): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return Array.from(buf, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function generateTopic(): string {
  const alphabet = "abcdefghijkmnpqrstuvwxyz23456789";
  const buf = new Uint8Array(12);
  crypto.getRandomValues(buf);
  return `lambdata-${Array.from(buf, (b) => alphabet[b % alphabet.length]).join("")}`;
}

export function overallState(destinations: NotificationDestination[] | undefined): "off" | "paused" | "on" {
  if (!destinations || destinations.length === 0) return "off";
  return destinations.some((d) => d.enabled) ? "on" : "paused";
}

export function targetHost(target: string): string {
  return target.replace(/^https?:\/\//, "").split(/[/…]/)[0] ?? target;
}
