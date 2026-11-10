import type { ReactNode } from "react";
import { Database as DatabaseIcon, FileCode2, FileUp, Info, RotateCw, X } from "lucide-react";
import type { ImportPlan, ImportUpload } from "@lambdata/shared";
import { Alert } from "../ui/Alert";
import { Button } from "../ui/Button";
import { FileDropzone } from "../ui/FileDropzone";
import { Progress } from "../ui/Progress";
import { cn } from "../ui/cn";
import { ApiError, errorMessage } from "../../lib/api";
import { formatBytes } from "../../lib/format";
import { useImportLimits } from "./api";
import { formatEta, formatLabel, formatRate, sentence, shortHash } from "./format";
import type { ImportRefusal, ImportSource, UploadingState } from "./useImportSource";

export function ImportDropzone({
  onFile,
  refusal,
  disabled,
  compact,
}: {
  onFile: (file: File) => void;
  refusal: ImportRefusal | null;
  disabled?: boolean;
  compact?: boolean;
}) {
  const limits = useImportLimits();
  const maxBytes = limits.data?.maxUploadBytes && limits.data.maxUploadBytes > 0 ? limits.data.maxUploadBytes : undefined;
  return (
    <div className="space-y-3">
      {refusal && (
        <Alert variant="danger" title={`${refusal.fileName} can't be imported`}>
          {sentence(refusal.message)}
        </Alert>
      )}
      <FileDropzone
        onFiles={(files) => {
          const file = files[0];
          if (file) onFile(file);
        }}
        disabled={disabled}
        compact={compact}
        maxSize={maxBytes}
        icon={<FileUp aria-hidden />}
        aria-label="Choose a database file to import"
        title={
          <>
            Drop a database file here or{" "}
            <span className="underline decoration-border-control underline-offset-4">browse</span>
          </>
        }
        description={
          <>
            Any SQLite 3 file, such as a game server&apos;s <span className="font-mono text-code">sv.db</span>, or a MySQL/MariaDB dump
            (.sql, .sql.gz). Upload the database file itself, not a .zip or .gz of it.
            {maxBytes ? ` Up to ${formatBytes(maxBytes)}.` : null}
          </>
        }
        zoneClassName={compact ? undefined : "min-h-[13rem]"}
      />
      <WalHint />
    </div>
  );
}

export function WalHint({ className }: { className?: string }) {
  return (
    <div className={cn("flex gap-2.5 rounded-lg border border-border bg-bg-inset/60 px-3.5 py-3 text-label text-text-muted", className)}>
      <Info aria-hidden className="mt-px size-3.5 shrink-0 text-info" />
      <p className="min-w-0">
        <span className="font-medium text-text">Copy the file while the game server is stopped.</span> A running server keeps its
        newest writes in a separate <span className="font-mono text-code text-text">-wal</span> file, so a lone{" "}
        <span className="font-mono text-code text-text">.db</span> copied mid-game can be missing them. If it has to stay up, checkpoint
        first (<span className="font-mono text-code text-text">PRAGMA wal_checkpoint(TRUNCATE)</span>) so the log is folded into the file.
      </p>
    </div>
  );
}

function FileGlyph({ format }: { format: ImportUpload["format"] | null }) {
  return (
    <span className="grid size-9 shrink-0 place-items-center rounded-md border border-border-strong bg-bg-raised text-text-muted">
      {format === "sql" ? <FileCode2 aria-hidden className="size-4" /> : <DatabaseIcon aria-hidden className="size-4" />}
    </span>
  );
}

function ProgressCard({
  format,
  fileName,
  status,
  percent,
  detail,
  cancelLabel,
  onCancel,
}: {
  format: ImportUpload["format"] | null;
  fileName: string;
  status: ReactNode;
  percent: number | null;
  detail: ReactNode;
  cancelLabel: string;
  onCancel: () => void;
}) {
  return (
    <div
      className="flex min-h-[13rem] flex-col justify-center gap-4 rounded-lg border border-border bg-bg-inset px-4 py-5 sm:px-5"
      aria-live="polite"
      aria-busy
    >
      <div className="flex items-center gap-3">
        <FileGlyph format={format} />
        <div className="min-w-0 flex-1">
          <div className="truncate font-mono text-code text-text" title={fileName}>
            {fileName}
          </div>
          <div className="truncate text-label text-text-muted">{status}</div>
        </div>
        {percent !== null && <div className="shrink-0 font-mono text-heading tabular-nums text-text">{percent}%</div>}
      </div>
      <Progress value={percent} size="sm" aria-label={percent === null ? "Working" : "Upload progress"} />
      <div className="flex min-h-7 items-center justify-between gap-3 text-label text-text-muted">
        <span className="min-w-0 truncate tabular-nums">{detail}</span>
        <Button size="xs" variant="ghost" onClick={onCancel} className="-mr-2 shrink-0">
          <X /> {cancelLabel}
        </Button>
      </div>
    </div>
  );
}

export function UploadPanel({ state, onCancel }: { state: UploadingState; onCancel: () => void }) {
  const fraction = state.total > 0 ? Math.min(1, state.loaded / state.total) : null;
  const finishing = fraction !== null && fraction >= 1;
  const percent = fraction === null || finishing ? null : Math.floor(fraction * 100);
  const rate = formatRate(state.rate);
  const eta = state.rate && state.rate > 0 ? formatEta((state.total - state.loaded) / state.rate) : null;
  return (
    <ProgressCard
      format={null}
      fileName={state.file.name}
      status={
        finishing
          ? "Uploaded. Checking what kind of file this is…"
          : `Uploading ${formatBytes(state.loaded)} of ${formatBytes(state.total)}`
      }
      percent={percent}
      detail={finishing ? formatBytes(state.total) : [rate, eta].filter(Boolean).join(" · ") || "Starting…"}
      cancelLabel="Cancel upload"
      onCancel={onCancel}
    />
  );
}

export function AnalysingPanel({ file, upload, onCancel }: { file: File; upload: ImportUpload; onCancel: () => void }) {
  return (
    <ProgressCard
      format={upload.format}
      fileName={upload.fileName || file.name}
      status={
        upload.format === "sqlite"
          ? "Reading the tables and measuring what each column actually stores…"
          : "Reading the start of the dump…"
      }
      percent={null}
      detail={`${formatLabel(upload)} · ${formatBytes(upload.sizeBytes)}`}
      cancelLabel="Cancel"
      onCancel={onCancel}
    />
  );
}

export function FileFacts({
  file,
  upload,
  plan,
  showHash = true,
}: {
  file: File;
  upload: ImportUpload;
  plan?: ImportPlan | null;
  showHash?: boolean;
}) {
  return (
    <div className="flex min-w-0 items-center gap-3">
      <FileGlyph format={upload.format} />
      <div className="min-w-0 flex-1">
        <div className="truncate font-mono text-code text-text" title={upload.fileName || file.name}>
          {upload.fileName || file.name}
        </div>
        <div className="truncate text-label text-text-muted">
          {formatLabel(upload, plan)} · {formatBytes(upload.sizeBytes)}
          <span className={showHash ? "hidden sm:inline" : "hidden"}>
            {" "}
            · sha256{" "}
            <span className="font-mono text-micro text-text-subtle" title={upload.sha256}>
              {shortHash(upload.sha256)}
            </span>
          </span>
        </div>
      </div>
    </div>
  );
}

export function FileStrip({
  file,
  upload,
  plan,
  action,
  className,
}: {
  file: File;
  upload: ImportUpload;
  plan?: ImportPlan | null;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border border-border bg-bg-inset px-4 py-3", className)}>
      <div className="min-w-0 flex-[1_1_14rem]">
        <FileFacts file={file} upload={upload} plan={plan} />
      </div>
      {action && <div className="flex shrink-0 flex-wrap items-center gap-2">{action}</div>}
    </div>
  );
}

export function PlanFailed({
  file,
  upload,
  error,
  onRetry,
  onReset,
}: {
  file: File;
  upload: ImportUpload;
  error: unknown;
  onRetry: () => void;
  onReset: () => void;
}) {
  const name = upload.fileName || file.name;
  const gone = error instanceof ApiError && (error.status === 404 || error.status === 410);
  return (
    <div className="space-y-3">
      <FileStrip file={file} upload={upload} />
      <Alert
        variant="danger"
        title={gone ? `${name} is no longer on the server` : `Couldn't read the tables in ${name}`}
        action={
          gone ? (
            <Button size="xs" variant="secondary" onClick={onReset}>
              <RotateCw /> Upload again
            </Button>
          ) : (
            <>
              <Button size="xs" variant="secondary" onClick={onRetry}>
                <RotateCw /> Try again
              </Button>
              <Button size="xs" variant="ghost" onClick={onReset}>
                Choose another file
              </Button>
            </>
          )
        }
      >
        {sentence(errorMessage(error))}
      </Alert>
    </div>
  );
}

export function SourceStep({ source, compactDropzone }: { source: ImportSource; compactDropzone?: boolean }) {
  const { state } = source;
  if (state.phase === "idle") return <ImportDropzone onFile={source.start} refusal={state.refusal} compact={compactDropzone} />;
  if (state.phase === "uploading" || state.phase === "analysing") {
    return (
      <div className="space-y-3">
        {state.phase === "uploading" ? (
          <UploadPanel state={state} onCancel={source.cancel} />
        ) : (
          <AnalysingPanel file={state.file} upload={state.upload} onCancel={source.cancel} />
        )}
        <WalHint />
      </div>
    );
  }
  if (state.phase === "plan-failed") {
    return <PlanFailed file={state.file} upload={state.upload} error={state.error} onRetry={source.retryPlan} onReset={source.reset} />;
  }
  return null;
}
