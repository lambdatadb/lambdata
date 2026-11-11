import { useState } from "react";
import { ChevronDown, GitCommitHorizontal, RefreshCw } from "lucide-react";
import type { Checkpoint, Job, WorkingCopyStatus } from "@lambdata/shared";
import { Button } from "../ui/Button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "../ui/Collapsible";
import { Skeleton } from "../ui/Skeleton";
import { Spinner } from "../ui/Spinner";
import { SimpleTooltip } from "../ui/Tooltip";
import { cn } from "../ui/cn";
import { errorMessage } from "../../lib/api";
import { formatRelativeTime } from "../../lib/format";
import { jobKindLabel } from "../../lib/jobs";
import { DiffList } from "./DiffList";
import type { GraphRow } from "./graph";
import { GraphCell, type WorkingTone } from "./GraphCell";
import { diffSummary } from "./meta";

export interface WorkingCopyRowProps {
  row: GraphRow;
  laneWidth: number;
  graphWidth: number;
  status: WorkingCopyStatus | undefined;
  statusLoading: boolean;
  statusError: unknown;
  base: Checkpoint | null;
  activeJob: Job | null;
  activeLabel: string | null;
  checking: boolean;
  onCheck: () => void;
  onCreate: (() => void) | null;
  createDisabled: string | null;
}

export function syncedOnly(status: WorkingCopyStatus | undefined): boolean {
  return status?.state === "dirty" && status.matchesLastSync === true;
}

export function workingTone(status: WorkingCopyStatus | undefined): WorkingTone {
  if (syncedOnly(status)) return "muted";
  if (status?.state === "dirty") return "dirty";
  if (status?.state === "clean") return "clean";
  return "muted";
}

export function WorkingCopyRow({
  row,
  laneWidth,
  graphWidth,
  status,
  statusLoading,
  statusError,
  base,
  activeJob,
  activeLabel,
  checking,
  onCheck,
  onCreate,
  createDisabled,
}: WorkingCopyRowProps) {
  const [open, setOpen] = useState(false);
  const tone = workingTone(status);
  const dirty = status?.state === "dirty" && status.diff;
  const baseShort = base?.shortHash ?? null;
  const canCheck = !!base && base.format === "v1" && !activeJob;

  const createButton = onCreate && (
    <SimpleTooltip content={createDisabled} disabled={!createDisabled}>
      <span className="inline-flex">
        <Button
          size="sm"
          onClick={onCreate}
          disabled={!!createDisabled}
          loading={!!activeJob && activeJob.kind === "checkpoint.create"}
        >
          <GitCommitHorizontal />
          Create checkpoint
        </Button>
      </span>
    </SimpleTooltip>
  );

  return (
    <li className="relative flex min-w-0">
      <div className="relative shrink-0" style={{ width: graphWidth }}>
        <GraphCell row={row} laneWidth={laneWidth} width={graphWidth} shape="working" workingTone={tone} />
      </div>
      <Collapsible open={open && !!dirty} onOpenChange={setOpen} className="min-w-0 flex-1 border-b border-border/70 py-3 pl-1 pr-3 sm:pr-4">
        <div className="flex min-w-0 flex-wrap items-start justify-between gap-x-4 gap-y-3">
          <div className="min-w-0 flex-[1_1_16rem]">
            <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
              <span className="text-body font-medium text-text">Working copy</span>
              <StateChip status={status} loading={statusLoading} error={statusError} activeLabel={activeLabel} />
            </div>
            <div className="mt-1 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-label text-text-muted">
              <Detail
                status={status}
                loading={statusLoading}
                error={statusError}
                baseShort={baseShort}
                activeJob={activeJob}
              />
              {dirty && (
                <CollapsibleTrigger asChild>
                  <button
                    type="button"
                    className="inline-flex items-center gap-1 rounded-sm text-text underline decoration-border-control underline-offset-4 outline-none hover:decoration-accent focus-visible:decoration-accent"
                  >
                    {open ? "Hide changes" : "Show changes"}
                    <ChevronDown aria-hidden className={cn("size-3.5 transition-transform", open && "rotate-180")} />
                  </button>
                </CollapsibleTrigger>
              )}
              {canCheck && (status?.state === "clean" || status?.state === "dirty") && (
                <SimpleTooltip content="Compare the live data with HEAD again">
                  <button
                    type="button"
                    onClick={onCheck}
                    disabled={checking}
                    className="inline-flex items-center gap-1 rounded-sm text-text-subtle outline-none hover:text-text focus-visible:text-text disabled:opacity-60"
                  >
                    <RefreshCw aria-hidden className={cn("size-3", checking && "animate-spin")} />
                    {status?.computedAt ? `checked ${formatRelativeTime(status.computedAt)}` : "check"}
                  </button>
                </SimpleTooltip>
              )}
              {canCheck && status?.state === "unknown" && (
                <Button size="xs" variant="secondary" onClick={onCheck} loading={checking}>
                  <RefreshCw />
                  Check now
                </Button>
              )}
            </div>
          </div>
          {createButton}
        </div>
        {dirty && (
          <CollapsibleContent>
            <div className="pt-3">
              <DiffList diff={status.diff!} dense />
            </div>
          </CollapsibleContent>
        )}
      </Collapsible>
    </li>
  );
}

function StateChip({
  status,
  loading,
  error,
  activeLabel,
}: {
  status: WorkingCopyStatus | undefined;
  loading: boolean;
  error: unknown;
  activeLabel: string | null;
}) {
  const base = "inline-flex items-center gap-1.5 rounded-[5px] border px-1.5 h-[18px] text-micro font-medium";
  if (activeLabel) {
    return (
      <span className={cn(base, "border-accent/30 bg-accent/[0.08] text-accent")}>
        <Spinner decorative size="xs" className="text-accent" />
        {activeLabel}
      </span>
    );
  }
  if (loading) return <Skeleton className="h-[18px] w-14" />;
  if (error || !status) return <span className={cn(base, "border-border text-text-muted")}>status unavailable</span>;
  if (status.state === "clean") return <span className={cn(base, "border-success/30 bg-success/[0.08] text-success")}>clean</span>;
  if (syncedOnly(status)) return <span className={cn(base, "border-info/30 bg-info/[0.08] text-info")}>synced, not in a checkpoint</span>;
  if (status.state === "dirty") return <span className={cn(base, "border-warn/30 bg-warn/[0.08] text-warn")}>uncommitted changes</span>;
  if (status.state === "no-checkpoint") return <span className={cn(base, "border-border text-text-muted")}>no checkpoints yet</span>;
  return <span className={cn(base, "border-border text-text-muted")}>not checked</span>;
}

function Detail({
  status,
  loading,
  error,
  baseShort,
  activeJob,
}: {
  status: WorkingCopyStatus | undefined;
  loading: boolean;
  error: unknown;
  baseShort: string | null;
  activeJob: Job | null;
}) {
  const hash = (h: string) => <span className="font-mono text-code leading-4 text-text">{h}</span>;
  if (activeJob) {
    return <span>{activeJob.stage ?? `${jobKindLabel(activeJob.kind)} in progress`}</span>;
  }
  if (loading) return <Skeleton className="h-3.5 w-56" />;
  if (error) return <span className="text-danger">Could not compare with HEAD: {errorMessage(error)}</span>;
  if (!status) return null;
  if (status.state === "clean") {
    return <span>The live data matches {baseShort ? hash(baseShort) : "HEAD"}</span>;
  }
  if (syncedOnly(status) && status.diff) {
    return (
      <span>
        Synced data, not yet in a checkpoint: {diffSummary(status.diff)} since {baseShort ? hash(baseShort) : "HEAD"}
      </span>
    );
  }
  if (status.state === "dirty" && status.diff) {
    return (
      <span className="text-text">
        {diffSummary(status.diff)} since {baseShort ? hash(baseShort) : "HEAD"}
      </span>
    );
  }
  if (status.state === "no-checkpoint") {
    return <span>Nothing has been captured yet.</span>;
  }
  return <span className="min-w-0">{status.reason ?? "Status has not been computed."}</span>;
}
