import type { CheckpointCreateJobResult, CheckpointRestoreJobResult, CheckpointTrigger } from "@lambdata/shared";
import { audit, checkpoints, databases, jobs } from "../db/queries";
import { retentionGroupOf } from "../db/queries/checkpoints";
import { recordSwapOutcome, runExclusive, SWAP_DONE_KEY } from "../jobs";
import { onSwapCompleted, onSwapRolledBack } from "../mariadb/schemaSwap";
import { captureCheckpoint, type ProgressHooks } from "./capture";
import { applyRetention, deleteCheckpointRecord, withProtectedCheckpoint } from "./manage";
import { failureRecord, restoreLocked, verifyCheckpointLoads } from "./restore";
import { invalidateWorkingCopyStatus } from "./status";

export { invalidateWorkingCopyStatus, getWorkingCopyStatus } from "./status";
export type { ProgressHooks } from "./capture";

export interface CreateCheckpointInput {
  trigger: CheckpointTrigger;
  message?: string | null;
  userId?: string | null;
  allowUnchanged?: boolean;
  hooks?: ProgressHooks;
  retention?: boolean;
  verify?: boolean;
  signal?: AbortSignal;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export async function runRetention(databaseId: string, hooks?: ProgressHooks, trigger?: CheckpointTrigger): Promise<void> {
  const group = trigger ? retentionGroupOf(trigger) : null;
  if (trigger && !group) return;
  try {
    await applyRetention(databaseId, group ? [group] : undefined);
  } catch (err) {
    hooks?.warn?.(`retention cleanup failed: ${errorMessage(err)}`);
  }
}

export async function createCheckpoint(
  databaseId: string,
  { trigger, message, userId, allowUnchanged, hooks, retention, verify, signal }: CreateCheckpointInput,
): Promise<CheckpointCreateJobResult> {
  return runExclusive(databaseId, async () => {
    try {
      const result = await captureCheckpoint(databaseId, { trigger, message, userId, allowUnchanged, hooks, signal });
      if (verify && result.checkpointId) {
        hooks?.stage?.("Verifying that the checkpoint loads exactly");
        await verifyCheckpointLoads(databaseId, result.checkpointId, { stage: hooks?.stage, warn: hooks?.warn });
        result.verified = true;
      }
      if (result.checkpointId && retention !== false) await runRetention(databaseId, hooks, trigger);
      return result;
    } finally {
      invalidateWorkingCopyStatus(databaseId);
    }
  });
}

export async function restoreCheckpoint(
  databaseId: string,
  checkpointId: string,
  opts: { userId: string | null; hooks?: ProgressHooks; allowCodeFailures?: boolean },
): Promise<CheckpointRestoreJobResult> {
  return runExclusive(databaseId, async () => {
    try {
      const target = checkpoints.byId(checkpointId);
      const result = await withProtectedCheckpoint(databaseId, checkpointId, () =>
        restoreLocked(databaseId, checkpointId, {
          userId: opts.userId,
          hooks: opts.hooks,
          allowCodeFailures: opts.allowCodeFailures,
          safety: async (signal) =>
            (
              await captureCheckpoint(databaseId, {
                trigger: "pre-restore",
                message: target ? `Before rolling back to ${target.shortHash}` : null,
                userId: opts.userId,
                hooks: { warn: opts.hooks?.warn },
                signal,
              })
            ).checkpointId,
        }),
      );
      await runRetention(databaseId, opts.hooks);
      return result;
    } finally {
      invalidateWorkingCopyStatus(databaseId);
    }
  });
}

export async function deleteCheckpoint(databaseId: string, checkpointId: string): Promise<void> {
  await runExclusive(databaseId, async () => {
    const cp = checkpoints.byId(checkpointId);
    if (!cp || cp.databaseId !== databaseId) throw new Error("checkpoint not found");
    await deleteCheckpointRecord(databaseId, checkpointId);
    invalidateWorkingCopyStatus(databaseId);
  });
}

function noteString(note: Record<string, unknown> | null, key: string): string | null {
  const v = note?.[key];
  return typeof v === "string" && v ? v : null;
}

function shortHashOf(id: string | null): string | null {
  return id ? (checkpoints.byId(id)?.shortHash ?? null) : null;
}

function kindLabel(kind: string | null): string {
  return kind === "checkpoint.restore" ? "rollback" : kind === "sync.run" ? "sync" : "import";
}

function pendingResult(kind: string | null, checkpointId: string | null, safetyCheckpointId: string | null, outcome: string, codeFailures: unknown[]) {
  if (kind === "checkpoint.restore") return { restoredCheckpointId: checkpointId, safetyCheckpointId, outcome, codeFailures };
  if (kind === "sync.run") return { status: "ok", preSyncCheckpointId: safetyCheckpointId, outcome, codeFailures };
  return { safetyCheckpointId, outcome, codeFailures };
}

onSwapCompleted(async (note, info) => {
  if (!note || !info.databaseId || !databases.byId(info.databaseId)) return;
  invalidateWorkingCopyStatus(info.databaseId);
  const kind = noteString(note, "kind");
  const checkpointId = noteString(note, "checkpointId");
  const safetyCheckpointId = noteString(note, "safetyCheckpointId");
  if (kind === "checkpoint.restore" && checkpointId && checkpoints.exists(checkpointId)) {
    databases.setBaseCheckpoint(info.databaseId, checkpointId);
  }
  const jobId = noteString(note, "jobId");
  const failures = (info.result?.failures ?? []).map(failureRecord);
  const outcome = failures.length > 0 ? "done-with-errors" : "done";
  const what = kindLabel(kind);
  const saved = shortHashOf(safetyCheckpointId);
  const savedNote = saved ? ` The state before it is saved in checkpoint ${saved}.` : "";
  if (!info.recovered) {
    if (jobId) {
      recordSwapOutcome(
        jobId,
        pendingResult(kind, checkpointId, safetyCheckpointId, outcome, failures),
        `LambData stopped after this ${what} had moved the new tables in, before the job could record that it had finished; the ${what} is complete.${savedNote}`,
      );
    }
    return;
  }
  if (kind === "checkpoint.restore") {
    audit.log(noteString(note, "userId"), "checkpoint.restore.recovered", info.databaseId, { checkpointId, safetyCheckpointId, failures: failures.length });
  }
  if (!jobId) return;
  const job = jobs.byId(jobId);
  if (!job) return;
  const warning = `This ${what} was interrupted by a restart after the new tables were moved in, and LambData completed it when it started again.${savedNote}`;
  const earlier: Record<string, unknown> = { ...(job.result ?? {}) };
  delete earlier[SWAP_DONE_KEY];
  delete earlier.completedAfterRestart;
  const result: Record<string, unknown> = {
    ...(kind === "checkpoint.restore" ? {} : earlier),
    ...pendingResult(kind, checkpointId, safetyCheckpointId, outcome, failures),
    completedAfterRestart: true,
  };
  jobs.rewriteFinished(jobId, { status: "succeeded", error: null, warnings: [...job.warnings.filter((w) => !w.startsWith("LambData stopped after this")), warning, ...(info.result?.warnings ?? [])], result });
});

onSwapRolledBack(async (note, info) => {
  if (!note || !info.databaseId) return;
  invalidateWorkingCopyStatus(info.databaseId);
  if (!info.recovered) return;
  const jobId = noteString(note, "jobId");
  if (!jobId) return;
  const job = jobs.byId(jobId);
  if (!job) return;
  const kind = noteString(note, "kind");
  const what = kind === "checkpoint.restore" ? "rollback" : kind === "sync.run" ? "sync" : "import";
  jobs.rewriteFinished(jobId, {
    status: "failed",
    error: `The ${what} was interrupted by a restart before it finished. LambData put the database back as it was when it started again, so nothing was changed.`,
  });
});
