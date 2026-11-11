import type {
  AccessToken,
  Approval,
  ApprovalAction,
  ApprovalStatus,
  AccessTokenPreset,
  AccessTokenStatus,
  AccessTokenVia,
  IngressKind,
  TokenActivityEntry,
  TokenActivityOutcome,
} from "@lambdata/shared";
import { db } from "../client";
import { settings } from "./settings";

const ALL_PAUSED_KEY = "access_tokens_paused";
export const ACTIVITY_MAX_PER_TOKEN = 5000;
export const ACTIVITY_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const PRUNE_EVERY = 100;

type TokenRow = {
  id: string;
  name: string;
  preset: AccessTokenPreset;
  prefix: string;
  secret_hash: string;
  actor_user_id: string;
  created_by_user_id: string | null;
  created_by_display_name: string | null;
  creator_display_name?: string | null;
  created_at: number;
  expires_at: number | null;
  revoked_at: number | null;
  paused: number;
  database_ids: string | null;
  allowed_from: string;
  reveal_credentials: number;
  ask_first: number;
  max_databases: number | null;
  requests_per_minute: number;
  last_used_at: number | null;
  last_used_from: string | null;
  last_used_via: AccessTokenVia | null;
};

export interface StoredAccessToken {
  id: string;
  name: string;
  preset: AccessTokenPreset;
  prefix: string;
  actorUserId: string;
  createdByUserId: string | null;
  createdByDisplayName: string | null;
  createdAt: number;
  expiresAt: number | null;
  revokedAt: number | null;
  paused: boolean;
  databaseIds: string[] | null;
  allowedFrom: IngressKind[];
  revealCredentials: boolean;
  askFirst: boolean;
  maxDatabases: number | null;
  requestsPerMinute: number;
  lastUsedAt: number | null;
  lastUsedFrom: string | null;
  lastUsedVia: AccessTokenVia | null;
}

const INGRESS: readonly IngressKind[] = ["loopback", "lan", "tailnet", "cloudflare"];

function parseList(raw: string | null): string[] | null {
  if (raw === null) return null;
  try {
    const value = JSON.parse(raw) as unknown;
    return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
  } catch {
    return [];
  }
}

function rowToStored(r: TokenRow): StoredAccessToken {
  return {
    id: r.id,
    name: r.name,
    preset: r.preset,
    prefix: r.prefix,
    actorUserId: r.actor_user_id,
    createdByUserId: r.created_by_user_id,
    createdByDisplayName: r.creator_display_name ?? r.created_by_display_name,
    createdAt: r.created_at,
    expiresAt: r.expires_at,
    revokedAt: r.revoked_at,
    paused: r.paused === 1,
    databaseIds: parseList(r.database_ids),
    allowedFrom: (parseList(r.allowed_from) ?? []).filter((k): k is IngressKind => (INGRESS as string[]).includes(k)),
    revealCredentials: r.reveal_credentials === 1,
    askFirst: r.ask_first === 1,
    maxDatabases: r.max_databases,
    requestsPerMinute: r.requests_per_minute,
    lastUsedAt: r.last_used_at,
    lastUsedFrom: r.last_used_from,
    lastUsedVia: r.last_used_via,
  };
}

export function tokenStatus(t: StoredAccessToken, now: number = Date.now()): AccessTokenStatus {
  if (t.revokedAt !== null) return "revoked";
  if (t.expiresAt !== null && t.expiresAt <= now) return "expired";
  if (t.paused) return "paused";
  return "active";
}

const TOKEN_SELECT = `
  SELECT t.*, u.display_name AS creator_display_name
  FROM access_tokens t
  LEFT JOIN users u ON u.id = t.created_by_user_id
`;

type ActivityRow = {
  id: number;
  token_id: string;
  at: number;
  via: AccessTokenVia;
  action: string;
  summary: string;
  database_id: string | null;
  database_name: string | null;
  outcome: TokenActivityOutcome;
  status: number;
  note: string | null;
  from_address: string | null;
  detail: string | null;
};

function rowToActivity(r: ActivityRow): TokenActivityEntry {
  return {
    id: r.id,
    tokenId: r.token_id,
    at: r.at,
    via: r.via,
    action: r.action,
    summary: r.summary,
    databaseId: r.database_id,
    databaseName: r.database_name,
    outcome: r.outcome,
    status: r.status,
    note: r.note,
    from: r.from_address,
    detail: r.detail,
  };
}

export interface NewTokenActivity {
  tokenId: string;
  via: AccessTokenVia;
  action: string;
  summary: string;
  databaseId: string | null;
  databaseName: string | null;
  outcome: TokenActivityOutcome;
  status: number;
  note: string | null;
  from: string | null;
  detail: string | null;
}

export const accessTokens = {
  insert(t: {
    id: string;
    name: string;
    preset: AccessTokenPreset;
    prefix: string;
    secretHash: string;
    actorUserId: string;
    actorEmail: string;
    actorRole: string;
    createdByUserId: string;
    createdByDisplayName: string | null;
    expiresAt: number | null;
    databaseIds: string[] | null;
    allowedFrom: IngressKind[];
    revealCredentials: boolean;
    askFirst: boolean;
    maxDatabases: number | null;
    requestsPerMinute: number;
  }): void {
    const now = Date.now();
    db.transaction(() => {
      db.query(
        `INSERT INTO users(id, email, password_hash, display_name, role, experience_level, created_at, kind)
         VALUES(?, ?, '!', ?, ?, 'advanced', ?, 'token')`,
      ).run(t.actorUserId, t.actorEmail, t.name, t.actorRole, now);
      db.query(
        `INSERT INTO access_tokens(id, name, preset, prefix, secret_hash, actor_user_id, created_by_user_id,
           created_by_display_name, created_at, expires_at, database_ids, allowed_from, reveal_credentials,
           ask_first, max_databases, requests_per_minute)
         VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        t.id,
        t.name,
        t.preset,
        t.prefix,
        t.secretHash,
        t.actorUserId,
        t.createdByUserId,
        t.createdByDisplayName,
        now,
        t.expiresAt,
        t.databaseIds === null ? null : JSON.stringify(t.databaseIds),
        JSON.stringify(t.allowedFrom),
        t.revealCredentials ? 1 : 0,
        t.askFirst ? 1 : 0,
        t.maxDatabases,
        t.requestsPerMinute,
      );
    })();
  },
  list(): StoredAccessToken[] {
    const rows = db.query(`${TOKEN_SELECT} ORDER BY t.created_at DESC, t.id DESC`).all() as TokenRow[];
    return rows.map(rowToStored);
  },
  byId(id: string): StoredAccessToken | null {
    const r = db.query(`${TOKEN_SELECT} WHERE t.id = ?`).get(id) as TokenRow | null;
    return r ? rowToStored(r) : null;
  },
  bySecretHash(hash: string): StoredAccessToken | null {
    const r = db.query(`${TOKEN_SELECT} WHERE t.secret_hash = ?`).get(hash) as TokenRow | null;
    return r ? rowToStored(r) : null;
  },
  byActor(userId: string): StoredAccessToken | null {
    const r = db.query(`${TOKEN_SELECT} WHERE t.actor_user_id = ?`).get(userId) as TokenRow | null;
    return r ? rowToStored(r) : null;
  },
  nameForActor(userId: string): { id: string; name: string } | null {
    const r = db.query("SELECT id, name FROM access_tokens WHERE actor_user_id = ?").get(userId) as
      | { id: string; name: string }
      | null;
    return r ? { id: r.id, name: r.name } : null;
  },
  databasesCreated(id: string): number {
    const r = db.query("SELECT COUNT(*) AS n FROM databases WHERE created_by_token_id = ?").get(id) as { n: number };
    return Number(r.n);
  },
  update(
    id: string,
    patch: Partial<{
      name: string;
      paused: boolean;
      expiresAt: number | null;
      databaseIds: string[] | null;
      allowedFrom: IngressKind[];
      revealCredentials: boolean;
      askFirst: boolean;
      maxDatabases: number | null;
      requestsPerMinute: number;
    }>,
  ): void {
    const sets: string[] = [];
    const vals: (string | number | null)[] = [];
    const put = (col: string, value: string | number | null) => {
      sets.push(`${col} = ?`);
      vals.push(value);
    };
    if (patch.name !== undefined) put("name", patch.name);
    if (patch.paused !== undefined) put("paused", patch.paused ? 1 : 0);
    if (patch.expiresAt !== undefined) put("expires_at", patch.expiresAt);
    if (patch.databaseIds !== undefined) put("database_ids", patch.databaseIds === null ? null : JSON.stringify(patch.databaseIds));
    if (patch.allowedFrom !== undefined) put("allowed_from", JSON.stringify(patch.allowedFrom));
    if (patch.revealCredentials !== undefined) put("reveal_credentials", patch.revealCredentials ? 1 : 0);
    if (patch.askFirst !== undefined) put("ask_first", patch.askFirst ? 1 : 0);
    if (patch.maxDatabases !== undefined) put("max_databases", patch.maxDatabases);
    if (patch.requestsPerMinute !== undefined) put("requests_per_minute", patch.requestsPerMinute);
    if (sets.length === 0) return;
    db.transaction(() => {
      db.query(`UPDATE access_tokens SET ${sets.join(", ")} WHERE id = ?`).run(...vals, id);
      if (patch.name !== undefined) {
        db.query(
          "UPDATE users SET display_name = ? WHERE id = (SELECT actor_user_id FROM access_tokens WHERE id = ?) AND kind = 'token'",
        ).run(patch.name, id);
      }
    })();
  },
  revoke(id: string, at: number = Date.now()): boolean {
    const res = db.query("UPDATE access_tokens SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL").run(at, id);
    return res.changes > 0;
  },
  revokeCreatedBy(userId: string, at: number = Date.now()): { id: string; name: string }[] {
    const rows = db
      .query("SELECT id, name FROM access_tokens WHERE created_by_user_id = ? AND revoked_at IS NULL")
      .all(userId) as { id: string; name: string }[];
    if (rows.length > 0) {
      db.query("UPDATE access_tokens SET revoked_at = ? WHERE created_by_user_id = ? AND revoked_at IS NULL").run(at, userId);
    }
    return rows;
  },
  touch(id: string, at: number, from: string | null, via: AccessTokenVia): void {
    db.query("UPDATE access_tokens SET last_used_at = ?, last_used_from = ?, last_used_via = ? WHERE id = ?").run(
      at,
      from,
      via,
      id,
    );
  },
  allPaused(): boolean {
    return settings.getBool(ALL_PAUSED_KEY, false);
  },
  setAllPaused(paused: boolean): void {
    settings.set(ALL_PAUSED_KEY, paused ? "1" : "0");
  },
  toPublic(t: StoredAccessToken, now: number = Date.now()): AccessToken {
    return {
      id: t.id,
      name: t.name,
      preset: t.preset,
      prefix: t.prefix,
      status: tokenStatus(t, now),
      paused: t.paused,
      createdAt: t.createdAt,
      createdByUserId: t.createdByUserId,
      createdByDisplayName: t.createdByDisplayName,
      expiresAt: t.expiresAt,
      revokedAt: t.revokedAt,
      lastUsedAt: t.lastUsedAt,
      lastUsedFrom: t.lastUsedFrom,
      lastUsedVia: t.lastUsedVia,
      databaseIds: t.databaseIds,
      allowedFrom: t.allowedFrom,
      revealCredentials: t.revealCredentials,
      askFirst: t.askFirst,
      limits: { maxDatabases: t.maxDatabases, requestsPerMinute: t.requestsPerMinute },
      databasesCreated: accessTokens.databasesCreated(t.id),
      pendingApprovals: approvals.pendingCount(t.id),
    };
  },
};

export const tokenActivity = {
  insert(e: NewTokenActivity, at: number = Date.now()): number {
    const res = db
      .query(
        `INSERT INTO access_token_activity(token_id, at, via, action, summary, database_id, database_name,
           outcome, status, note, from_address, detail)
         VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        e.tokenId,
        at,
        e.via,
        e.action,
        e.summary,
        e.databaseId,
        e.databaseName,
        e.outcome,
        e.status,
        e.note,
        e.from,
        e.detail,
      );
    const id = Number(res.lastInsertRowid);
    if (id % PRUNE_EVERY === 0) tokenActivity.prune(e.tokenId, at);
    return id;
  },
  prune(tokenId: string, now: number = Date.now()): void {
    db.query("DELETE FROM access_token_activity WHERE at < ?").run(now - ACTIVITY_MAX_AGE_MS);
    db.query(
      `DELETE FROM access_token_activity
       WHERE token_id = ? AND id <= (
         SELECT id FROM access_token_activity WHERE token_id = ? ORDER BY id DESC LIMIT 1 OFFSET ?
       )`,
    ).run(tokenId, tokenId, ACTIVITY_MAX_PER_TOKEN);
  },
  list(tokenId: string, opts: { before?: number; limit: number }): TokenActivityEntry[] {
    const rows = (
      opts.before !== undefined
        ? db
            .query("SELECT * FROM access_token_activity WHERE token_id = ? AND id < ? ORDER BY id DESC LIMIT ?")
            .all(tokenId, opts.before, opts.limit)
        : db.query("SELECT * FROM access_token_activity WHERE token_id = ? ORDER BY id DESC LIMIT ?").all(tokenId, opts.limit)
    ) as ActivityRow[];
    return rows.map(rowToActivity);
  },
};

export const PENDING_APPROVAL_MS = 24 * 60 * 60 * 1000;
export const APPROVED_USE_MS = 60 * 60 * 1000;

type ApprovalRow = {
  id: string;
  token_id: string;
  token_name: string | null;
  action: ApprovalAction;
  method: string;
  path: string;
  body_hash: string;
  summary: string;
  detail: string | null;
  database_id: string | null;
  database_name: string | null;
  note: string | null;
  status: ApprovalStatus;
  requested_at: number;
  expires_at: number;
  decided_at: number | null;
  decided_by_display_name: string | null;
  approved_until: number | null;
  used_at: number | null;
};

export interface StoredApproval extends Approval {
  method: string;
  path: string;
  bodyHash: string;
}

function rowToApproval(r: ApprovalRow): StoredApproval {
  return {
    id: r.id,
    tokenId: r.token_id,
    tokenName: r.token_name ?? "",
    action: r.action,
    summary: r.summary,
    detail: r.detail,
    databaseId: r.database_id,
    databaseName: r.database_name,
    note: r.note,
    status: r.status,
    requestedAt: r.requested_at,
    expiresAt: r.expires_at,
    decidedAt: r.decided_at,
    decidedByDisplayName: r.decided_by_display_name,
    approvedUntil: r.status === "approved" || r.status === "used" ? r.approved_until : null,
    usedAt: r.used_at,
    method: r.method,
    path: r.path,
    bodyHash: r.body_hash,
  };
}

export function publicApproval(a: StoredApproval): Approval {
  const { method: _m, path: _p, bodyHash: _h, ...rest } = a;
  void _m;
  void _p;
  void _h;
  return rest;
}

const APPROVAL_SELECT = `
  SELECT a.*, t.name AS token_name
  FROM access_token_approvals a
  LEFT JOIN access_tokens t ON t.id = a.token_id
`;

export const approvals = {
  expireStale(now: number = Date.now()): void {
    db.query(
      `UPDATE access_token_approvals SET status = 'expired'
       WHERE (status = 'pending' AND expires_at <= ?) OR (status = 'approved' AND approved_until <= ?)`,
    ).run(now, now);
  },
  insert(a: {
    id: string;
    tokenId: string;
    action: ApprovalAction;
    method: string;
    path: string;
    bodyHash: string;
    summary: string;
    detail: string | null;
    databaseId: string | null;
    databaseName: string | null;
    note: string | null;
    requestedAt: number;
  }): void {
    db.query(
      `INSERT INTO access_token_approvals(id, token_id, action, method, path, body_hash, summary, detail,
         database_id, database_name, note, status, requested_at, expires_at)
       VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
    ).run(
      a.id,
      a.tokenId,
      a.action,
      a.method,
      a.path,
      a.bodyHash,
      a.summary,
      a.detail,
      a.databaseId,
      a.databaseName,
      a.note,
      a.requestedAt,
      a.requestedAt + PENDING_APPROVAL_MS,
    );
  },
  byId(id: string): StoredApproval | null {
    approvals.expireStale();
    const r = db.query(`${APPROVAL_SELECT} WHERE a.id = ?`).get(id) as ApprovalRow | null;
    return r ? rowToApproval(r) : null;
  },
  pendingFor(tokenId: string, method: string, path: string, bodyHash: string): StoredApproval | null {
    approvals.expireStale();
    const r = db
      .query(
        `${APPROVAL_SELECT} WHERE a.token_id = ? AND a.method = ? AND a.path = ? AND a.body_hash = ? AND a.status = 'pending'
         ORDER BY a.requested_at DESC LIMIT 1`,
      )
      .get(tokenId, method, path, bodyHash) as ApprovalRow | null;
    return r ? rowToApproval(r) : null;
  },
  list(filter: { tokenId?: string; status?: ApprovalStatus; limit: number }): StoredApproval[] {
    approvals.expireStale();
    const where: string[] = [];
    const params: (string | number)[] = [];
    if (filter.tokenId !== undefined) {
      where.push("a.token_id = ?");
      params.push(filter.tokenId);
    }
    if (filter.status !== undefined) {
      where.push("a.status = ?");
      params.push(filter.status);
    }
    params.push(filter.limit);
    const rows = db
      .query(
        `${APPROVAL_SELECT} ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
         ORDER BY CASE a.status WHEN 'pending' THEN 0 ELSE 1 END, a.requested_at DESC LIMIT ?`,
      )
      .all(...params) as ApprovalRow[];
    return rows.map(rowToApproval);
  },
  pendingCount(tokenId?: string, now: number = Date.now()): number {
    const r = (
      tokenId === undefined
        ? db.query("SELECT COUNT(*) AS n FROM access_token_approvals WHERE status = 'pending' AND expires_at > ?").get(now)
        : db
            .query("SELECT COUNT(*) AS n FROM access_token_approvals WHERE status = 'pending' AND expires_at > ? AND token_id = ?")
            .get(now, tokenId)
    ) as { n: number };
    return Number(r.n);
  },
  decide(id: string, decision: "approved" | "denied", by: { userId: string; displayName: string | null }, now: number = Date.now()): boolean {
    const res = db
      .query(
        `UPDATE access_token_approvals
         SET status = ?, decided_at = ?, decided_by_user_id = ?, decided_by_display_name = ?, approved_until = ?
         WHERE id = ? AND status = 'pending' AND expires_at > ?`,
      )
      .run(decision, now, by.userId, by.displayName, decision === "approved" ? now + APPROVED_USE_MS : null, id, now);
    return res.changes > 0;
  },
  claim(id: string, tokenId: string, now: number = Date.now()): boolean {
    const res = db
      .query(
        `UPDATE access_token_approvals SET status = 'used', used_at = ?
         WHERE id = ? AND token_id = ? AND status = 'approved' AND approved_until > ?`,
      )
      .run(now, id, tokenId, now);
    return res.changes > 0;
  },
  unclaim(id: string): void {
    db.query("UPDATE access_token_approvals SET status = 'approved', used_at = NULL WHERE id = ? AND status = 'used'").run(id);
  },
  cancel(id: string, tokenId: string): boolean {
    const res = db
      .query(
        `UPDATE access_token_approvals SET status = 'cancelled'
         WHERE id = ? AND token_id = ? AND status IN ('pending', 'approved')`,
      )
      .run(id, tokenId);
    return res.changes > 0;
  },
};

export interface StoredUndoPoint {
  tokenId: string;
  databaseId: string;
  checkpointId: string;
  createdAt: number;
  lastChangeAt: number;
}

export const undoPoints = {
  get(tokenId: string, databaseId: string): StoredUndoPoint | null {
    const r = db
      .query("SELECT * FROM access_token_undo_points WHERE token_id = ? AND database_id = ?")
      .get(tokenId, databaseId) as
      | { token_id: string; database_id: string; checkpoint_id: string; created_at: number; last_change_at: number }
      | null;
    return r
      ? { tokenId: r.token_id, databaseId: r.database_id, checkpointId: r.checkpoint_id, createdAt: r.created_at, lastChangeAt: r.last_change_at }
      : null;
  },
  set(tokenId: string, databaseId: string, checkpointId: string, now: number = Date.now()): void {
    db.query(
      `INSERT INTO access_token_undo_points(token_id, database_id, checkpoint_id, created_at, last_change_at)
       VALUES(?, ?, ?, ?, ?)
       ON CONFLICT(token_id, database_id) DO UPDATE SET checkpoint_id = excluded.checkpoint_id,
         created_at = excluded.created_at, last_change_at = excluded.last_change_at`,
    ).run(tokenId, databaseId, checkpointId, now, now);
  },
  touch(tokenId: string, databaseId: string, now: number = Date.now()): void {
    db.query("UPDATE access_token_undo_points SET last_change_at = ? WHERE token_id = ? AND database_id = ?").run(
      now,
      tokenId,
      databaseId,
    );
  },
};
