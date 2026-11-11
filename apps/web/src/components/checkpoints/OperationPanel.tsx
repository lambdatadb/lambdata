import { useState, type ReactNode } from "react";
import { useMutation } from "@tanstack/react-query";
import { RotateCcw, ShieldCheck, TriangleAlert, X } from "lucide-react";
import type { Checkpoint, CheckpointCreateJobResult, CheckpointRestoreJobResult, Database, Job, SyncJobResult } from "@lambdata/shared";
import { Button } from "../ui/Button";
import { SimpleTooltip } from "../ui/Tooltip";
import { JobProgress } from "../jobs/JobProgress";
import { SyncChanges, readSyncChanges } from "../sync/SyncChanges";
import { isJobActive, jobKindLabel } from "../../lib/jobs";
import { createLimitations, createVerified, isCodeRefusal, jobCodeFailures, jobState, refusedTargetHash } from "../../lib/jobOutcome";
import { ForceRollbackDialog } from "./ForceRollbackDialog";
import { startRollback } from "./queries";
import { syncCheckpointLine } from "./policy";
import type { TrackedJobMeta } from "./useHistoryJobs";

const hash = (h: string) => <span className="font-mono text-code text-text">{h}</span>;

export function operationTitle(job: Job, meta: TrackedJobMeta | null, byId: Map<string, Checkpoint>): ReactNode {
  const active = isJobActive(job);
  const state = jobState(job);
  if (job.kind === "checkpoint.restore") {
    const restored = (job.result as Partial<CheckpointRestoreJobResult> | null)?.restoredCheckpointId ?? job.errorDetails?.checkpointId;
    const target = meta?.targetShort ?? (restored ? byId.get(restored)?.shortHash : undefined) ?? refusedTargetHash(job)?.slice(0, 7);
    if (state === "refused") return target ? <>Rollback to {hash(target)} refused</> : "Rollback refused";
    if (state === "failed") return target ? <>Rollback to {hash(target)} failed</> : "Rollback failed";
    if (state === "done-with-errors") return target ? <>Rolled back to {hash(target)} with errors</> : "Rollback finished with errors";
    if (!active) return target ? <>Rolled back to {hash(target)}</> : "Rollback finished";
    return target ? <>Rolling back to {hash(target)}</> : "Rolling back";
  }
  if (job.kind === "checkpoint.create") {
    if (job.status === "failed") return "Checkpoint failed";
    if (active) return job.createdByUserId ? "Creating checkpoint" : "Automatic checkpoint";
    const r = job.result as unknown as CheckpointCreateJobResult | null;
    if (!r?.checkpointId) return "No checkpoint needed";
    const cp = byId.get(r.checkpointId);
    const suffix = createLimitations(job).length > 0 ? " with limitations" : "";
    return cp ? <>Checkpoint {hash(cp.shortHash)} recorded{suffix}</> : `Checkpoint recorded${suffix}`;
  }
  if (job.kind === "sync.run") {
    if (active) return "Mirror sync running";
    if (state === "failed") return "Mirror sync failed";
    return state === "done-with-errors" ? "Mirror sync finished with errors" : "Mirror sync finished";
  }
  if (state === "done-with-errors") return `${jobKindLabel(job.kind)} finished with errors`;
  return jobKindLabel(job.kind);
}

function Limitations({ items }: { items: string[] }) {
  return (
    <div className="space-y-1.5 rounded-md border border-warn/30 bg-warn/[0.05] p-3">
      <p className="flex items-center gap-1.5 font-medium text-text">
        <TriangleAlert aria-hidden className="size-3.5 shrink-0 text-warn" />
        Recorded with {items.length === 1 ? "a limitation" : `${items.length} limitations`}
      </p>
      <ul className="max-h-40 list-disc space-y-1 overflow-y-auto pl-5 text-text-muted">
        {items.map((item, i) => (
          <li key={i} className="break-words">
            {item}
          </li>
        ))}
      </ul>
    </div>
  );
}

export function operationSuccess(job: Job, meta: TrackedJobMeta | null, byId: Map<string, Checkpoint>): ReactNode {
  if (job.status !== "succeeded" || !job.result) return null;
  const withErrors = jobState(job) === "done-with-errors";
  if (job.kind === "checkpoint.restore") {
    const r = job.result as unknown as CheckpointRestoreJobResult;
    const safety = r.safetyCheckpointId ? byId.get(r.safetyCheckpointId) : null;
    const target = meta?.targetShort ?? byId.get(r.restoredCheckpointId)?.shortHash;
    const safetyHash = safety ? hash(safety.shortHash) : "(loading)";
    if (withErrors) {
      return (
        <p>
          The tables of {target ? hash(target) : "the checkpoint"} are back and it is HEAD again, but the objects listed below could not
          be re-created and are missing from the live database.{" "}
          {r.safetyCheckpointId ? (
            <>Their previous definitions are in safety checkpoint {safetyHash}; roll back to it to undo this.</>
          ) : (
            <>No safety checkpoint was needed: the replaced data was identical to {meta?.previousBaseShort ? hash(meta.previousBaseShort) : "HEAD"}.</>
          )}
        </p>
      );
    }
    return (
      <p>
        The live data now matches {target ? hash(target) : "the checkpoint"}, which is HEAD again.{" "}
        {r.safetyCheckpointId ? (
          <>The data it replaced was saved first as safety checkpoint {safetyHash}; roll back to it to undo this.</>
        ) : (
          <>
            No safety checkpoint was needed: the replaced data was identical to{" "}
            {meta?.previousBaseShort ? hash(meta.previousBaseShort) : "HEAD"}, which is still in History.
          </>
        )}
      </p>
    );
  }
  if (job.kind === "checkpoint.create") {
    const r = job.result as unknown as CheckpointCreateJobResult;
    if (r.unchanged || !r.checkpointId) {
      return <p>Nothing has changed since {meta?.previousBaseShort ? hash(meta.previousBaseShort) : "HEAD"}, so no checkpoint was recorded.</p>;
    }
    const cp = byId.get(r.checkpointId);
    const limitations = createLimitations(job);
    return (
      <>
        <p>
          {cp ? <>“{cp.message}” is now HEAD.</> : "It is now HEAD."}
          {createVerified(job) && (
            <>
              {" "}
              <ShieldCheck aria-hidden className="mb-0.5 inline size-3.5 text-success" /> Verified: it was loaded into a scratch copy and can be
              rolled back to.
            </>
          )}
        </p>
        {limitations.length > 0 && <Limitations items={limitations} />}
      </>
    );
  }
  if (job.kind === "sync.run") {
    const r = job.result as unknown as SyncJobResult;
    const cp = r.checkpointId ? byId.get(r.checkpointId) : null;
    const line = syncCheckpointLine(r, cp?.shortHash ?? null);
    const lead = withErrors
      ? "The tables were synced and are in place. The objects listed below could not be created in the mirror."
      : r.unchanged
        ? "Synced; no data changed."
        : "Synced.";
    return (
      <>
        <p>
          {lead}
          {line && <> {line.text.endsWith(".") ? line.text : `${line.text}.`}</>}
        </p>
        <SyncChanges changes={readSyncChanges(r.changes)} />
      </>
    );
  }
  return null;
}

export function refusedTarget(job: Job, meta: TrackedJobMeta | null, byId: Map<string, Checkpoint>): Checkpoint | null {
  for (const id of [meta?.targetId, job.errorDetails?.checkpointId]) {
    const known = id ? byId.get(id) : undefined;
    if (known) return known;
  }
  const parsed = refusedTargetHash(job);
  if (!parsed) return null;
  for (const cp of byId.values()) {
    if (cp.shortHash === parsed || cp.hash.startsWith(parsed)) return cp;
  }
  return null;
}

export interface OperationPanelProps {
  job: Job;
  meta: TrackedJobMeta | null;
  byId: Map<string, Checkpoint>;
  db?: Database;
  canRestore?: boolean;
  busyReason?: string | null;
  onForced?: (job: Job, target: Checkpoint) => void;
  onDismiss: () => void;
}

export function OperationPanel({ job, meta, byId, db, canRestore = false, busyReason = null, onForced, onDismiss }: OperationPanelProps) {
  const active = isJobActive(job);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const target = isCodeRefusal(job) ? refusedTarget(job, meta, byId) : null;
  const failures = jobCodeFailures(job);
  const force = useMutation({
    mutationFn: (cp: Checkpoint) => startRollback(cp.databaseId, cp.id, { allowCodeFailures: true }),
    onSuccess: (res, cp) => {
      setConfirmOpen(false);
      onForced?.(res.job, cp);
    },
  });
  const offerForce = !!target && !!db && canRestore && !!onForced;

  const actions = offerForce ? (
    <>
      <SimpleTooltip content={busyReason} disabled={!busyReason}>
        <span className="inline-flex">
          <Button
            size="sm"
            variant="danger-soft"
            disabled={!!busyReason}
            onClick={() => {
              force.reset();
              setConfirmOpen(true);
            }}
          >
            <RotateCcw />
            Roll back anyway…
          </Button>
        </span>
      </SimpleTooltip>
      <span className="min-w-0 flex-[1_1_14rem] pr-8 text-label text-text-muted">
        Brings the tables back and leaves out the objects above. The current state is saved in a safety checkpoint first.
      </span>
    </>
  ) : undefined;

  return (
    <div className="relative">
      <JobProgress job={job} title={operationTitle(job, meta, byId)} successMessage={operationSuccess(job, meta, byId)} actions={actions} />
      {!active && (
        <Button variant="ghost" size="icon-xs" aria-label="Dismiss" onClick={onDismiss} className="absolute bottom-2.5 right-2.5">
          <X />
        </Button>
      )}
      {active && !meta && job.kind !== "checkpoint.create" && (
        <p className="mt-2 text-label text-text-muted">Creating, rolling back and deleting checkpoints are paused until it finishes.</p>
      )}
      {offerForce && target && db && (
        <ForceRollbackDialog
          open={confirmOpen}
          databaseName={db.name}
          target={target}
          failures={failures}
          loading={force.isPending}
          error={force.error}
          onClose={() => setConfirmOpen(false)}
          onConfirm={() => force.mutate(target)}
          onConflictCleared={() => force.reset()}
        />
      )}
    </div>
  );
}
