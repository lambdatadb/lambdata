import type { Checkpoint, CheckpointDiff, CheckpointTrigger, WorkingCopyStatus } from "@lambdata/shared";
import type { BadgeProps } from "../ui/Badge";
import { formatBytes, formatNumber, pluralize } from "../../lib/format";

export const AUTOMATIC_TRIGGERS: readonly CheckpointTrigger[] = ["scheduled", "sync", "pre-sync", "pre-restore", "pre-import", "pre-agent"];

export function isAutomatic(trigger: CheckpointTrigger): boolean {
  return AUTOMATIC_TRIGGERS.includes(trigger);
}

const TRIGGERS: Record<CheckpointTrigger, { label: string; variant: NonNullable<BadgeProps["variant"]>; hint: string }> = {
  manual: { label: "manual", variant: "outline", hint: "Created by hand" },
  scheduled: { label: "auto", variant: "muted", hint: "Automatic checkpoint from the schedule" },
  sync: { label: "sync", variant: "info", hint: "Automatic checkpoint taken right after a sync" },
  "pre-sync": { label: "pre-sync", variant: "muted", hint: "Saved before a sync because the mirror had local changes" },
  "pre-restore": { label: "safety", variant: "warn", hint: "Saved automatically before a rollback replaced the data" },
  "pre-import": { label: "pre-import", variant: "muted", hint: "Saved automatically before an import" },
  "pre-agent": { label: "undo point", variant: "warn", hint: "Saved automatically before an access token changed data, so the change can be undone" },
  import: { label: "import", variant: "info", hint: "Recorded after an import" },
  legacy: { label: "snapshot", variant: "muted", hint: "Converted from an older snapshot" },
};

export function triggerMeta(trigger: CheckpointTrigger) {
  return TRIGGERS[trigger] ?? { label: trigger, variant: "muted" as const, hint: trigger };
}

export function isLegacy(cp: Pick<Checkpoint, "format">): boolean {
  return cp.format === "legacy";
}

export function newBytesLabel(cp: Pick<Checkpoint, "newBytes">): string {
  return cp.newBytes > 0 ? `+${formatBytes(cp.newBytes)} new` : "no new data";
}

export function savingsPercent(stored: number, logical: number): number | null {
  if (logical <= 0) return null;
  const saved = 1 - stored / logical;
  return Math.max(0, Math.round(saved * 100));
}

export function signed(n: number): string {
  if (n === 0) return "±0";
  return `${n > 0 ? "+" : "−"}${formatNumber(Math.abs(n))}`;
}

export function diffChangeCount(diff: CheckpointDiff | null | undefined): number {
  if (!diff) return 0;
  return diff.tables.length + (diff.codeChanged ? 1 : 0);
}

export function diffSummary(diff: CheckpointDiff): string {
  const parts: string[] = [];
  if (diff.tables.length > 0) parts.push(`${pluralize(diff.tables.length, "table")} changed`);
  if (diff.codeChanged) parts.push("code changed");
  if (diff.rowDelta !== null && diff.rowDelta !== 0) parts.push(`${signed(diff.rowDelta)} ${Math.abs(diff.rowDelta) === 1 ? "row" : "rows"}`);
  if (parts.length === 0) return "No changes";
  return parts.join(", ");
}

function listNames(names: string[], max = 3): string {
  if (names.length <= max) {
    if (names.length <= 1) return names[0] ?? "";
    return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
  }
  return `${names.slice(0, max).join(", ")} and ${names.length - max} more`;
}

export function defaultCheckpointMessage(status: WorkingCopyStatus | null | undefined): string {
  const diff = status?.state === "dirty" ? status.diff : null;
  if (!diff) return "Manual checkpoint";
  const added = diff.tables.filter((t) => t.change === "added").map((t) => t.name);
  const removed = diff.tables.filter((t) => t.change === "removed").map((t) => t.name);
  const modified = diff.tables.filter((t) => t.change === "modified").map((t) => t.name);
  const parts: string[] = [];
  if (added.length) parts.push(`Add ${listNames(added, 2)}`);
  if (modified.length) parts.push(`${parts.length ? "update" : "Update"} ${listNames(modified, 2)}`);
  if (removed.length) parts.push(`${parts.length ? "drop" : "Drop"} ${listNames(removed, 2)}`);
  if (parts.length === 0 && diff.codeChanged) return "Update views, triggers and routines";
  return parts.join("; ");
}

export function shortId(cp: Pick<Checkpoint, "shortHash"> | null | undefined): string {
  return cp?.shortHash ?? "—";
}

export function sizeTitle(cp: Checkpoint): string {
  const lines = [
    `${formatBytes(cp.logicalBytes)} of SQL`,
    `${formatBytes(cp.storedBytes)} compressed`,
    cp.newBytes > 0
      ? `${formatBytes(cp.newBytes)} written new; the rest is shared with other checkpoints`
      : "Every table was already stored by another checkpoint",
  ];
  return lines.join(" · ");
}
