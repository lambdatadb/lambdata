import { FileText, Upload, X } from "lucide-react";
import { useId, useRef, useState, type DragEvent, type HTMLAttributes, type KeyboardEvent, type ReactNode } from "react";
import { formatBytes } from "../../lib/format";
import { Button } from "./Button";
import { FieldError } from "./Field";
import { cn } from "./cn";
import { focusRing } from "./styles";

export interface FileRejection {
  file: File;
  reason: "type" | "size" | "count";
  message: string;
}

export interface FileDropzoneProps
  extends Omit<HTMLAttributes<HTMLDivElement>, "onDrop" | "onChange" | "title" | "children" | "role" | "tabIndex"> {
  onFiles: (files: File[]) => void;
  onReject?: (rejections: FileRejection[]) => void;
  accept?: string;
  multiple?: boolean;
  maxSize?: number;
  disabled?: boolean;
  title?: ReactNode;
  description?: ReactNode;
  icon?: ReactNode;
  files?: File[];
  onRemove?: (index: number) => void;
  error?: ReactNode;
  compact?: boolean;
  zoneClassName?: string;
}

function matchesAccept(file: File, accept?: string): boolean {
  if (!accept) return true;
  const name = file.name.toLowerCase();
  const type = file.type.toLowerCase();
  return accept
    .split(",")
    .map((t) => t.trim().toLowerCase())
    .filter(Boolean)
    .some((rule) => {
      if (rule.startsWith(".")) return name.endsWith(rule);
      if (rule.endsWith("/*")) return type.startsWith(rule.slice(0, -1));
      return type === rule;
    });
}

export function FileDropzone({
  onFiles,
  onReject,
  accept,
  multiple = false,
  maxSize,
  disabled = false,
  title,
  description,
  icon,
  files,
  onRemove,
  error,
  compact = false,
  className,
  zoneClassName,
  "aria-describedby": describedBy,
  ...rest
}: FileDropzoneProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const depth = useRef(0);
  const [dragging, setDragging] = useState(false);
  const [rejection, setRejection] = useState<string | null>(null);
  const descriptionId = useId();
  const errorId = useId();

  const handle = (list: FileList | null) => {
    if (!list || disabled) return;
    const incoming = Array.from(list);
    const accepted: File[] = [];
    const rejected: FileRejection[] = [];
    incoming.forEach((file, i) => {
      if (!multiple && i > 0) {
        rejected.push({ file, reason: "count", message: "Only one file can be added" });
      } else if (!matchesAccept(file, accept)) {
        rejected.push({ file, reason: "type", message: `${file.name} is not an accepted file type` });
      } else if (maxSize !== undefined && file.size > maxSize) {
        rejected.push({ file, reason: "size", message: `${file.name} is larger than ${formatBytes(maxSize)}` });
      } else {
        accepted.push(file);
      }
    });
    setRejection(rejected[0]?.message ?? null);
    if (rejected.length) onReject?.(rejected);
    if (accepted.length) onFiles(accepted);
    if (inputRef.current) inputRef.current.value = "";
  };

  const open = () => {
    if (!disabled) inputRef.current?.click();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      open();
    }
  };

  const onDragEnter = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    if (disabled) return;
    depth.current += 1;
    setDragging(true);
  };

  const onDragLeave = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    depth.current = Math.max(0, depth.current - 1);
    if (depth.current === 0) setDragging(false);
  };

  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    depth.current = 0;
    setDragging(false);
    handle(event.dataTransfer.files);
  };

  const message = error ?? rejection;

  return (
    <div className={cn("min-w-0 space-y-2", className)}>
      <div
        {...rest}
        role="button"
        tabIndex={disabled ? -1 : 0}
        aria-disabled={disabled || undefined}
        aria-describedby={
          [describedBy, description ? descriptionId : null, message ? errorId : null].filter(Boolean).join(" ") || undefined
        }
        aria-invalid={message ? true : undefined}
        data-dragging={dragging ? "" : undefined}
        onClick={open}
        onKeyDown={onKeyDown}
        onDragEnter={onDragEnter}
        onDragOver={(e) => {
          e.preventDefault();
          if (!disabled) e.dataTransfer.dropEffect = "copy";
        }}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
        className={cn(
          "group flex cursor-pointer flex-col items-center justify-center gap-3 rounded-lg border border-dashed border-border-input bg-bg-inset/60 text-center transition-colors",
          "hover:border-border-control hover:bg-bg-inset",
          "data-[dragging]:border-accent/70 data-[dragging]:bg-accent/[0.04]",
          message && "border-danger/60",
          disabled && "pointer-events-none cursor-not-allowed opacity-50",
          compact ? "px-4 py-4 sm:flex-row sm:justify-start sm:text-left" : "px-6 py-8",
          focusRing,
          zoneClassName,
        )}
      >
        <span
          className={cn(
            "grid size-10 shrink-0 place-items-center rounded-full border border-border-strong bg-bg-raised text-text-muted transition-colors",
            "group-data-[dragging]:border-accent/40 group-data-[dragging]:text-accent [&_svg:not([class*='size-'])]:size-[18px]",
          )}
        >
          {icon ?? <Upload aria-hidden />}
        </span>
        <span className="min-w-0 space-y-1">
          <span className="block text-body font-medium text-text">
            {dragging ? "Drop to add" : title ?? (
              <>
                Drop {multiple ? "files" : "a file"} here or <span className="underline decoration-border-control underline-offset-4">browse</span>
              </>
            )}
          </span>
          {description && (
            <span id={descriptionId} className="block text-label text-text-muted">
              {description}
            </span>
          )}
        </span>
        <input
          ref={inputRef}
          type="file"
          tabIndex={-1}
          aria-hidden
          className="sr-only"
          accept={accept}
          multiple={multiple}
          disabled={disabled}
          onChange={(e) => handle(e.target.files)}
          onClick={(e) => e.stopPropagation()}
        />
      </div>
      {message && <FieldError id={errorId}>{message}</FieldError>}
      {files && files.length > 0 && (
        <ul className="divide-y divide-border overflow-hidden rounded-md border border-border bg-bg-panel">
          {files.map((file, index) => (
            <li key={`${file.name}-${index}`} className="flex items-center gap-3 px-3 py-2">
              <FileText aria-hidden className="size-4 shrink-0 text-text-subtle" />
              <span className="min-w-0 flex-1 truncate font-mono text-code text-text" title={file.name}>
                {file.name}
              </span>
              <span className="shrink-0 font-mono text-micro text-text-subtle">{formatBytes(file.size)}</span>
              {onRemove && (
                <Button variant="ghost" size="icon-xs" aria-label={`Remove ${file.name}`} onClick={() => onRemove(index)}>
                  <X aria-hidden />
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
