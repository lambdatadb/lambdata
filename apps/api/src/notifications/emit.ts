import type { NotificationEventType, Role, TableRowChange } from "@lambdata/shared";
import { accessTokenForUser } from "../accessTokens";
import { databases, users } from "../db/queries";
import { notificationDeliveries, notificationDestinations, type DestinationMatch } from "../db/queries/notifications";
import { sanitizeErrorMessage } from "../jobs/sanitize";
import { loadNetworkConfig } from "../network/config";
import { newId } from "../util/id";
import { eventInfo } from "./catalog";
import { cleanUserText, type EventField, type NotificationEvent } from "./format";
import { kickDestination } from "./worker";

export interface EventContent {
  title: string;
  message: string;
  actor?: { displayName: string } | null;
  database?: DatabaseRef | null;
  fields?: EventField[];
  data?: Record<string, string | number | boolean | null>;
  changes?: { tables: TableRowChange[]; truncated: boolean } | null;
  linkPath?: string | null;
  occurredAt?: number;
  unchanged?: boolean;
}

export interface DatabaseRef {
  id: string;
  name: string;
  displayName: string;
}

let lastLoggedAt = 0;

function logProblem(err: unknown): void {
  const now = Date.now();
  if (now - lastLoggedAt < 60_000) return;
  lastLoggedAt = now;
  console.error("[notifications] could not queue a notification:", sanitizeErrorMessage(err).slice(0, 300));
}

export function enabledDestinations(): DestinationMatch[] {
  try {
    return notificationDestinations.enabledMatches();
  } catch {
    return [];
  }
}

export function anyEnabledDestination(): boolean {
  return enabledDestinations().length > 0;
}

export const actorLookup = {
  token: accessTokenForUser,
};

function matching(type: NotificationEventType, databaseId: string | null): DestinationMatch[] {
  const perDatabase = eventInfo(type).perDatabase;
  return enabledDestinations().filter((d) => {
    if (!d.events.has(type)) return false;
    if (!perDatabase || d.databaseIds === null) return true;
    return databaseId !== null && d.databaseIds.has(databaseId);
  });
}

export function consoleLink(path: string | null | undefined): string | null {
  if (!path) return null;
  try {
    const first = loadNetworkConfig().publicUrls[0];
    if (!first) return null;
    const base = new URL(first);
    if (base.protocol !== "http:" && base.protocol !== "https:") return null;
    return `${base.origin}${path}`;
  } catch {
    return null;
  }
}

export function emit(type: NotificationEventType, databaseId: string | null, build: () => EventContent | null): number {
  try {
    const candidates = matching(type, databaseId);
    if (candidates.length === 0) return 0;
    const content = build();
    if (!content) return 0;
    const targets = content.unchanged === true ? candidates.filter((d) => !d.skipUnchanged) : candidates;
    if (targets.length === 0) return 0;
    const info = eventInfo(type);
    const event: NotificationEvent = {
      id: newId("evt"),
      type,
      group: info.group,
      severity: info.severity,
      occurredAt: content.occurredAt ?? Date.now(),
      title: content.title,
      message: content.message,
      actor: content.actor ?? null,
      database: content.database ?? null,
      fields: content.fields ?? [],
      data: content.data ?? {},
      ...(content.changes ? { changes: content.changes } : {}),
      link: consoleLink(content.linkPath),
    };
    const payload = JSON.stringify(event);
    const createdAt = Date.now();
    notificationDeliveries.insertMany(
      targets.map((t) => ({
        id: newId("ndl"),
        destinationId: t.id,
        eventType: type,
        title: event.title,
        payload,
        createdAt,
      })),
    );
    for (const t of targets) kickDestination(t.id);
    return targets.length;
  } catch (err) {
    logProblem(err);
    return 0;
  }
}

const ROLE_FALLBACK: Record<Role, string> = {
  admin: "An admin",
  db_owner: "A database owner",
  viewer: "A viewer",
};

const FALLBACK_NAMES = new Set([...Object.values(ROLE_FALLBACK), "Someone", "A user", "A new user"]);

const EMAIL_LIKE = /[^\s@]+@[^\s@]+\.[^\s@]+/;

const userNames = new Map<string, string>();
const databaseNames = new Map<string, DatabaseRef>();

export function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export function mid(name: string): string {
  return FALLBACK_NAMES.has(name) ? name.charAt(0).toLowerCase() + name.slice(1) : name;
}

export function personName(user: { displayName: string | null; role: Role }): string {
  const cleaned = cleanUserText(user.displayName ?? "");
  if (cleaned && !EMAIL_LIKE.test(cleaned)) return cleaned;
  return ROLE_FALLBACK[user.role] ?? "Someone";
}

export function rememberUser(id: string): string | null {
  try {
    const u = users.byId(id);
    if (!u) return userNames.get(id) ?? null;
    const name = personName(u);
    userNames.set(id, name);
    return name;
  } catch {
    return userNames.get(id) ?? null;
  }
}

export function knownUserName(id: string): string | null {
  return userNames.get(id) ?? null;
}

export function forgetUser(id: string): void {
  userNames.delete(id);
}

export const TOKEN_SUFFIX = " (access token)";

export function tokenActorName(name: unknown): string {
  return `${cleanUserText(name, 100) || "Unnamed"}${TOKEN_SUFFIX}`;
}

export function tokenOf(userId: string | null | undefined): { id: string; name: string } | null {
  if (!userId) return null;
  try {
    return actorLookup.token(userId);
  } catch {
    return null;
  }
}

export function actorOf(userId: string | null): { displayName: string } | null {
  if (!userId) return null;
  const token = tokenOf(userId);
  if (token) return { displayName: tokenActorName(token.name) };
  return { displayName: rememberUser(userId) ?? "Someone" };
}

export function subjectOf(actor: { displayName: string } | null): string {
  return actor ? actor.displayName : "LambData";
}

export function databaseRef(id: string | null, fallbackName?: unknown): DatabaseRef | null {
  if (!id) return null;
  try {
    const row = databases.byId(id);
    if (row) {
      const ref = { id: row.id, name: row.name, displayName: cleanUserText(row.displayName) || row.name };
      databaseNames.set(id, ref);
      return ref;
    }
  } catch {}
  const cached = databaseNames.get(id);
  if (cached) return cached;
  const name = typeof fallbackName === "string" && fallbackName ? cleanUserText(fallbackName, 64) : "";
  return { id, name: name || id, displayName: name || "a database" };
}

export function forgetDatabase(id: string): void {
  databaseNames.delete(id);
}

export function refreshNameCaches(): void {
  try {
    for (const u of users.list()) userNames.set(u.id, personName(u));
    for (const d of databases.list()) {
      databaseNames.set(d.id, { id: d.id, name: d.name, displayName: cleanUserText(d.displayName) || d.name });
    }
  } catch {}
}

export function count(n: number, one: string, many = `${one}s`): string {
  return `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;
}
