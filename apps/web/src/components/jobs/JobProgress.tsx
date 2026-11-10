import { ChevronRight, CircleAlert, CircleCheck, ShieldAlert, TriangleAlert } from "lucide-react";
import { useState, type ReactNode } from "react";
import type { CodeObjectFailure, Job } from "@lambdata/shared";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "../ui/Collapsible";
import { Progress } from "../ui/Progress";
import { Spinner } from "../ui/Spinner";
import { cn } from "../ui/cn";
import { formatDuration, formatRelativeTime } from "../../lib/format";
import { isJobActive, jobKindLabel } from "../../lib/jobs";
import { describeFailureKinds, jobCodeFailures, jobState, splitErrorMessage, visibleWarnings, type JobState } from "../../lib/jobOutcome";
import { CodeFailureList } from "./CodeFailureList";

export interface JobProgressProps {
  job: Job | null | undefined;
  variant?: "compact" | "full";
  title?: ReactNode;
  successMessage?: ReactNode;
  actions?: ReactNode;
  className?: string;
}

const STATE_TEXT: Record<JobState, string> = {
  queued: "Waiting for an earlier operation to finish",
  running: "Working",
  succeeded: "Finished",
  "done-with-errors": "Finished with errors",
  refused: "Refused · nothing was changed",
  failed: "Failed",
};

type FinishedState = Exclude<JobState, "queued" | "running">;

const COMPACT_LABEL: Record<FinishedState, string> = {
  succeeded: "succeeded",
  "done-with-errors": "with errors",
  refused: "refused",
  failed: "failed",
};

const BORDER: Record<JobState, string> = {
  queued: "border-border",
  running: "border-border",
  succeeded: "border-success/30",
  "done-with-errors": "border-warn/40",
  refused: "border-border-strong",
  failed: "border-danger/40",
};

const TONE = {
  queued: "accent",
  running: "accent",
  succeeded: "success",
  "done-with-errors": "warn",
  refused: "neutral",
  failed: "danger",
} as const satisfies Record<JobState, string>;

const LABEL_TONE: Record<JobState, string> = {
  queued: "text-text-muted",
  running: "text-text-muted",
  succeeded: "text-text-muted",
  "done-with-errors": "text-warn",
  refused: "text-warn",
  failed: "text-danger",
};

function stageText(job: Job, state: JobState): string {
  if (state === "running") return job.stage ?? STATE_TEXT.running;
  return STATE_TEXT[state];
}

function elapsed(job: Job): string | null {
  const start = job.startedAt ?? job.createdAt;
  const end = job.finishedAt ?? Date.now();
  if (!start) return null;
  return formatDuration(Math.max(0, end - start));
}

export function finishedWithErrorsText(failures: CodeObjectFailure[]): string {
  return `${describeFailureKinds(failures)} could not be created`;
}

function compactDetail(job: Job, state: JobState, failures: CodeObjectFailure[]): string {
  if (state === "failed") return job.error ?? STATE_TEXT.failed;
  if (state === "refused") return "Nothing was changed: some objects cannot be re-created";
  if (state === "done-with-errors") return `${finishedWithErrorsText(failures)}; the tables are in place`;
  return stageText(job, state);
}

function StateIcon({ state }: { state: JobState }) {
  if (state === "queued" || state === "running") return <Spinner decorative size="md" className="text-accent" />;
  if (state === "failed") return <CircleAlert aria-hidden className="size-4 shrink-0 text-danger" />;
  if (state === "refused") return <ShieldAlert aria-hidden className="size-4 shrink-0 text-warn" />;
  if (state === "done-with-errors") return <TriangleAlert aria-hidden className="size-4 shrink-0 text-warn" />;
  return <CircleCheck aria-hidden className="size-4 shrink-0 text-success" />;
}

export function JobErrorText({ message }: { message: string | null }) {
  const { lead, items } = splitErrorMessage(message ?? "The operation failed without an error message.");
  return (
    <div role="alert" className="max-h-64 space-y-1.5 overflow-y-auto break-words text-label">
      <p className="whitespace-pre-line text-danger">{lead}</p>
      {items.length > 0 && (
        <ul className="list-disc space-y-1 pl-5 text-text-muted">
          {items.map((item, i) => (
            <li key={i}>{item}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Refusal({ job, failures }: { job: Job; failures: CodeObjectFailure[] }) {
  const [open, setOpen] = useState(false);
  const what = failures.length > 0 ? `${describeFailureKinds(failures)} of this checkpoint` : "some of its views, triggers or routines";
  return (
    <div className="space-y-2.5">
      <p className="text-label">
        <span className="font-medium text-text">Nothing was changed.</span>{" "}
        <span className="text-text-muted">
          A trial run in a scratch copy showed that {what} cannot be re-created here, so the live database was left exactly as it was.
        </span>
      </p>
      <CodeFailureList failures={failures} label="Objects that cannot be re-created" />
      {job.error && failures.length === 0 && (
        <p className="max-h-48 overflow-y-auto whitespace-pre-line break-words text-label text-text-muted">{job.error}</p>
      )}
      {job.error && failures.length > 0 && (
        <Collapsible open={open} onOpenChange={setOpen}>
          <CollapsibleTrigger asChild>
            <button
              type="button"
              className="inline-flex items-center gap-1 rounded-sm text-label text-text-muted underline decoration-border-control underline-offset-4 outline-none hover:text-text hover:decoration-accent focus-visible:decoration-accent"
            >
              <ChevronRight aria-hidden className={cn("size-3.5 transition-transform", open && "rotate-90")} />
              {open ? "Hide the full message" : "Show the full message"}
            </button>
          </CollapsibleTrigger>
          <CollapsibleContent>
            <p className="mt-2 max-h-48 overflow-y-auto whitespace-pre-line break-words rounded-md border border-border bg-bg-panel px-3 py-2 text-label text-text-muted">
              {job.error}
            </p>
          </CollapsibleContent>
        </Collapsible>
      )}
    </div>
  );
}

function FinishedWithErrors({ failures }: { failures: CodeObjectFailure[] }) {
  const missing =
    failures.length === 0
      ? "the warnings below name what is missing"
      : failures.length === 1
        ? "only this object is missing"
        : "only these objects are missing";
  return (
    <div className="space-y-2 rounded-md border border-warn/30 bg-warn/[0.05] p-3">
      <p className="flex items-start gap-2 text-label">
        <TriangleAlert aria-hidden className="mt-0.5 size-3.5 shrink-0 text-warn" />
        <span>
          <span className="font-medium text-text">{finishedWithErrorsText(failures)}.</span>{" "}
          <span className="text-text-muted">The tables are in place; {missing}.</span>
        </span>
      </p>
      <CodeFailureList failures={failures} />
    </div>
  );
}

export function JobProgress({ job, variant = "full", title, successMessage, actions, className }: JobProgressProps) {
  if (!job) {
    return (
      <div className={cn("flex items-center gap-2 text-label text-text-muted", className)} role="status">
        <Spinner decorative size="sm" />
        Starting…
      </div>
    );
  }

  const state = jobState(job);
  const active = isJobActive(job);
  const failures = jobCodeFailures(job);
  const warnings = visibleWarnings(job);
  const finishedOk = state === "succeeded" || state === "done-with-errors";
  const percent = job.progress === null ? null : Math.round(job.progress * 100);
  const heading = title ?? jobKindLabel(job.kind);
  const barValue = finishedOk ? 100 : active ? percent : (percent ?? 100);

  if (variant === "compact") {
    const detail = compactDetail(job, state, failures);
    return (
      <div className={cn("min-w-0 space-y-1.5", className)} aria-live="polite" data-job-state={state}>
        <div className="flex items-baseline justify-between gap-3 text-label">
          <span className="min-w-0 truncate text-text">{heading}</span>
          <span className={cn("shrink-0 font-mono text-micro", LABEL_TONE[state])}>
            {active ? (percent !== null ? `${percent}%` : job.status) : COMPACT_LABEL[state as FinishedState]}
          </span>
        </div>
        <Progress value={barValue} tone={TONE[state]} size="xs" aria-label={`${jobKindLabel(job.kind)} progress`} />
        <div className="truncate text-micro text-text-subtle" title={detail}>
          {detail}
        </div>
        {actions && <div className="flex flex-wrap items-center gap-2 pt-1">{actions}</div>}
      </div>
    );
  }

  return (
    <div
      className={cn("min-w-0 space-y-3 rounded-lg border bg-bg-inset p-4", BORDER[state], className)}
      aria-live="polite"
      aria-busy={active || undefined}
      data-job-state={state}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2.5">
          <StateIcon state={state} />
          <div className="min-w-0">
            <div className="truncate text-body font-medium text-text">{heading}</div>
            <div className={cn("truncate text-label", state === "done-with-errors" || state === "refused" ? "text-warn" : "text-text-muted")}>
              {stageText(job, state)}
            </div>
          </div>
        </div>
        <div className="shrink-0 text-right font-mono text-micro text-text-subtle">
          {active && percent !== null && <div className="text-code text-text">{percent}%</div>}
          {elapsed(job) && <div>{elapsed(job)}</div>}
        </div>
      </div>
      {state !== "refused" && (
        <Progress value={barValue} tone={TONE[state]} size="sm" aria-label={`${jobKindLabel(job.kind)} progress`} />
      )}
      {state === "failed" && <JobErrorText message={job.error} />}
      {state === "refused" && <Refusal job={job} failures={failures} />}
      {finishedOk && successMessage && <div className="space-y-2 text-label text-text-muted">{successMessage}</div>}
      {state === "done-with-errors" && <FinishedWithErrors failures={failures} />}
      {warnings.length > 0 && (
        <div className="space-y-1.5 border-t border-border pt-3">
          <div className="flex items-center gap-1.5 text-label font-medium text-warn">
            <TriangleAlert aria-hidden className="size-3.5" />
            {warnings.length === 1 ? "1 warning" : `${warnings.length} warnings`}
          </div>
          <ul className="max-h-40 space-y-1 overflow-y-auto pl-5 text-label text-text-muted">
            {warnings.map((warning, i) => (
              <li key={i} className="list-disc break-words">
                {warning}
              </li>
            ))}
          </ul>
        </div>
      )}
      {!active && job.finishedAt && (
        <div className="text-micro text-text-subtle">
          {state === "refused" ? "Refused" : "Finished"} {formatRelativeTime(job.finishedAt)}
        </div>
      )}
      {actions && <div className="flex flex-wrap items-center gap-2 border-t border-border pt-3">{actions}</div>}
    </div>
  );
}
