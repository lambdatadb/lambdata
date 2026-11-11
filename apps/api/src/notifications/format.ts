import { createHmac } from "node:crypto";
import type {
  NotificationEventType,
  TableRowChange,
  NotificationGroup,
  NotificationSeverity,
  NotificationWebhookPayload,
} from "@lambdata/shared";
import { redactSecrets } from "../jobs/sanitize";
import { DEFAULT_ICON_URL, SENDER_NAME } from "./catalog";

export interface EventField {
  label: string;
  value: string;
}

export interface NotificationEvent {
  id: string;
  type: NotificationEventType | "test" | "summary";
  group: NotificationGroup | "test" | "summary";
  severity: NotificationSeverity;
  occurredAt: number;
  title: string;
  message: string;
  actor: { displayName: string } | null;
  database: { id: string; name: string; displayName: string } | null;
  fields: EventField[];
  data: Record<string, string | number | boolean | null>;
  changes?: { tables: TableRowChange[]; truncated: boolean } | null;
  link: string | null;
}

export type StoredConfig =
  | { kind: "discord"; url: string }
  | { kind: "slack"; url: string }
  | { kind: "webhook"; url: string; secret: string | null; headers: Record<string, string> }
  | { kind: "ntfy"; server: string; topic: string; token: string | null; priority: number | null };

export interface RenderedRequest {
  url: string;
  headers: Record<string, string>;
  body: string;
}

export const USER_TEXT_LIMIT = 200;
const ZWSP = "\u200b";

export const SEVERITY_COLORS: Record<NotificationSeverity, number> = {
  success: 0xc6f24e,
  info: 0xc6f24e,
  warning: 0xf2b84e,
  error: 0xf2594e,
};

const NTFY_PRIORITY: Record<NotificationSeverity, number> = { info: 3, success: 3, warning: 4, error: 5 };
const NTFY_TAGS: Record<NotificationSeverity, string> = {
  info: "information_source",
  success: "white_check_mark",
  warning: "warning",
  error: "rotating_light",
};

const EMAIL_ADDRESS = /[^\s@<>()[\]"',;:*/]+@[^\s@<>()[\]"',;:]+\.[A-Za-z]{2,}/g;

export function cleanUserText(raw: unknown, limit = USER_TEXT_LIMIT): string {
  const s = redactSecrets(String(raw ?? ""))
    .replace(EMAIL_ADDRESS, "[email]")
    .replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (s.length <= limit) return s;
  return `${s.slice(0, limit - 1).trimEnd()}…`;
}

function neutralize(s: string): string {
  return s
    .replace(/:\/\//g, `:/${ZWSP}/`)
    .replace(/@(everyone|here|channel|all|group)\b/gi, `@${ZWSP}$1`)
    .replace(/\]\(/g, `]${ZWSP}(`)
    .replace(/<([@#!&])/g, `<${ZWSP}$1`);
}

export function discordText(s: string): string {
  return neutralize(s).replace(/([\\*_~`|>#\-[\]()<:])/g, "\\$1");
}

export function discordTitle(s: string): string {
  return neutralize(s);
}

export function slackText(s: string): string {
  return neutralize(s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;"));
}

export function plainText(s: string): string {
  return neutralize(s);
}

function clipTo(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

function iconFor(iconUrl: string | null): string {
  return iconUrl ?? DEFAULT_ICON_URL;
}

export function discordBody(event: NotificationEvent, iconUrl: string | null): Record<string, unknown> {
  const embed: Record<string, unknown> = {
    title: clipTo(discordTitle(event.title), 256),
    description: clipTo(discordText(event.message), 4000),
    color: SEVERITY_COLORS[event.severity],
    timestamp: new Date(event.occurredAt).toISOString(),
  };
  if (event.fields.length > 0) {
    embed.fields = event.fields.slice(0, 6).map((f) => ({
      name: clipTo(f.label, 256),
      value: clipTo(discordText(f.value) || "-", 1024),
      inline: true,
    }));
  }
  if (event.link) embed.url = event.link;
  return {
    username: SENDER_NAME,
    avatar_url: iconFor(iconUrl),
    allowed_mentions: { parse: [] },
    embeds: [embed],
  };
}

function hexColor(n: number): string {
  return `#${n.toString(16).padStart(6, "0").toUpperCase()}`;
}

export function slackBody(event: NotificationEvent, iconUrl: string | null): Record<string, unknown> {
  const title = slackText(event.title);
  const attachment: Record<string, unknown> = {
    color: hexColor(SEVERITY_COLORS[event.severity]),
    fallback: title,
    title,
    text: slackText(event.message),
    ts: Math.floor(event.occurredAt / 1000),
  };
  if (event.link) attachment.title_link = event.link;
  if (event.fields.length > 0) {
    attachment.fields = event.fields.slice(0, 6).map((f) => ({ title: f.label, value: slackText(f.value), short: true }));
  }
  return {
    text: title,
    username: SENDER_NAME,
    icon_url: iconFor(iconUrl),
    attachments: [attachment],
  };
}

export function ntfyBody(
  event: NotificationEvent,
  config: { topic: string; priority: number | null },
  iconUrl: string | null,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    topic: config.topic,
    title: clipTo(plainText(event.title), 250),
    message: clipTo(plainText(event.message), 4000),
    priority: config.priority ?? NTFY_PRIORITY[event.severity],
    tags: [NTFY_TAGS[event.severity]],
    icon: iconFor(iconUrl),
  };
  if (event.link) body.click = event.link;
  return body;
}

export function webhookPayload(event: NotificationEvent, iconUrl: string | null): NotificationWebhookPayload {
  const payload: NotificationWebhookPayload = {
    version: 1,
    product: "lambdata",
    id: event.id,
    type: event.type,
    group: event.group,
    severity: event.severity,
    occurredAt: new Date(event.occurredAt).toISOString(),
    title: event.title,
    message: event.message,
    actor: event.actor,
    database: event.database,
    data: { ...event.data },
    link: event.link,
    iconUrl: iconFor(iconUrl),
  };
  if (event.changes) payload.changes = { tables: event.changes.tables.map((t) => ({ ...t })), truncated: event.changes.truncated === true };
  return payload;
}

export function signWebhook(secret: string, timestamp: number, body: string): string {
  return `sha256=${createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex")}`;
}

export function ntfyServerUrl(server: string): string {
  const url = new URL(server);
  if (!url.pathname.endsWith("/")) url.pathname = `${url.pathname}/`;
  url.search = "";
  url.hash = "";
  return url.toString();
}

export function renderRequest(
  config: StoredConfig,
  dest: { iconUrl: string | null },
  event: NotificationEvent,
  deliveryId: string,
  now: number,
): RenderedRequest {
  const base = { "User-Agent": SENDER_NAME, "Content-Type": "application/json" };
  switch (config.kind) {
    case "discord":
      return { url: config.url, headers: { ...base }, body: JSON.stringify(discordBody(event, dest.iconUrl)) };
    case "slack":
      return { url: config.url, headers: { ...base }, body: JSON.stringify(slackBody(event, dest.iconUrl)) };
    case "ntfy": {
      const headers: Record<string, string> = { ...base };
      if (config.token) headers.Authorization = `Bearer ${config.token}`;
      return {
        url: ntfyServerUrl(config.server),
        headers,
        body: JSON.stringify(ntfyBody(event, { topic: config.topic, priority: config.priority }, dest.iconUrl)),
      };
    }
    case "webhook": {
      const body = JSON.stringify(webhookPayload(event, dest.iconUrl));
      const timestamp = Math.floor(now / 1000);
      const headers: Record<string, string> = { ...config.headers, ...base };
      headers["X-LambData-Event"] = event.type;
      headers["X-LambData-Delivery"] = deliveryId;
      headers["X-LambData-Timestamp"] = String(timestamp);
      if (config.secret) headers["X-LambData-Signature"] = signWebhook(config.secret, timestamp, body);
      return { url: config.url, headers, body };
    }
  }
}
