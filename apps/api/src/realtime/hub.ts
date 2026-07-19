import type {
  AppAuthUser,
  RealtimeChannelStatus,
  RealtimeStatus,
} from "@kilndb/shared";
import { appUserFromToken, bearerTokenFromHeader } from "../auth/appBearer";

interface RealtimeSocketData {
  id: string;
  user: AppAuthUser;
  channels: Set<string>;
  presence: Map<string, Record<string, unknown>>;
}

type RealtimeSocket = Bun.ServerWebSocket<RealtimeSocketData>;

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
}

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
  const user = await appUserFromToken(token);
  if (!user) return null;
  return {
    id: crypto.randomUUID(),
    user,
    channels: new Set(),
    presence: new Map(),
  };
}

export const realtimeWebSocketHandlers: Bun.WebSocketHandler<RealtimeSocketData> = {
  open(ws) {
    clients.add(ws);
    send(ws, {
      type: "system",
      event: "connected",
      socketId: ws.data.id,
      user: publicUser(ws.data.user),
      sentAt: Date.now(),
    });
  },
  message(ws, raw) {
    try {
      handleMessage(ws, raw);
    } catch (err) {
      send(ws, {
        type: "error",
        event: "message_error",
        error: err instanceof Error ? err.message : "invalid realtime message",
        sentAt: Date.now(),
      });
    }
  },
  close(ws) {
    for (const channel of [...ws.data.channels]) {
      unsubscribe(ws, channel);
    }
    clients.delete(ws);
  },
};

export function publishBroadcast(input: BroadcastInput): number {
  const channel = normalizeChannel(input.channel);
  const event = normalizeEvent(input.event);
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

export function publishDatabaseChange(input: DatabaseChangeInput): void {
  const tableChannel = databaseTableChannel(input.database, input.table);
  const databaseChannel = databaseChannelName(input.database);
  const message = {
    type: "db_changes",
    channel: tableChannel,
    event: input.operation,
    payload: {
      database: input.database,
      table: input.table,
      operation: input.operation,
      ...input.payload,
    },
    user: input.sender ? publicUser(input.sender) : null,
    sentAt: Date.now(),
  };
  broadcast(tableChannel, message);
  broadcast(databaseChannel, { ...message, channel: databaseChannel });
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

function handleMessage(ws: RealtimeSocket, raw: string | ArrayBuffer | Uint8Array): void {
  const msg = JSON.parse(messageText(raw)) as Record<string, unknown>;
  const type = stringValue(msg.type);
  if (type === "ping") {
    send(ws, { type: "system", event: "pong", sentAt: Date.now() });
    return;
  }
  if (type === "subscribe") {
    const channel = normalizeChannel(stringValue(msg.channel));
    subscribe(ws, channel, recordValue(msg.presence));
    return;
  }
  if (type === "unsubscribe") {
    unsubscribe(ws, normalizeChannel(stringValue(msg.channel)));
    return;
  }
  if (type === "presence") {
    const channel = normalizeChannel(stringValue(msg.channel));
    if (!ws.data.channels.has(channel)) throw new Error("subscribe before sending presence");
    ws.data.presence.set(channel, recordValue(msg.state) ?? {});
    broadcastPresence(channel);
    return;
  }
  if (type === "broadcast") {
    const channel = normalizeChannel(stringValue(msg.channel));
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

function subscribe(
  ws: RealtimeSocket,
  channel: string,
  presence: Record<string, unknown> | null,
): void {
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

function unsubscribe(ws: RealtimeSocket, channel: string): void {
  const sockets = channels.get(channel);
  sockets?.delete(ws);
  if (sockets && sockets.size === 0) channels.delete(channel);
  ws.data.channels.delete(channel);
  ws.data.presence.delete(channel);
  broadcastPresence(channel);
  send(ws, { type: "system", event: "unsubscribed", channel, sentAt: Date.now() });
}

function broadcastPresence(channel: string): void {
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
  for (const socket of sockets) {
    if (excludeUserId && socket.data.user.id === excludeUserId) continue;
    socket.send(encoded);
    delivered++;
  }
  messagesSent += delivered;
  return delivered;
}

function send(ws: RealtimeSocket, message: unknown): void {
  ws.send(JSON.stringify(message));
}

function messageText(raw: string | ArrayBuffer | Uint8Array): string {
  if (typeof raw === "string") return raw;
  if (raw instanceof Uint8Array) return new TextDecoder().decode(raw);
  return new TextDecoder().decode(new Uint8Array(raw));
}

function normalizeChannel(value: string): string {
  const channel = value.trim();
  if (!/^[a-zA-Z0-9:_./-]{1,128}$/.test(channel)) {
    throw new Error("channel must be 1-128 chars using letters, numbers, :, _, ., /, or -");
  }
  return channel;
}

function normalizeEvent(value: string): string {
  const event = value.trim();
  if (!/^[a-zA-Z0-9:_./-]{1,80}$/.test(event)) {
    throw new Error("event must be 1-80 chars using letters, numbers, :, _, ., /, or -");
  }
  return event;
}

function stringValue(value: unknown): string {
  if (typeof value !== "string" || value.trim() === "") throw new Error("string value required");
  return value;
}

function recordValue(value: unknown): Record<string, unknown> | null {
  if (value == null) return null;
  if (typeof value !== "object" || Array.isArray(value)) throw new Error("object value required");
  return value as Record<string, unknown>;
}

function publicUser(user: AppAuthUser) {
  return {
    id: user.id,
    email: user.email,
    displayName: user.displayName,
  };
}
