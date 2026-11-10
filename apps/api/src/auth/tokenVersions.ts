import { db } from "../db/client";

type Subject = "console" | "app";

const TABLE: Record<Subject, string> = {
  console: "users",
  app: "app_auth_users",
};

function current(subject: Subject, id: string): number | null {
  const row = db.query(`SELECT token_version FROM ${TABLE[subject]} WHERE id = ?`).get(id) as
    | { token_version: number | null }
    | null;
  return row ? Number(row.token_version ?? 0) : null;
}

function bump(subject: Subject, id: string): number | null {
  db.query(`UPDATE ${TABLE[subject]} SET token_version = token_version + 1 WHERE id = ?`).run(id);
  return current(subject, id);
}

export function consoleTokenVersion(userId: string): number | null {
  return current("console", userId);
}

export function revokeConsoleSessions(userId: string): number | null {
  return bump("console", userId);
}

export function appTokenVersion(appUserId: string): number | null {
  return current("app", appUserId);
}

export function revokeAppSessions(appUserId: string): number | null {
  return bump("app", appUserId);
}

export function tokenVersionMatches(claimed: unknown, stored: number | null): boolean {
  if (stored === null) return false;
  const version = claimed === undefined ? 0 : claimed;
  return typeof version === "number" && Number.isInteger(version) && version === stored;
}
