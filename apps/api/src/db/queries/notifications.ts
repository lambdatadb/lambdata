import type {
  NotificationDelivery,
  NotificationDeliveryStatus,
  NotificationDestination,
  NotificationDestinationHealth,
  NotificationEventType,
  NotificationKind,
} from "@lambdata/shared";
import { db } from "../client";

export const FAILING_AFTER = 3;

type DestinationRow = {
  id: string;
  name: string;
  kind: NotificationKind;
  enabled: number;
  config_enc: string;
  target: string;
  has_secret: number;
  header_names: string;
  ntfy_priority: number | null;
  events: string;
  database_ids: string | null;
  icon_url: string | null;
  last_success_at: number | null;
  last_failure_at: number | null;
  last_error: string | null;
  consecutive_failures: number;
  created_by_user_id: string | null;
  created_at: number;
  updated_at: number;
};

type DeliveryRow = {
  id: string;
  destination_id: string;
  event_type: string;
  title: string;
  payload: string;
  status: NotificationDeliveryStatus;
  attempts: number;
  response_status: number | null;
  last_error: string | null;
  created_at: number;
  sent_at: number | null;
  next_attempt_at: number | null;
};

export interface DestinationRecord {
  id: string;
  name: string;
  kind: NotificationKind;
  enabled: boolean;
  configEnc: string;
  target: string;
  hasSecret: boolean;
  headerNames: string[];
  ntfyPriority: number | null;
  events: NotificationEventType[];
  databaseIds: string[] | null;
  iconUrl: string | null;
  createdByUserId: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface DestinationMatch {
  id: string;
  events: Set<string>;
  databaseIds: Set<string> | null;
}

export interface DeliveryRecord {
  id: string;
  destinationId: string;
  eventType: string;
  title: string;
  payload: string;
  status: NotificationDeliveryStatus;
  attempts: number;
  createdAt: number;
  nextAttemptAt: number | null;
}

export interface NewDelivery {
  id: string;
  destinationId: string;
  eventType: string;
  title: string;
  payload: string;
  createdAt: number;
}

function parseList(raw: string | null): string[] | null {
  if (raw === null) return null;
  try {
    const value = JSON.parse(raw) as unknown;
    return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
  } catch {
    return [];
  }
}

export function healthOf(r: {
  last_success_at: number | null;
  consecutive_failures: number;
}): NotificationDestinationHealth {
  if (r.consecutive_failures >= FAILING_AFTER) return "failing";
  if (r.last_success_at !== null) return "ok";
  return "new";
}

function toPublic(r: DestinationRow): NotificationDestination {
  return {
    id: r.id,
    name: r.name,
    kind: r.kind,
    enabled: r.enabled === 1,
    target: r.target,
    hasSecret: r.has_secret === 1,
    headerNames: parseList(r.header_names) ?? [],
    ntfyPriority: r.ntfy_priority,
    events: (parseList(r.events) ?? []) as NotificationEventType[],
    databaseIds: parseList(r.database_ids),
    iconUrl: r.icon_url,
    health: healthOf(r),
    lastSuccessAt: r.last_success_at,
    lastFailureAt: r.last_failure_at,
    lastError: r.last_error,
    consecutiveFailures: r.consecutive_failures,
    createdByUserId: r.created_by_user_id,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function toRecord(r: DestinationRow): DestinationRecord {
  return {
    id: r.id,
    name: r.name,
    kind: r.kind,
    enabled: r.enabled === 1,
    configEnc: r.config_enc,
    target: r.target,
    hasSecret: r.has_secret === 1,
    headerNames: parseList(r.header_names) ?? [],
    ntfyPriority: r.ntfy_priority,
    events: (parseList(r.events) ?? []) as NotificationEventType[],
    databaseIds: parseList(r.database_ids),
    iconUrl: r.icon_url,
    createdByUserId: r.created_by_user_id,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function toDelivery(r: DeliveryRow): NotificationDelivery {
  return {
    id: r.id,
    destinationId: r.destination_id,
    eventType: r.event_type as NotificationDelivery["eventType"],
    title: r.title,
    status: r.status,
    attempts: r.attempts,
    responseStatus: r.response_status,
    lastError: r.last_error,
    createdAt: r.created_at,
    sentAt: r.sent_at,
    nextAttemptAt: r.next_attempt_at,
  };
}

function toDeliveryRecord(r: DeliveryRow): DeliveryRecord {
  return {
    id: r.id,
    destinationId: r.destination_id,
    eventType: r.event_type,
    title: r.title,
    payload: r.payload,
    status: r.status,
    attempts: r.attempts,
    createdAt: r.created_at,
    nextAttemptAt: r.next_attempt_at,
  };
}

export type DestinationPatch = Partial<
  Pick<
    DestinationRecord,
    "name" | "enabled" | "configEnc" | "target" | "hasSecret" | "headerNames" | "ntfyPriority" | "events" | "databaseIds" | "iconUrl"
  >
>;

const PATCH_COLUMNS: Record<keyof DestinationPatch, string> = {
  name: "name",
  enabled: "enabled",
  configEnc: "config_enc",
  target: "target",
  hasSecret: "has_secret",
  headerNames: "header_names",
  ntfyPriority: "ntfy_priority",
  events: "events",
  databaseIds: "database_ids",
  iconUrl: "icon_url",
};

function patchValue(key: keyof DestinationPatch, value: unknown): string | number | null {
  if (key === "enabled" || key === "hasSecret") return value ? 1 : 0;
  if (key === "headerNames" || key === "events") return JSON.stringify(value ?? []);
  if (key === "databaseIds") return value === null || value === undefined ? null : JSON.stringify(value);
  return (value ?? null) as string | number | null;
}

export const notificationDestinations = {
  list(): NotificationDestination[] {
    const rows = db.query("SELECT * FROM notification_destinations ORDER BY created_at ASC, id ASC").all() as DestinationRow[];
    return rows.map(toPublic);
  },
  byId(id: string): NotificationDestination | null {
    const r = db.query("SELECT * FROM notification_destinations WHERE id = ?").get(id) as DestinationRow | null;
    return r ? toPublic(r) : null;
  },
  recordById(id: string): DestinationRecord | null {
    const r = db.query("SELECT * FROM notification_destinations WHERE id = ?").get(id) as DestinationRow | null;
    return r ? toRecord(r) : null;
  },
  count(): number {
    const r = db.query("SELECT COUNT(*) AS n FROM notification_destinations").get() as { n: number };
    return Number(r.n);
  },
  enabledMatches(): DestinationMatch[] {
    const rows = db
      .query("SELECT id, events, database_ids FROM notification_destinations WHERE enabled = 1")
      .all() as Pick<DestinationRow, "id" | "events" | "database_ids">[];
    return rows.map((r) => {
      const ids = parseList(r.database_ids);
      return { id: r.id, events: new Set(parseList(r.events) ?? []), databaseIds: ids === null ? null : new Set(ids) };
    });
  },
  insert(rec: DestinationRecord): void {
    db.query(
      `INSERT INTO notification_destinations(id, name, kind, enabled, config_enc, target, has_secret, header_names,
        ntfy_priority, events, database_ids, icon_url, consecutive_failures, created_by_user_id, created_at, updated_at)
       VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`,
    ).run(
      rec.id,
      rec.name,
      rec.kind,
      rec.enabled ? 1 : 0,
      rec.configEnc,
      rec.target,
      rec.hasSecret ? 1 : 0,
      JSON.stringify(rec.headerNames),
      rec.ntfyPriority,
      JSON.stringify(rec.events),
      rec.databaseIds === null ? null : JSON.stringify(rec.databaseIds),
      rec.iconUrl,
      rec.createdByUserId,
      rec.createdAt,
      rec.updatedAt,
    );
  },
  update(id: string, patch: DestinationPatch, at: number): void {
    const sets: string[] = [];
    const params: (string | number | null)[] = [];
    for (const key of Object.keys(patch) as (keyof DestinationPatch)[]) {
      if (patch[key] === undefined) continue;
      sets.push(`${PATCH_COLUMNS[key]} = ?`);
      params.push(patchValue(key, patch[key]));
    }
    sets.push("updated_at = ?");
    params.push(at, id);
    db.query(`UPDATE notification_destinations SET ${sets.join(", ")} WHERE id = ?`).run(...params);
  },
  delete(id: string): boolean {
    return db.transaction(() => {
      db.query("DELETE FROM notification_deliveries WHERE destination_id = ?").run(id);
      return Number(db.query("DELETE FROM notification_destinations WHERE id = ?").run(id).changes) > 0;
    })();
  },
  recordSuccess(id: string, at: number): void {
    db.query(
      "UPDATE notification_destinations SET last_success_at = ?, consecutive_failures = 0 WHERE id = ?",
    ).run(at, id);
  },
  recordAttemptFailure(id: string, at: number, error: string): void {
    db.query("UPDATE notification_destinations SET last_failure_at = ?, last_error = ? WHERE id = ?").run(at, error, id);
  },
  recordDeliveryFailure(id: string, at: number, error: string): void {
    db.query(
      `UPDATE notification_destinations SET last_failure_at = ?, last_error = ?, consecutive_failures = consecutive_failures + 1
       WHERE id = ?`,
    ).run(at, error, id);
  },
};

export const notificationDeliveries = {
  insertMany(rows: NewDelivery[]): void {
    const stmt = db.query(
      `INSERT INTO notification_deliveries(id, destination_id, event_type, title, payload, status, attempts, created_at)
       VALUES(?, ?, ?, ?, ?, 'queued', 0, ?)`,
    );
    db.transaction(() => {
      for (const r of rows) stmt.run(r.id, r.destinationId, r.eventType, r.title, r.payload, r.createdAt);
    })();
  },
  insertFinished(r: NewDelivery & {
    status: NotificationDeliveryStatus;
    attempts: number;
    responseStatus: number | null;
    lastError: string | null;
    sentAt: number | null;
  }): void {
    db.query(
      `INSERT INTO notification_deliveries(id, destination_id, event_type, title, payload, status, attempts, response_status,
        last_error, created_at, sent_at)
       VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(r.id, r.destinationId, r.eventType, r.title, r.payload, r.status, r.attempts, r.responseStatus, r.lastError, r.createdAt, r.sentAt);
  },
  byId(id: string): DeliveryRecord | null {
    const r = db.query("SELECT * FROM notification_deliveries WHERE id = ?").get(id) as DeliveryRow | null;
    return r ? toDeliveryRecord(r) : null;
  },
  publicById(id: string): NotificationDelivery | null {
    const r = db.query("SELECT * FROM notification_deliveries WHERE id = ?").get(id) as DeliveryRow | null;
    return r ? toDelivery(r) : null;
  },
  nextQueued(destinationId: string): DeliveryRecord | null {
    const r = db
      .query(
        `SELECT * FROM notification_deliveries WHERE destination_id = ? AND status = 'queued'
         ORDER BY created_at ASC, rowid ASC LIMIT 1`,
      )
      .get(destinationId) as DeliveryRow | null;
    return r ? toDeliveryRecord(r) : null;
  },
  markSending(id: string, attempts: number): void {
    db.query("UPDATE notification_deliveries SET status = 'sending', attempts = ?, next_attempt_at = NULL WHERE id = ?").run(
      attempts,
      id,
    );
  },
  markSent(id: string, at: number, responseStatus: number | null): void {
    db.query(
      `UPDATE notification_deliveries SET status = 'sent', sent_at = ?, response_status = ?, next_attempt_at = NULL
       WHERE id = ?`,
    ).run(at, responseStatus, id);
  },
  markRetry(id: string, nextAt: number, responseStatus: number | null, error: string): void {
    db.query(
      `UPDATE notification_deliveries SET status = 'queued', next_attempt_at = ?, response_status = ?, last_error = ?
       WHERE id = ?`,
    ).run(nextAt, responseStatus, error, id);
  },
  markFailed(id: string, responseStatus: number | null, error: string): void {
    db.query(
      `UPDATE notification_deliveries SET status = 'failed', response_status = ?, last_error = ?, next_attempt_at = NULL
       WHERE id = ?`,
    ).run(responseStatus, error, id);
  },
  requeue(id: string, attempts: number): void {
    db.query("UPDATE notification_deliveries SET status = 'queued', attempts = ? WHERE id = ? AND status = 'sending'").run(
      attempts,
      id,
    );
  },
  coalesceFresh(destinationId: string, now: number, reason: string): { title: string; eventType: string }[] {
    return db.transaction(() => {
      const rows = db
        .query(
          `SELECT id, title, event_type FROM notification_deliveries
           WHERE destination_id = ? AND status = 'queued' AND attempts = 0 AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
           ORDER BY created_at ASC, rowid ASC`,
        )
        .all(destinationId, now) as { id: string; title: string; event_type: string }[];
      const stmt = db.query("UPDATE notification_deliveries SET status = 'dropped', last_error = ? WHERE id = ?");
      for (const r of rows) stmt.run(reason, r.id);
      return rows.map((r) => ({ title: r.title, eventType: r.event_type }));
    })();
  },
  dropQueued(destinationId: string, reason: string): number {
    const res = db
      .query(
        `UPDATE notification_deliveries SET status = 'dropped', last_error = ?, next_attempt_at = NULL
         WHERE destination_id = ? AND status IN ('queued', 'sending')`,
      )
      .run(reason, destinationId);
    return Number(res.changes);
  },
  list(destinationId: string, limit: number): NotificationDelivery[] {
    const rows = db
      .query(
        `SELECT * FROM notification_deliveries WHERE destination_id = ?
         ORDER BY created_at DESC, rowid DESC LIMIT ?`,
      )
      .all(destinationId, limit) as DeliveryRow[];
    return rows.map(toDelivery);
  },
  destinationsWithQueued(): string[] {
    const rows = db
      .query(
        `SELECT DISTINCT d.destination_id AS id FROM notification_deliveries d
         JOIN notification_destinations n ON n.id = d.destination_id
         WHERE d.status = 'queued' AND n.enabled = 1`,
      )
      .all() as { id: string }[];
    return rows.map((r) => r.id);
  },
  resetSending(): number {
    return Number(db.query("UPDATE notification_deliveries SET status = 'queued' WHERE status = 'sending'").run().changes);
  },
  prune(destinationId: string, keep: number, cutoff: number): number {
    return db.transaction(() => {
      let removed = Number(
        db.query("DELETE FROM notification_deliveries WHERE destination_id = ? AND created_at < ?").run(destinationId, cutoff).changes,
      );
      removed += Number(
        db
          .query(
            `DELETE FROM notification_deliveries WHERE destination_id = ? AND id NOT IN (
               SELECT id FROM notification_deliveries WHERE destination_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?)`,
          )
          .run(destinationId, destinationId, keep).changes,
      );
      return removed;
    })();
  },
  pruneAll(keep: number, cutoff: number): number {
    const ids = (db.query("SELECT id FROM notification_destinations").all() as { id: string }[]).map((r) => r.id);
    let removed = Number(db.query("DELETE FROM notification_deliveries WHERE created_at < ?").run(cutoff).changes);
    for (const id of ids) removed += notificationDeliveries.prune(id, keep, cutoff);
    return removed;
  },
  countFor(destinationId: string): number {
    const r = db.query("SELECT COUNT(*) AS n FROM notification_deliveries WHERE destination_id = ?").get(destinationId) as { n: number };
    return Number(r.n);
  },
};

export const notificationState = {
  get(key: string): string | null {
    const r = db.query("SELECT value FROM notification_state WHERE key = ?").get(key) as { value: string } | null;
    return r?.value ?? null;
  },
  set(key: string, value: string, at: number = Date.now()): void {
    db.query(
      `INSERT INTO notification_state(key, value, updated_at) VALUES(?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    ).run(key, value, at);
  },
  delete(key: string): void {
    db.query("DELETE FROM notification_state WHERE key = ?").run(key);
  },
};
