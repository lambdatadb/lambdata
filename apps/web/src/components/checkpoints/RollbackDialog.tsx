import { useEffect } from "react";
import { useMutation } from "@tanstack/react-query";
import { ShieldCheck } from "lucide-react";
import type { Checkpoint, Database, JobResponse, WorkingCopyStatus } from "@lambdata/shared";
import { Alert } from "../ui/Alert";
import { ConfirmDialog } from "../ui/ConfirmDialog";
import { Skeleton } from "../ui/Skeleton";
import { JobConflictNotice } from "../jobs/JobConflictNotice";
import { errorMessage } from "../../lib/api";
import { isJobConflict } from "../../lib/jobs";
import { formatDate, formatRelativeTime, pluralize } from "../../lib/format";
import { DiffList } from "./DiffList";
import { isLegacy } from "./meta";
import { startRollback, useCheckpointDiff } from "./queries";

export interface RollbackDialogProps {
  db: Database;
  target: Checkpoint | null;
  base: Checkpoint | null;
  status: WorkingCopyStatus | undefined;
  onClose: () => void;
  onStarted: (job: JobResponse["job"], target: Checkpoint) => void;
}

export function RollbackDialog({ db, target, base, status, onClose, onStarted }: RollbackDialogProps) {
  const open = !!target;
  const legacy = target ? isLegacy(target) : false;
  const statusKnown = status?.state === "clean" || status?.state === "dirty";
  const preview = useCheckpointDiff(db.id, target?.id ?? null, "working", { enabled: open && !legacy && statusKnown });
  const restore = useMutation({
    mutationFn: (cp: Checkpoint) => startRollback(db.id, cp.id),
    onSuccess: (res, cp) => {
      onStarted(res.job, cp);
      onClose();
    },
  });

  useEffect(() => {
    if (open) restore.reset();
  }, [open, target?.id]);

  if (!target) return null;
  const conflict = isJobConflict(restore.error);
  const discard = target.isBase;
  const dirty = status?.state === "dirty";

  return (
    <ConfirmDialog
      open={open}
      onClose={onClose}
      onConfirm={() => restore.mutate(target)}
      tone="danger"
      size="lg"
      loading={restore.isPending}
      confirmDisabled={conflict}
      title={
        discard ? (
          <>Discard changes since <span className="font-mono">{target.shortHash}</span>?</>
        ) : (
          <>Roll back to <span className="font-mono">{target.shortHash}</span>?</>
        )
      }
      description={
        <>
          Every table, view, trigger and routine in <span className="font-mono text-code text-text">{db.name}</span> is
          replaced with the contents of <span className="font-mono text-code text-text">{target.shortHash}</span> “{target.message}”
          from {formatRelativeTime(target.createdAt)} ({formatDate(target.createdAt)}
          {target.tableCount !== null && `, ${pluralize(target.tableCount, "table")}`}
          {target.rowCount !== null && `, ${pluralize(target.rowCount, "row")}`}). Applications connected to it see the
          old data as soon as it finishes.
        </>
      }
      confirmLabel={discard ? "Discard changes" : `Roll back to ${target.shortHash}`}
    >
      <Alert variant="info" icon={<ShieldCheck aria-hidden />} title="A safety checkpoint is taken first">
        {dirty ? (
          <>
            The live data has changes since <span className="font-mono text-code text-text">{base?.shortHash ?? "HEAD"}</span>. They
            are saved as a <span className="text-text">safety</span> checkpoint before anything is replaced, so you can roll
            forward to them later.
          </>
        ) : status?.state === "clean" ? (
          <>
            At the last check{status.computedAt ? ` (${formatRelativeTime(status.computedAt)})` : ""} the live data matched{" "}
            <span className="font-mono text-code text-text">{base?.shortHash ?? "HEAD"}</span>, which stays in History. LambData
            compares again right before replacing anything and saves a <span className="text-text">safety</span> checkpoint if the
            data has changed since.
          </>
        ) : (
          <>
            LambData compares the live data with HEAD first and saves it as a <span className="text-text">safety</span> checkpoint
            if anything differs, so nothing is lost.
          </>
        )}
      </Alert>
      <div className="space-y-2">
        <p className="text-label font-medium text-text-muted">What changes in the live database</p>
        {legacy ? (
          <p className="text-label text-text-muted">
            This was converted from an older snapshot and has no per-table breakdown. The whole schema is emptied and loaded from it.
          </p>
        ) : !statusKnown ? (
          <p className="text-label text-text-muted">
            The live data has not been compared for this database
            {status?.state === "unknown" && status.reason ? ` (${status.reason.replace(/\.$/, "")})` : ""}. All tables are replaced.
          </p>
        ) : preview.isPending ? (
          <div className="space-y-1.5" role="status" aria-label="Comparing with the live data">
            <Skeleton className="h-8 w-full" />
            <Skeleton className="h-8 w-full" />
          </div>
        ) : preview.isError ? (
          <p className="text-label text-text-muted">Could not compare with the live data: {errorMessage(preview.error)}. All tables are replaced.</p>
        ) : (
          <DiffList diff={preview.data} direction="rollback" dense emptyLabel="No table differs from the live data" />
        )}
      </div>
      {conflict && <JobConflictNotice error={restore.error} onCleared={() => restore.reset()} />}
      {restore.isError && !conflict && (
        <Alert variant="danger" title="Could not start the rollback">
          {errorMessage(restore.error)}
        </Alert>
      )}
    </ConfirmDialog>
  );
}
