import { useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { DataDirMigrationResponse, PathValidationResponse } from "@lambdata/shared";
import { ArrowRight } from "lucide-react";
import { Alert, Button, DescriptionItem, DescriptionList, Dialog, Progress, useToast } from "../ui";
import { DataDirPicker } from "./DataDirPicker";
import { api, errorMessage } from "../../lib/api";
import { formatBytes } from "../../lib/format";

type Step = "choose" | "confirm" | "done";

interface Props {
  open: boolean;
  onClose: () => void;
  current: string;
}

export function StorageMigrationDialog({ open, onClose, current }: Props) {
  const qc = useQueryClient();
  const toast = useToast();
  const [step, setStep] = useState<Step>("choose");
  const [path, setPath] = useState("");
  const [validation, setValidation] = useState<PathValidationResponse | null>(null);
  const [result, setResult] = useState<DataDirMigrationResponse | null>(null);

  const migrate = useMutation({
    mutationFn: (target: string) => api.post<DataDirMigrationResponse>("/settings/data-dir", { path: target }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["settings"] }),
  });

  useEffect(() => {
    if (!open) return;
    setStep("choose");
    setPath("");
    setValidation(null);
    setResult(null);
    migrate.reset();
  }, [open]);

  const busy = migrate.isPending;
  const target = validation?.ok ? validation.resolvedPath : null;

  const footer =
    step === "choose" ? (
      <>
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button disabled={!target} onClick={() => setStep("confirm")}>
          Continue <ArrowRight aria-hidden />
        </Button>
      </>
    ) : step === "confirm" ? (
      <>
        <Button variant="ghost" disabled={busy} onClick={() => setStep("choose")}>
          Back
        </Button>
        <Button
          variant="danger"
          loading={busy}
          disabled={!target}
          onClick={() =>
            target &&
            migrate.mutate(target, {
              onSuccess: (res) => {
                setResult(res);
                setStep("done");
                toast.success("Storage moved");
              },
            })
          }
        >
          Move storage
        </Button>
      </>
    ) : (
      <Button onClick={onClose}>Done</Button>
    );

  return (
    <Dialog
      open={open}
      onClose={() => {
        if (!busy) onClose();
      }}
      dismissible={!busy}
      size="lg"
      title="Move the data directory"
      description="MariaDB stops, everything is copied and verified, the pointer is switched and MariaDB starts again from the new place."
      footer={footer}
    >
      {step === "choose" && (
        <div className="space-y-4">
          <DescriptionList layout="stacked">
            <DescriptionItem term="Current location" mono>
              <span className="break-all">{current || "—"}</span>
            </DescriptionItem>
          </DescriptionList>
          <DataDirPicker
            value={path}
            onChange={(next) => {
              setPath(next);
              setValidation(null);
            }}
            onValidation={setValidation}
            pickerPrompt="Choose the new LambData data directory"
          />
        </div>
      )}
      {step === "confirm" && (
        <div className="space-y-4">
          <Alert variant="warning" title="MariaDB is offline during the move">
            Connected clients are dropped and sync jobs and checkpoints pause. The old directory is removed only after
            MariaDB starts cleanly from the new one.
          </Alert>
          <DescriptionList>
            <DescriptionItem term="From" mono>
              <span className="break-all">{current}</span>
            </DescriptionItem>
            <DescriptionItem term="To" mono>
              <span className="break-all">{target}</span>
            </DescriptionItem>
            {validation?.freeBytes != null && (
              <DescriptionItem term="Free there" mono>
                {formatBytes(validation.freeBytes)}
              </DescriptionItem>
            )}
          </DescriptionList>
          {busy && <Progress value={null} label="Copying and verifying. Keep this window open." />}
          {migrate.isError && (
            <Alert variant="danger" title="The move did not finish">
              {errorMessage(migrate.error, "Migration failed.")}
            </Alert>
          )}
        </div>
      )}
      {step === "done" && result && (
        <div className="space-y-4">
          <Alert variant="success" title="Storage moved">
            MariaDB is running from the new location.
          </Alert>
          <DescriptionList>
            <DescriptionItem term="From" mono>
              <span className="break-all">{result.oldPath}</span>
            </DescriptionItem>
            <DescriptionItem term="To" mono>
              <span className="break-all">{result.newPath}</span>
            </DescriptionItem>
            <DescriptionItem term="Copied" mono>
              {formatBytes(result.bytesCopied)}
            </DescriptionItem>
            <DescriptionItem term="Took" mono>
              {(result.durationMs / 1000).toFixed(1)} s
            </DescriptionItem>
          </DescriptionList>
        </div>
      )}
    </Dialog>
  );
}
