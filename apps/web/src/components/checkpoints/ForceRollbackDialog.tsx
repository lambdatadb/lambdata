import { ShieldCheck } from "lucide-react";
import type { Checkpoint, CodeObjectFailure } from "@lambdata/shared";
import { Alert } from "../ui/Alert";
import { ConfirmDialog } from "../ui/ConfirmDialog";
import { CodeFailureList } from "../jobs/CodeFailureList";
import { JobConflictNotice } from "../jobs/JobConflictNotice";
import { errorMessage } from "../../lib/api";
import { isJobConflict } from "../../lib/jobs";
import { describeFailureKinds } from "../../lib/jobOutcome";

export interface ForceRollbackDialogProps {
  open: boolean;
  databaseName: string;
  target: Pick<Checkpoint, "shortHash" | "message">;
  failures: CodeObjectFailure[];
  loading: boolean;
  error: unknown;
  onClose: () => void;
  onConfirm: () => void;
  onConflictCleared?: () => void;
}

export function ForceRollbackDialog({
  open,
  databaseName,
  target,
  failures,
  loading,
  error,
  onClose,
  onConfirm,
  onConflictCleared,
}: ForceRollbackDialogProps) {
  const conflict = isJobConflict(error);
  const what = failures.length > 0 ? describeFailureKinds(failures) : "The views, triggers or routines that failed the trial run";
  const name = <span className="font-mono text-code text-text">{databaseName}</span>;
  return (
    <ConfirmDialog
      open={open}
      onClose={onClose}
      onConfirm={onConfirm}
      tone="danger"
      size="lg"
      loading={loading}
      confirmDisabled={conflict}
      title={
        <>
          Roll back to <span className="font-mono">{target.shortHash}</span> without these objects?
        </>
      }
      description={
        <>
          The tables of <span className="font-mono text-code text-text">{target.shortHash}</span> “{target.message}” replace the live data
          in {name} as in any rollback. {what} cannot be re-created here, so {failures.length === 1 ? "it is" : "they are"} missing
          from {name} afterwards. Every other view, trigger and routine is rolled back as usual.
        </>
      }
      confirmLabel="Roll back anyway"
    >
      <CodeFailureList failures={failures} label="Objects that will be missing after the rollback" />
      <Alert variant="info" icon={<ShieldCheck aria-hidden />} title="The current state is saved first">
        Before anything is replaced, LambData saves the live data as a <span className="text-text">safety</span> checkpoint,
        including the current definitions of these objects. Roll back to it if you need them again.
      </Alert>
      {conflict && <JobConflictNotice error={error} onCleared={onConflictCleared} />}
      {!!error && !conflict && (
        <Alert variant="danger" title="Could not start the rollback">
          {errorMessage(error)}
        </Alert>
      )}
    </ConfirmDialog>
  );
}
