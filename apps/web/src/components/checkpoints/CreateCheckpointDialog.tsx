import { useEffect, useRef, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { GitCommitHorizontal } from "lucide-react";
import type { CreateCheckpointRequest, Database, JobResponse, WorkingCopyStatus } from "@lambdata/shared";
import { Alert } from "../ui/Alert";
import { Button } from "../ui/Button";
import { Checkbox } from "../ui/Checkbox";
import { Dialog } from "../ui/Dialog";
import { Field } from "../ui/Field";
import { Input } from "../ui/Input";
import { JobConflictNotice } from "../jobs/JobConflictNotice";
import { api, errorMessage } from "../../lib/api";
import { isJobConflict } from "../../lib/jobs";
import { formatRelativeTime, pluralize } from "../../lib/format";
import { DiffList } from "./DiffList";
import { defaultCheckpointMessage, diffSummary } from "./meta";
import { checkpointPath } from "./queries";

export interface CreateCheckpointDialogProps {
  open: boolean;
  db: Database;
  status: WorkingCopyStatus | undefined;
  baseShort: string | null;
  onClose: () => void;
  onStarted: (job: JobResponse["job"]) => void;
}

export function createCheckpointBody(message: string, verify: boolean): CreateCheckpointRequest {
  const body: CreateCheckpointRequest = { message: message.trim() || undefined };
  if (verify) body.verify = true;
  return body;
}

export function CreateCheckpointDialog({ open, db, status, baseShort, onClose, onStarted }: CreateCheckpointDialogProps) {
  const [message, setMessage] = useState("");
  const [touched, setTouched] = useState(false);
  const [verify, setVerify] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const create = useMutation({
    mutationFn: (body: CreateCheckpointRequest) => api.post<JobResponse>(checkpointPath(db.id), body),
    onSuccess: (res) => {
      onStarted(res.job);
      onClose();
    },
  });

  useEffect(() => {
    if (open) {
      setTouched(false);
      setVerify(false);
      create.reset();
    }
  }, [open]);

  useEffect(() => {
    if (open && !touched) setMessage(defaultCheckpointMessage(status));
  }, [open, touched, status]);

  const submit = () => {
    if (create.isPending) return;
    create.mutate(createCheckpointBody(message, verify));
  };

  const conflict = isJobConflict(create.error);
  const clean = status?.state === "clean";
  const dirtyDiff = status?.state === "dirty" ? status.diff : null;

  return (
    <Dialog
      open={open}
      onClose={() => !create.isPending && onClose()}
      size="lg"
      title="Create checkpoint"
      description={
        <>
          Seal the current tables, views and routines of <span className="font-mono text-code text-text">{db.name}</span> as a
          commit. The database stays online while it is captured.
        </>
      }
      initialFocus={inputRef}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={create.isPending}>
            Cancel
          </Button>
          <Button type="submit" form="create-checkpoint-form" loading={create.isPending} disabled={conflict}>
            <GitCommitHorizontal />
            Create checkpoint
          </Button>
        </>
      }
    >
      <form
        id="create-checkpoint-form"
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        {dirtyDiff && (
          <div className="space-y-2">
            <p className="text-label text-text-muted">
              <span className="text-text">{diffSummary(dirtyDiff)}</span> since{" "}
              <span className="font-mono text-code text-text">{baseShort ?? "HEAD"}</span>
            </p>
            <DiffList diff={dirtyDiff} dense />
          </div>
        )}
        {clean && (
          <Alert variant="neutral" title={`No changes since ${baseShort ?? "HEAD"} at the last check`}>
            {status?.computedAt ? `Checked ${formatRelativeTime(status.computedAt)}. ` : ""}If the data is still unchanged, no new
            checkpoint is recorded.
          </Alert>
        )}
        {status?.state === "no-checkpoint" && (
          <p className="text-label text-text-muted">This will be the first checkpoint, and it becomes HEAD.</p>
        )}
        <Field
          label="Message"
          hint={`Describe what this state is. Up to 500 characters.${dirtyDiff ? ` ${pluralize(dirtyDiff.tables.length, "table")} will be stored again; unchanged ones are shared.` : ""}`}
          error={!conflict && create.error ? errorMessage(create.error) : undefined}
        >
          <Input
            ref={inputRef}
            value={message}
            maxLength={500}
            onChange={(e) => {
              setTouched(true);
              setMessage(e.target.value);
            }}
            onFocus={(e) => e.currentTarget.select()}
            placeholder="Manual checkpoint"
            autoComplete="off"
          />
        </Field>
        <Checkbox
          checked={verify}
          onCheckedChange={(next) => setVerify(next === true)}
          disabled={create.isPending}
          label="Verify by loading it once"
          description="Loads it into a scratch copy to prove it can be rolled back to. Takes about as long again."
        />
        {conflict && <JobConflictNotice error={create.error} onCleared={() => create.reset()} />}
      </form>
    </Dialog>
  );
}
