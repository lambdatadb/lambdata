import { useMutation, useQueryClient } from "@tanstack/react-query";
import type {
  CheckpointListResponse,
  CheckpointPolicy,
  CheckpointPolicyResponse,
  Database,
  ManualSyncCheckpointMode,
  SyncCheckpointSkipReason,
  SyncJob,
  SyncJobResult,
  UpdateCheckpointPolicyRequest,
} from "@lambdata/shared";
import { api } from "../../lib/api";
import { queryKeys } from "../../lib/queries";
import { checkpointKeys, checkpointPath } from "./queries";

export const INTERVALS: { value: number; label: string }[] = [
  { value: 1, label: "One an hour" },
  { value: 6, label: "One every 6 hours" },
  { value: 12, label: "One every 12 hours" },
  { value: 24, label: "One a day" },
  { value: 168, label: "One a week" },
  { value: 0, label: "Off" },
];

export const SYNC_INTERVALS: { value: number; label: string }[] = [
  { value: 300, label: "Every 5 minutes" },
  { value: 900, label: "Every 15 minutes" },
  { value: 1800, label: "Every 30 minutes" },
  { value: 3600, label: "Every hour" },
  { value: 21600, label: "Every 6 hours" },
  { value: 43200, label: "Every 12 hours" },
  { value: 86400, label: "Every day" },
];

export function intervalLabel(hours: number): string {
  const known = INTERVALS.find((i) => i.value === hours);
  if (known) return known.label;
  return hours % 24 === 0 ? `One every ${hours / 24} days` : `One every ${hours} hours`;
}

export function syncIntervalLabel(seconds: number): string {
  const known = SYNC_INTERVALS.find((i) => i.value === seconds);
  if (known) return known.label;
  if (seconds % 86400 === 0) return `Every ${seconds / 86400} days`;
  if (seconds % 3600 === 0) return `Every ${seconds / 3600} hours`;
  if (seconds % 60 === 0) return `Every ${seconds / 60} minutes`;
  return `Every ${seconds} seconds`;
}

export function syncEvery(seconds: number): string {
  if (seconds === 3600) return "every hour";
  if (seconds === 86400) return "every day";
  return syncIntervalLabel(seconds).replace(/^Every/, "every");
}

export function manualMode(policy: Pick<CheckpointPolicy, "manualSyncCheckpoint"> | undefined): ManualSyncCheckpointMode {
  return policy?.manualSyncCheckpoint ?? "ask";
}

function periodNoun(hours: number): string | null {
  if (hours === 1) return "hour";
  if (hours === 24) return "day";
  if (hours === 168) return "week";
  return null;
}

export function spanText(hours: number): string {
  if (hours < 48) return hours === 1 ? "1 hour" : `${hours} hours`;
  if (hours < 24 * 14 || hours % 168 !== 0) {
    const days = Math.round(hours / 24);
    return days === 1 ? "1 day" : `${days} days`;
  }
  const weeks = hours / 168;
  return weeks === 1 ? "1 week" : `${weeks} weeks`;
}

export function takesAfterSync(policy: Pick<CheckpointPolicy, "versioned" | "checkpointOnSync" | "autoIntervalHours">, mirror: boolean): boolean {
  return mirror && policy.versioned && policy.checkpointOnSync && policy.autoIntervalHours > 0;
}

export function compactSummary(policy: Pick<CheckpointPolicy, "versioned" | "checkpointOnSync" | "autoIntervalHours" | "autoRetention">, mirror: boolean): string {
  if (policy.autoIntervalHours <= 0) return "Automatic checkpoints off";
  const parts = [intervalLabel(policy.autoIntervalHours), `keep ${policy.autoRetention}`];
  if (takesAfterSync(policy, mirror)) parts.push("after a sync");
  return parts.join(" · ");
}

export interface SummaryInput {
  kind: Database["kind"];
  policy: CheckpointPolicy;
  sync: Pick<SyncJob, "enabled" | "intervalSeconds"> | null;
}

export function settingsSummary({ kind, policy, sync }: SummaryInput): string[] {
  const mirror = kind === "mirror";
  const sentences: string[] = [];
  if (mirror) {
    if (!sync) sentences.push("This mirror has no source yet, so it does not sync.");
    else if (!sync.enabled) sentences.push("This mirror syncs only when you run it.");
    else sentences.push(`This mirror syncs ${syncEvery(sync.intervalSeconds)}.`);
  }
  const hours = policy.autoIntervalHours;
  if (hours <= 0) {
    sentences.push(mirror ? "Automatic checkpoints are off, so syncs record none." : "Automatic checkpoints are off.");
  } else {
    const noun = periodNoun(hours);
    const cadence = noun ? `per ${noun}` : intervalLabel(hours).replace(/^One /, "");
    let sentence = `One automatic checkpoint is kept ${cadence}, for ${spanText(hours * policy.autoRetention)}`;
    if (takesAfterSync(policy, mirror) && sync?.enabled) sentence += ", taken right after a sync";
    sentences.push(`${sentence}.`);
  }
  if (mirror && !policy.versioned) {
    sentences.push("It is not versioned, so syncs are never recorded as checkpoints.");
  } else if (mirror) {
    const mode = manualMode(policy);
    sentences.push(
      mode === "ask"
        ? "A manual sync asks whether to add another."
        : mode === "always"
          ? "A manual sync always adds another, kept until you delete it."
          : "A manual sync never adds one.",
    );
  }
  return sentences;
}

export function interactionNotes({ kind, policy, sync }: SummaryInput): string[] {
  if (kind !== "mirror") return [];
  const notes: string[] = [];
  if (policy.autoIntervalHours <= 0) {
    notes.push("With automatic checkpoints off, syncs record none; a manual sync can still add one.");
    return notes;
  }
  if (!policy.versioned || !policy.checkpointOnSync) return notes;
  if (sync && !sync.enabled) {
    notes.push("Sync is paused, so the schedule takes the automatic checkpoint on its own clock.");
  } else if (sync && sync.intervalSeconds > policy.autoIntervalHours * 3600) {
    notes.push(`The mirror syncs less often than that, so there is at most one checkpoint per sync.`);
  }
  return notes;
}

export function formatDue(at: number, now = Date.now()): string {
  const date = new Date(at);
  const time = date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  const sameDay = new Date(now).toDateString() === date.toDateString();
  if (sameDay) return time;
  if (at - now < 6 * 86_400_000 && at > now) return `${date.toLocaleDateString(undefined, { weekday: "short" })} ${time}`;
  return `${date.toLocaleDateString(undefined, { month: "short", day: "numeric" })} ${time}`;
}

function periodOwner(hours: number | null | undefined): string {
  if (hours === 24) return "today's";
  if (hours === 1) return "this hour's";
  if (hours === 168) return "this week's";
  return "the latest";
}

export interface SyncCheckpointLine {
  text: string;
  tone: "neutral" | "success" | "warn";
}

export function syncCheckpointLine(
  r: Pick<SyncJobResult, "checkpointKind" | "checkpointSkipped" | "nextAutomaticDueAt" | "checkpointId" | "unchanged">,
  shortHash: string | null,
  intervalHours?: number | null,
  now = Date.now(),
): SyncCheckpointLine | null {
  const hash = shortHash ?? "";
  if (r.checkpointKind === "additional") return { text: `Additional checkpoint ${hash}`.trim() + " saved", tone: "success" };
  if (r.checkpointKind === "automatic") return { text: `Automatic checkpoint ${hash}`.trim() + " recorded", tone: "success" };
  const reason: SyncCheckpointSkipReason | null | undefined = r.checkpointSkipped;
  if (reason === "not-due") {
    const next = r.nextAutomaticDueAt ? ` Next due after ${formatDue(r.nextAutomaticDueAt, now)}.` : "";
    return { text: `No checkpoint: ${periodOwner(intervalHours)} automatic one already exists.${next}`, tone: "neutral" };
  }
  if (reason === "automatic-off") return { text: "No checkpoint: automatic checkpoints are off for this database", tone: "neutral" };
  if (reason === "unchanged") return { text: "No changes since the last checkpoint", tone: "neutral" };
  if (reason === "declined") return { text: "No additional checkpoint, as chosen", tone: "neutral" };
  if (reason === "after-sync-off") return { text: "No checkpoint: checkpoints after a sync are off", tone: "neutral" };
  if (reason === "not-versioned") return { text: "Not recorded: this database is not versioned", tone: "neutral" };
  if (reason === "failed") return { text: "The sync finished, but its checkpoint could not be recorded", tone: "warn" };
  if (r.checkpointId) return { text: `Recorded as ${hash || "a checkpoint"}`, tone: "success" };
  return null;
}

export type SyncStart = { prompt: true } | { prompt: false; body: { checkpoint?: boolean } };

export function syncStartFor(versioned: boolean, mode: ManualSyncCheckpointMode): SyncStart {
  if (!versioned) return { prompt: false, body: {} };
  if (mode === "always") return { prompt: false, body: { checkpoint: true } };
  if (mode === "never") return { prompt: false, body: { checkpoint: false } };
  return { prompt: true };
}

export function promptChoice(checkpoint: boolean, dontAskAgain: boolean): { body: { checkpoint: boolean }; remember: ManualSyncCheckpointMode | null } {
  return { body: { checkpoint }, remember: dontAskAgain ? (checkpoint ? "always" : "never") : null };
}

export function usePolicyMutation(db: Pick<Database, "id">) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: UpdateCheckpointPolicyRequest) => api.put<CheckpointPolicyResponse>(checkpointPath(db.id, "/policy"), body),
    onSuccess: (res) => {
      qc.setQueryData<CheckpointListResponse>(checkpointKeys.list(db.id), (prev) =>
        prev ? { ...prev, policy: res.policy, schedule: res.schedule ?? prev.schedule } : prev,
      );
      void qc.invalidateQueries({ queryKey: checkpointKeys.list(db.id) });
      void qc.invalidateQueries({ queryKey: queryKeys.database(db.id) });
      void qc.invalidateQueries({ queryKey: queryKeys.databases, exact: true });
      void qc.invalidateQueries({ queryKey: queryKeys.dashboardSummary });
      void qc.invalidateQueries({ queryKey: checkpointKeys.status(db.id) });
    },
  });
}

export function lastCheckFoundNothing(lastAutomaticAt: number | null | undefined, checkpoints: { trigger: string; createdAt: number }[] | undefined): boolean {
  if (!lastAutomaticAt || !checkpoints) return false;
  return !checkpoints.some((cp) => (cp.trigger === "scheduled" || cp.trigger === "sync") && Math.abs(cp.createdAt - lastAutomaticAt) <= 120_000);
}
