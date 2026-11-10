import * as AlertDialogPrimitive from "@radix-ui/react-alert-dialog";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import {
  AlertDialog,
  AlertDialogBody,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "./AlertDialog";
import { Button } from "./Button";
import { Input } from "./Input";
import type { DialogSize } from "./Dialog";

export interface ConfirmDialogProps {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void;
  title: ReactNode;
  body?: ReactNode;
  description?: ReactNode;
  confirmLabel?: ReactNode;
  cancelLabel?: ReactNode;
  tone?: "danger" | "default";
  loading?: boolean;
  challenge?: string;
  challengeLabel?: ReactNode;
  confirmDisabled?: boolean;
  size?: DialogSize;
  children?: ReactNode;
}

export function ConfirmDialog({
  open,
  onClose,
  onConfirm,
  title,
  body,
  description,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  tone = "default",
  loading = false,
  challenge,
  challengeLabel,
  confirmDisabled = false,
  size = "sm",
  children,
}: ConfirmDialogProps) {
  const [typed, setTyped] = useState("");
  const inputId = useId();
  const cancelRef = useRef<HTMLButtonElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) setTyped("");
  }, [open]);

  const blocked = confirmDisabled || (challenge !== undefined && typed !== challenge);
  const text = description ?? body;
  const hasBody = Boolean(children) || challenge !== undefined;

  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        if (!next && !loading) onClose();
      }}
    >
      <AlertDialogContent
        size={size}
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          const target = challenge !== undefined ? inputRef.current : tone === "danger" ? cancelRef.current : confirmRef.current;
          target?.focus();
        }}
        onEscapeKeyDown={(event) => {
          if (loading) event.preventDefault();
        }}
        {...(text ? {} : { "aria-describedby": undefined })}
      >
        <form
          className="flex min-h-0 flex-1 flex-col"
          onSubmit={(event) => {
            event.preventDefault();
            if (!blocked && !loading) onConfirm();
          }}
        >
          <AlertDialogHeader className={hasBody ? undefined : "pb-5"}>
            <AlertDialogTitle>{title}</AlertDialogTitle>
            {text && (
              <AlertDialogDescription asChild>
                <div>{text}</div>
              </AlertDialogDescription>
            )}
          </AlertDialogHeader>
          {hasBody && (
            <AlertDialogBody className="space-y-4 pt-3">
              {children}
              {challenge !== undefined && (
                <div className="space-y-1.5">
                  <label htmlFor={inputId} className="block text-label text-text-muted">
                    {challengeLabel ?? (
                      <>
                        Type <span className="font-mono text-text">{challenge}</span> to confirm
                      </>
                    )}
                  </label>
                  <Input
                    id={inputId}
                    ref={inputRef}
                    value={typed}
                    onChange={(e) => setTyped(e.target.value)}
                    mono
                    autoComplete="off"
                    autoCapitalize="off"
                    spellCheck={false}
                    disabled={loading}
                  />
                </div>
              )}
            </AlertDialogBody>
          )}
          <AlertDialogFooter>
            <AlertDialogPrimitive.Cancel asChild>
              <Button ref={cancelRef} variant="ghost" disabled={loading}>
                {cancelLabel}
              </Button>
            </AlertDialogPrimitive.Cancel>
            <Button
              ref={confirmRef}
              type="submit"
              variant={tone === "danger" ? "danger" : "primary"}
              disabled={blocked}
              loading={loading}
            >
              {confirmLabel}
            </Button>
          </AlertDialogFooter>
        </form>
      </AlertDialogContent>
    </AlertDialog>
  );
}
