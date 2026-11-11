import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { GitCommitHorizontal, Play } from "lucide-react";
import type { Database, Job, JobResponse, ManualSyncCheckpointMode, RunSyncRequest } from "@lambdata/shared";
import { Button, Checkbox, Dialog, toast } from "../ui";
import { api, errorMessage } from "../../lib/api";
import { useCheckpointList } from "../checkpoints/queries";
import { manualMode, promptChoice, syncStartFor, usePolicyMutation } from "../checkpoints/policy";

export function runSync(databaseId: string, body: RunSyncRequest) {
  return api.post<JobResponse>(`/databases/${encodeURIComponent(databaseId)}/sync/run`, body);
}

export function SyncPromptBody({ dontAsk, onDontAsk, disabled }: { dontAsk: boolean; onDontAsk: (next: boolean) => void; disabled?: boolean }) {
  return (
    <div className="space-y-4">
      <p className="text-body text-text-muted">
        Today's automatic checkpoint is not affected. Additional checkpoints are kept until you delete them.
      </p>
      <Checkbox
        checked={dontAsk}
        onCheckedChange={(next) => onDontAsk(next === true)}
        disabled={disabled}
        label="Don't ask again for this database"
        description="Your answer becomes the default for manual syncs. You can change it in Settings."
      />
    </div>
  );
}

export function useSyncNow(db: Database, onStarted: (job: Job) => void) {
  const history = useCheckpointList(db.id);
  const policy = history.data?.policy;
  const versioned = policy?.versioned ?? db.versioned;
  const mode: ManualSyncCheckpointMode = manualMode(policy);
  const [open, setOpen] = useState(false);
  const [dontAsk, setDontAsk] = useState(false);
  const policyMutation = usePolicyMutation(db);
  const run = useMutation({
    mutationFn: (body: RunSyncRequest) => runSync(db.id, body),
    onSuccess: (res) => onStarted(res.job),
  });

  const start = () => {
    run.reset();
    const decision = syncStartFor(versioned, mode);
    if (decision.prompt) {
      setDontAsk(false);
      setOpen(true);
      return;
    }
    run.mutate(decision.body);
  };

  const answer = async (checkpoint: boolean) => {
    const choice = promptChoice(checkpoint, dontAsk);
    if (choice.remember) {
      try {
        await policyMutation.mutateAsync({ manualSyncCheckpoint: choice.remember });
        toast.success(choice.remember === "always" ? "Manual syncs will always add a checkpoint" : "Manual syncs will not add a checkpoint", {
          description: "You can change this in Settings.",
        });
      } catch (e) {
        toast.error("Could not save your answer", { description: errorMessage(e) });
      }
    }
    setOpen(false);
    run.mutate(choice.body);
  };

  const busy = run.isPending || policyMutation.isPending;
  const dialog = (
    <Dialog
      open={open}
      onClose={() => !busy && setOpen(false)}
      size="md"
      title="Create an additional checkpoint after this sync?"
      footer={
        <>
          <Button variant="secondary" onClick={() => void answer(false)} disabled={busy}>
            <Play aria-hidden /> Just sync
          </Button>
          <Button onClick={() => void answer(true)} loading={busy}>
            <GitCommitHorizontal aria-hidden /> Sync and checkpoint
          </Button>
        </>
      }
    >
      <SyncPromptBody dontAsk={dontAsk} onDontAsk={setDontAsk} disabled={busy} />
    </Dialog>
  );

  return { start, dialog, run, ready: !history.isPending };
}
