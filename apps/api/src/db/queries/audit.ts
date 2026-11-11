import type { AuditLogEntry } from "@lambdata/shared";
import { db } from "../client";
import { notifyAudit } from "../../notifications/bus";

export const REDACTED = "[redacted]";

const SENSITIVE_FRAGMENTS = ["password", "passwd", "secret", "credential"];
const SENSITIVE_SUFFIXES = ["token", "authkey", "apikey", "privatekey", "pwd", "enc"];
const SENSITIVE_NAMES = ["authorization", "cookie"];
const MAX_DEPTH = 32;

export function isSensitiveAuditKey(key: string, action: string): boolean {
  const k = key.toLowerCase().replace(/[_-]/g, "");
  if (SENSITIVE_FRAGMENTS.some((f) => k.includes(f))) return true;
  if (SENSITIVE_SUFFIXES.some((s) => k.endsWith(s))) return true;
  if (SENSITIVE_NAMES.includes(k)) return true;
  return key.toLowerCase() === "value" && action.toLowerCase().includes("secret");
}

function redactValue(value: unknown, action: string, depth: number): unknown {
  if (depth > MAX_DEPTH) return REDACTED;
  if (Array.isArray(value)) return value.map((v) => redactValue(v, action, depth + 1));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
      out[key] = isSensitiveAuditKey(key, action) ? REDACTED : redactValue(inner, action, depth + 1);
    }
    return out;
  }
  return value;
}

export function redactAuditDetails(action: string, details: unknown): unknown {
  return redactValue(details, action, 0);
}

function serializeDetails(action: string, details: unknown): string | null {
  if (details === undefined) return null;
  try {
    return JSON.stringify(redactAuditDetails(action, details)) ?? null;
  } catch {
    return JSON.stringify({ note: "details could not be serialized" });
  }
}

export const audit = {
  log(userId: string | null, action: string, target: string | null, details: unknown): void {
    db.query(
      `INSERT INTO audit_log(user_id, actor_email, action, target, details, at)
       VALUES(?, (SELECT email FROM users WHERE id = ?), ?, ?, ?, ?)`,
    ).run(userId, userId, action, target, serializeDetails(action, details), Date.now());
    notifyAudit(userId, action, target, details);
  },
  list(limit = 20): AuditLogEntry[] {
    return db
      .query(
        `SELECT a.id, a.user_id, a.action, a.target, a.details, a.at,
                CASE WHEN u.kind = 'token' THEN NULL ELSE COALESCE(u.email, a.actor_email) END AS user_email,
                u.display_name AS user_display_name,
                CASE WHEN u.kind = 'token' THEN 'token' ELSE 'user' END AS actor_kind,
                t.id AS token_id
         FROM audit_log a
         LEFT JOIN users u ON a.user_id = u.id
         LEFT JOIN access_tokens t ON t.actor_user_id = a.user_id
         ORDER BY a.at DESC, a.id DESC
         LIMIT ?`,
      )
      .all(limit) as AuditLogEntry[];
  },
};
