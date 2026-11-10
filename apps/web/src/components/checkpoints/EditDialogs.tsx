import { useEffect, useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { Checkpoint, CheckpointResponse, Database, UpdateCheckpointRequest } from "@lambdata/shared";
import { Alert } from "../ui/Alert";
import { Button } from "../ui/Button";
import { ConfirmDialog } from "../ui/ConfirmDialog";
import { Dialog } from "../ui/Dialog";
import { Field } from "../ui/Field";
import { Input } from "../ui/Input";
import { toast } from "../ui/Toast";
import { JobConflictNotice } from "../jobs/JobConflictNotice";
import { api, errorMessage } from "../../lib/api";
import { isJobConflict } from "../../lib/jobs";
import { formatBytes } from "../../lib/format";
import { checkpointKeys, checkpointPath, invalidateHistory } from "./queries";
import { isAutomatic } from "./meta";

export function useUpdateCheckpoint(db: Database) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ cp, body }: { cp: Checkpoint; body: UpdateCheckpointRequest }) =>
      api.patch<CheckpointResponse>(checkpointPath(db.id, `/${encodeURIComponent(cp.id)}`), body),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: checkpointKeys.all(db.id) });
    },
  });
}

export function EditMessageDialog({ db, target, onClose }: { db: Database; target: Checkpoint | null; onClose: () => void }) {
  const [message, setMessage] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const update = useUpdateCheckpoint(db);

  useEffect(() => {
    if (target) {
      setMessage(target.message);
      update.reset();
    }
  }, [target?.id]);

  const trimmed = message.trim();
  const unchanged = !!target && trimmed === target.message;

  return (
    <Dialog
      open={!!target}
      onClose={() => !update.isPending && onClose()}
      title="Edit message"
      description={
        target ? (
          <>
            The message is a label: the hash <span className="font-mono text-code text-text">{target.shortHash}</span> and the
            stored data do not change.
          </>
        ) : undefined
      }
      initialFocus={inputRef}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={update.isPending}>
            Cancel
          </Button>
          <Button type="submit" form="edit-checkpoint-form" loading={update.isPending} disabled={!trimmed || unchanged}>
            Save message
          </Button>
        </>
      }
    >
      <form
        id="edit-checkpoint-form"
        onSubmit={(e) => {
          e.preventDefault();
          if (!target || !trimmed || unchanged) return;
          update.mutate(
            { cp: target, body: { message: trimmed } },
            {
              onSuccess: () => {
                toast.success(`Message of ${target.shortHash} updated`);
                onClose();
              },
            },
          );
        }}
      >
        <Field label="Message" error={update.isError ? errorMessage(update.error) : !trimmed ? "A message is required" : undefined}>
          <Input
            ref={inputRef}
            value={message}
            maxLength={500}
            onChange={(e) => setMessage(e.target.value)}
            onFocus={(e) => e.currentTarget.select()}
            autoComplete="off"
          />
        </Field>
      </form>
    </Dialog>
  );
}

export function DeleteCheckpointDialog({
  db,
  target,
  parent,
  onClose,
  onDeleted,
}: {
  db: Database;
  target: Checkpoint | null;
  parent: Checkpoint | null;
  onClose: () => void;
  onDeleted: (cp: Checkpoint) => void;
}) {
  const qc = useQueryClient();
  const remove = useMutation({
    mutationFn: (cp: Checkpoint) => api.delete<{ ok: true }>(checkpointPath(db.id, `/${encodeURIComponent(cp.id)}`)),
    onSuccess: async (_res, cp) => {
      await invalidateHistory(qc, db.id);
      toast.success(`Checkpoint ${cp.shortHash} deleted`);
      onDeleted(cp);
      onClose();
    },
  });

  useEffect(() => {
    if (target) remove.reset();
  }, [target?.id]);

  if (!target) return null;
  const conflict = isJobConflict(remove.error);
  return (
    <ConfirmDialog
      open
      onClose={onClose}
      onConfirm={() => remove.mutate(target)}
      tone="danger"
      size="md"
      loading={remove.isPending}
      confirmDisabled={conflict}
      title={
        <>
          Delete checkpoint <span className="font-mono">{target.shortHash}</span>?
        </>
      }
      description={
        <>
          “{target.message}” is removed from History and can no longer be rolled back to or downloaded.{" "}
          {parent ? (
            <>
              Anything built on it is re-attached to its parent <span className="font-mono text-code text-text">{parent.shortHash}</span>.
            </>
          ) : (
            "Anything built on it becomes the start of the history."
          )}{" "}
          Tables it shares with other checkpoints stay stored
          {target.newBytes > 0 ? `; up to ${formatBytes(target.newBytes)} only it uses is freed.` : "."}
        </>
      }
      confirmLabel="Delete checkpoint"
    >
      {target.isBase && (
        <Alert variant="warning" title="This is HEAD">
          {parent ? (
            <>
              HEAD moves to <span className="font-mono text-code text-text">{parent.shortHash}</span>. The live data is not touched,
              but it will show as changed until you create a new checkpoint.
            </>
          ) : (
            "The live data is not touched, but it will not be linked to any checkpoint until you create a new one."
          )}
        </Alert>
      )}
      {target.pinned && <Alert variant="neutral" title="This checkpoint is pinned">Pinning only protects it from automatic cleanup.</Alert>}
      {!target.isBase && !target.pinned && isAutomatic(target.trigger) && (
        <p className="text-label text-text-muted">Automatic checkpoints are also removed by retention once newer ones arrive.</p>
      )}
      {conflict && <JobConflictNotice error={remove.error} onCleared={() => remove.reset()} />}
      {remove.isError && !conflict && (
        <Alert variant="danger" title="Could not delete">
          {errorMessage(remove.error)}
        </Alert>
      )}
    </ConfirmDialog>
  );
}
