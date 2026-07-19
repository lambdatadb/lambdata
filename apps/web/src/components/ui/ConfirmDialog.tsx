import { useEffect, useState, type ReactNode } from "react";
import { Button } from "./Button";
import { Dialog } from "./Dialog";
import { Input } from "./Input";

interface Props {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void;
  title: string;
  body?: ReactNode;
  confirmLabel?: string;
  tone?: "danger" | "default";
  loading?: boolean;
  challenge?: string;
}

export function ConfirmDialog({
  open,
  onClose,
  onConfirm,
  title,
  body,
  confirmLabel = "Confirm",
  tone = "default",
  loading,
  challenge,
}: Props) {
  const [typed, setTyped] = useState("");
  useEffect(() => {
    if (!open) setTyped("");
  }, [open]);
  const blocked = challenge !== undefined && typed !== challenge;

  return (
    <Dialog open={open} onClose={onClose} title={title} size="sm">
      {body && <div className="text-body text-text-muted">{body}</div>}
      {challenge !== undefined && (
        <div className="mt-4 space-y-1.5">
          <div className="text-label text-text-muted">
            Type <span className="font-mono text-text">{challenge}</span> to confirm
          </div>
          <Input
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            className="font-mono"
            autoComplete="off"
            spellCheck={false}
          />
        </div>
      )}
      <div className="mt-5 flex justify-end gap-2">
        <Button variant="ghost" onClick={onClose} disabled={loading}>
          Cancel
        </Button>
        <Button
          variant={tone === "danger" ? "danger" : "primary"}
          onClick={onConfirm}
          disabled={blocked}
          loading={loading}
        >
          {confirmLabel}
        </Button>
      </div>
    </Dialog>
  );
}
