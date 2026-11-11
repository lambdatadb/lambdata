import type { Job } from "@lambdata/shared";

export interface AuditNote {
  userId: string | null;
  action: string;
  target: string | null;
  details: unknown;
  at: number;
}

export interface NotificationHooks {
  audit?: (note: AuditNote) => void;
  jobFinished?: (job: Job) => void;
  snapshotUnconverted?: (snapshotId: string, databaseId: string) => void;
}

const WATCHED_PREFIXES = ["db.", "checkpoint.", "user.", "data_api.access.", "network.policy.", "access_token.", "approval."];

let hooks: NotificationHooks = {};

export function setNotificationHooks(next: NotificationHooks): void {
  hooks = next;
}

function defer(fn: () => void): void {
  queueMicrotask(() => {
    try {
      fn();
    } catch {}
  });
}

export function notifyAudit(userId: string | null, action: string, target: string | null, details: unknown): void {
  try {
    const handler = hooks.audit;
    if (!handler || !WATCHED_PREFIXES.some((p) => action.startsWith(p))) return;
    const note: AuditNote = { userId, action, target, details, at: Date.now() };
    defer(() => handler(note));
  } catch {}
}

export function notifyJobFinished(job: Job): void {
  try {
    const handler = hooks.jobFinished;
    if (!handler) return;
    defer(() => handler(job));
  } catch {}
}

export function notifySnapshotUnconverted(snapshotId: string, databaseId: string): void {
  try {
    const handler = hooks.snapshotUnconverted;
    if (!handler) return;
    defer(() => handler(snapshotId, databaseId));
  } catch {}
}
