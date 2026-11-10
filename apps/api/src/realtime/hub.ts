import type {
  AppAuthUser,
  RealtimeChannelStatus,
  RealtimeStatus,
} from "@lambdata/shared";
import { appSessionFromToken, bearerTokenFromHeader } from "../auth/appBearer";
import {
  anyTableReadable,
  baseTableExists,
  decideDataAccess,
  recordMissingPolicyDenial,
} from "../auth/dataAccess";
import { databases } from "../db/queries";
import { isSafeIdent } from "../util/ident";

export interface RealtimeSocketData {
  id: string;
  user: AppAuthUser;
  expiresAt: number;
  channels: Set<string>;
  presence: Map<string, Record<string, unknown>>;
  queue: Promise<void>;
}

export interface RealtimeSocket {
  data: RealtimeSocketData;
  send(message: string): unknown;
  close(code?: number, reason?: string): void;
}

interface BroadcastInput {
  channel: string;
  event: string;
  payload: unknown;
  sender?: AppAuthUser | null;
  self?: boolean;
}

interface DatabaseChangeInput {
  database: string;
  table: string;
  operation: "INSERT" | "UPDATE" | "DELETE";
  payload: Record<string, unknown>;
  sender?: AppAuthUser | null;
  ownerId?: string | null;
}

export type ChannelTarget =
  | { kind: "app" }
  | { kind: "database"; database: string }
  | { kind: "table"; database: string; table: string }
  | { kind: "reserved" };

export class RealtimeError extends Error {
  readonly status: 400 | 403;

  constructor(status: 400 | 403, message: string) {
    super(message);
    this.name = "RealtimeError";
    this.status = status;
  }
}

const CHANNEL_PATTERN = /^[a-zA-Z0-9:_./-]{1,128}$/;
const EVENT_PATTERN = /^[a-zA-Z0-9:_./-]{1,80}$/;
const DATABASE_CHANNEL_PREFIX = "db:";
const TOKEN_EXPIRED_CLOSE_CODE = 4001;
const SESSION_REVOKED_CLOSE_CODE = 4003;

const clients = new Set<RealtimeSocket>();
const channels = new Map<string, Set<RealtimeSocket>>();
let messagesSent = 0;

export async function realtimeSocketDataFromRequest(req: Request): Promise<RealtimeSocketData | null> {
  const url = new URL(req.url);
  const token =
    url.searchParams.get("token") ??
    bearerTokenFromHeader(req.headers.get("Authorization")) ??
    bearerTokenFromHeader(req.headers.get("Sec-WebSocket-Protocol"));
  if (!token) return null;
  const session = await appSessionFromToken(token);
  if (!session) return null;
  return {
    id: crypto.randomUUID(),
    user: session.user,
    expiresAt: session.expiresAt,
    channels: new Set(),
    presence: new Map(),
    queue: Promise.resolve(),
  };
}

export const realtimeWebSocketHandlers: Bun.WebSocketHandler<RealtimeSocketData> = {
  open(ws) {
    openSocket(ws);
  },
  message(ws, raw) {
    receiveMessage(ws, raw);
  },
  close(ws) {
    closeSocket(ws);
  },
};

export function openSocket(ws: RealtimeSocket): void {
  clients.add(ws);
  send(ws, {
    type: "system",
    event: "connected",
    socketId: ws.data.id,
    user: publicUser(ws.data.user),
    sentAt: Date.now(),
  });
}

export function receiveMessage(ws: RealtimeSocket, raw: string | ArrayBuffer | Uint8Array): Promise<void> {
  ws.data.queue = ws.data.queue.then(async () => {
    try {
      await handleMessage(ws, raw);
    } catch (err) {
      send(ws, {
        type: "error",
        event: "message_error",
        error: err instanceof Error ? err.message : "invalid realtime message",
        sentAt: Date.now(),
      });
    }
  });
  return ws.data.queue;
}

export function closeSocket(ws: RealtimeSocket): void {
  for (const channel of [...ws.data.channels]) {
    unsubscribe(ws, channel, false);
  }
  clients.delete(ws);
}

export function disconnectAppUser(appUserId: string): number {
  let closed = 0;
  for (const socket of [...clients]) {
    if (socket.data.user.id !== appUserId) continue;
    closeSocket(socket);
    safeClose(socket, SESSION_REVOKED_CLOSE_CODE, "session revoked");
    closed++;
  }
  return closed;
}

export function channelTarget(channel: string): ChannelTarget {
  if (!channel.startsWith(DATABASE_CHANNEL_PREFIX)) return { kind: "app" };
  const parts = channel.split(":");
  if (parts.length === 2 && isSafeIdent(parts[1]!)) return { kind: "database", database: parts[1]! };
  if (parts.length === 4 && parts[2] === "table" && isSafeIdent(parts[1]!) && isSafeIdent(parts[3]!)) {
    return { kind: "table", database: parts[1]!, table: parts[3]! };
  }
  return { kind: "reserved" };
}

export function isDatabaseChannel(channel: string): boolean {
  return channelTarget(channel).kind !== "app";
}

export function normalizeChannel(value: string): string {
  const channel = value.trim();
  if (!CHANNEL_PATTERN.test(channel)) {
    throw new RealtimeError(400, "channel must be 1-128 chars using letters, numbers, :, _, ., /, or -");
  }
  return channel;
}

export function normalizeEvent(value: string): string {
  const event = value.trim();
  if (!EVENT_PATTERN.test(event)) {
    throw new RealtimeError(400, "event must be 1-80 chars using letters, numbers, :, _, ., /, or -");
  }
  return event;
}

export function assertBroadcastAllowed(channel: string): void {
  if (isDatabaseChannel(channel)) {
    throw new RealtimeError(
      403,
      "channels starting with db: carry database changes made through the Data API; app users cannot broadcast into them",
    );
  }
}

export function publishBroadcast(input: BroadcastInput): number {
  const channel = normalizeChannel(input.channel);
  const event = normalizeEvent(input.event);
  assertBroadcastAllowed(channel);
  const message = {
    type: "broadcast",
    channel,
    event,
    payload: input.payload ?? null,
    user: input.sender ? publicUser(input.sender) : null,
    sentAt: Date.now(),
  };
  return broadcast(channel, message, input.self === false ? input.sender?.id ?? null : null);
}

export function publishDatabaseChange(input: DatabaseChangeInput): number {
  const database = databases.byName(input.database);
  if (!database) return 0;
  const decision = decideDataAccess(database, input.table, "select");
  if (!decision.allowed) return 0;
  const payload: Record<string, unknown> = {
    database: input.database,
    table: input.table,
    operation: input.operation,
    ...input.payload,
  };
  const author = input.sender ? { id: input.sender.id, displayName: input.sender.displayName } : null;
  const sentAt = Date.now();
  let delivered = 0;
  for (const channel of [databaseTableChannel(input.database, input.table), databaseChannelName(input.database)]) {
    const sockets = channels.get(channel);
    if (!sockets) continue;
    for (const socket of [...sockets]) {
      if (!socketUsable(socket)) continue;
      const scoped = decision.ownerColumn
        ? scopeToOwner(payload, decision.ownerColumn, input.ownerId ?? null, socket.data.user.id)
        : payload;
      if (!scoped) continue;
      socket.send(JSON.stringify({ type: "db_changes", channel, event: input.operation, payload: scoped, user: author, sentAt }));
      delivered++;
    }
  }
  messagesSent += delivered;
  return delivered;
}

export function realtimeStatus(): RealtimeStatus {
  const channelStatuses: RealtimeChannelStatus[] = [...channels.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, sockets]) => ({
      name,
      subscribers: sockets.size,
      presence: presenceForChannel(name).length,
    }));
  return {
    connections: clients.size,
    channels: channelStatuses,
    messagesSent,
  };
}

export function databaseTableChannel(database: string, table: string): string {
  return `db:${database}:table:${table}`;
}

export function databaseChannelName(database: string): string {
  return `db:${database}`;
}

function scopeToOwner(
  payload: Record<string, unknown>,
  ownerColumn: string,
  ownerId: string | null,
  subscriberId: string,
): Record<string, unknown> | null {
  if (payload.operation === "INSERT") {
    const rows = payload.new;
    if (Array.isArray(rows)) {
      const mine = rows.filter((row) => isRecord(row) && row[ownerColumn] === subscriberId);
      return mine.length > 0 ? { ...payload, new: mine } : null;
    }
    if (isRecord(rows)) return rows[ownerColumn] === subscriberId ? payload : null;
  } else if (ownerId) {
    return ownerId === subscriberId ? payload : null;
  }
  return {
    database: payload.database,
    table: payload.table,
    operation: payload.operation,
    affectedRows: payload.affectedRows ?? null,
  };
}

async function handleMessage(ws: RealtimeSocket, raw: string | ArrayBuffer | Uint8Array): Promise<void> {
  if (!socketUsable(ws)) return;
  const msg = JSON.parse(messageText(raw)) as Record<string, unknown>;
  const type = stringValue(msg.type);
  if (type === "ping") {
    send(ws, { type: "system", event: "pong", sentAt: Date.now() });
    return;
  }
  if (type === "subscribe") {
    const channel = normalizeChannel(stringValue(msg.channel));
    const presence = recordValue(msg.presence);
    await authorizeSubscribe(channel, presence);
    subscribe(ws, channel, presence);
    return;
  }
  if (type === "unsubscribe") {
    unsubscribe(ws, normalizeChannel(stringValue(msg.channel)), true);
    return;
  }
  if (type === "presence") {
    const channel = normalizeChannel(stringValue(msg.channel));
    if (!ws.data.channels.has(channel)) throw new Error("subscribe before sending presence");
    if (isDatabaseChannel(channel)) throw new Error("presence is not available on database-change channels");
    ws.data.presence.set(channel, recordValue(msg.state) ?? {});
    broadcastPresence(channel);
    return;
  }
  if (type === "broadcast") {
    const channel = normalizeChannel(stringValue(msg.channel));
    assertBroadcastAllowed(channel);
    if (!ws.data.channels.has(channel)) throw new Error("subscribe before broadcasting");
    publishBroadcast({
      channel,
      event: stringValue(msg.event),
      payload: msg.payload ?? null,
      sender: ws.data.user,
      self: msg.self !== false,
    });
    return;
  }
  throw new Error("unsupported realtime message type");
}

async function authorizeSubscribe(channel: string, presence: Record<string, unknown> | null): Promise<void> {
  const target = channelTarget(channel);
  if (target.kind === "app") return;
  if (target.kind === "reserved") {
    throw new RealtimeError(
      403,
      "channels starting with db: are reserved for database changes: use db:<database> or db:<database>:table:<table>",
    );
  }
  if (presence) throw new RealtimeError(403, "presence is not available on database-change channels");
  const database = databases.byName(target.database);
  if (!database || database.status !== "active") throw new RealtimeError(403, "database not found");
  if (target.kind === "database") {
    if (!anyTableReadable(database)) {
      throw new RealtimeError(
        403,
        `select denied: no table in ${database.name} allows select through the Data API. Add a policy that allows select, or switch the database's Data API access to open.`,
      );
    }
    return;
  }
  const decision = decideDataAccess(database, target.table, "select");
  if (decision.allowed) return;
  if (decision.reason === "no_policy" && (await baseTableExists(database.name, target.table))) {
    recordMissingPolicyDenial(database, target.table, "select");
  }
  throw new RealtimeError(403, decision.message);
}

function subscribe(ws: RealtimeSocket, channel: string, presence: Record<string, unknown> | null): void {
  let sockets = channels.get(channel);
  if (!sockets) {
    sockets = new Set();
    channels.set(channel, sockets);
  }
  sockets.add(ws);
  ws.data.channels.add(channel);
  if (presence) ws.data.presence.set(channel, presence);
  send(ws, { type: "system", event: "subscribed", channel, sentAt: Date.now() });
  broadcastPresence(channel);
}

function unsubscribe(ws: RealtimeSocket, channel: string, notify: boolean): void {
  const sockets = channels.get(channel);
  sockets?.delete(ws);
  if (sockets && sockets.size === 0) channels.delete(channel);
  ws.data.channels.delete(channel);
  ws.data.presence.delete(channel);
  broadcastPresence(channel);
  if (notify) send(ws, { type: "system", event: "unsubscribed", channel, sentAt: Date.now() });
}

function broadcastPresence(channel: string): void {
  if (isDatabaseChannel(channel)) return;
  broadcast(channel, {
    type: "presence",
    event: "sync",
    channel,
    users: presenceForChannel(channel),
    sentAt: Date.now(),
  });
}

function presenceForChannel(channel: string): Array<{
  socketId: string;
  user: ReturnType<typeof publicUser>;
  state: Record<string, unknown>;
}> {
  const sockets = channels.get(channel) ?? new Set<RealtimeSocket>();
  return [...sockets]
    .filter((socket) => socket.data.presence.has(channel))
    .map((socket) => ({
      socketId: socket.data.id,
      user: publicUser(socket.data.user),
      state: socket.data.presence.get(channel)!,
    }));
}

function broadcast(channel: string, message: unknown, excludeUserId?: string | null): number {
  const sockets = channels.get(channel);
  if (!sockets || sockets.size === 0) return 0;
  const encoded = JSON.stringify(message);
  let delivered = 0;
  for (const socket of [...sockets]) {
    if (excludeUserId && socket.data.user.id === excludeUserId) continue;
    if (!socketUsable(socket)) continue;
    socket.send(encoded);
    delivered++;
  }
  messagesSent += delivered;
  return delivered;
}

function socketUsable(socket: RealtimeSocket): boolean {
  if (socket.data.expiresAt > Date.now()) return true;
  closeSocket(socket);
  safeClose(socket, TOKEN_EXPIRED_CLOSE_CODE, "token expired");
  return false;
}

function safeClose(socket: RealtimeSocket, code: number, reason: string): void {
  try {
    socket.close(code, reason);
  } catch {}
}

function send(ws: RealtimeSocket, message: unknown): void {
  ws.send(JSON.stringify(message));
}

function messageText(raw: string | ArrayBuffer | Uint8Array): string {
  if (typeof raw === "string") return raw;
  if (raw instanceof Uint8Array) return new TextDecoder().decode(raw);
  return new TextDecoder().decode(new Uint8Array(raw));
}

function stringValue(value: unknown): string {
  if (typeof value !== "string" || value.trim() === "") throw new Error("string value required");
  return value;
}

function recordValue(value: unknown): Record<string, unknown> | null {
  if (value == null) return null;
  if (!isRecord(value)) throw new Error("object value required");
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function publicUser(user: AppAuthUser) {
  return {
    id: user.id,
    email: user.email,
    displayName: user.displayName,
  };
}
