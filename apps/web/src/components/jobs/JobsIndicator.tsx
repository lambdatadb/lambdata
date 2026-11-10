import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Activity, ChevronRight } from "lucide-react";
import type { Job } from "@lambdata/shared";
import { Button } from "../ui/Button";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/Popover";
import { Spinner } from "../ui/Spinner";
import { SimpleTooltip } from "../ui/Tooltip";
import { cn } from "../ui/cn";
import { isJobActive, jobKindLabel, useRecentJobs } from "../../lib/jobs";
import { jobState } from "../../lib/jobOutcome";
import { useDatabases } from "../../lib/queries";
import { databasePath } from "../../lib/commands";
import { formatRelativeTime } from "../../lib/format";
import { JobProgress } from "./JobProgress";

export function JobsIndicator() {
  const [open, setOpen] = useState(false);
  const { jobs, error } = useRecentJobs(10);
  const databases = useDatabases();
  const names = useMemo(() => {
    const map = new Map<string, string>();
    for (const db of databases.data ?? []) map.set(db.id, db.displayName);
    return map;
  }, [databases.data]);

  const active = jobs.filter(isJobActive);
  const recent = jobs.filter((job) => !isJobActive(job)).slice(0, 5);
  const label = active.length > 0 ? `${active.length} running ${active.length === 1 ? "job" : "jobs"}` : "Background jobs";

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <SimpleTooltip content={label} side="bottom">
        <PopoverTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            aria-label={label}
            className={cn("relative", active.length > 0 && "text-text")}
          >
            {active.length > 0 ? <Spinner decorative size="md" className="text-accent" /> : <Activity />}
            {active.length > 0 && (
              <span className="absolute right-1 top-1 grid h-4 min-w-4 place-items-center rounded-full bg-accent px-1 font-mono text-micro leading-none text-accent-fg">
                {active.length}
              </span>
            )}
          </Button>
        </PopoverTrigger>
      </SimpleTooltip>
      <PopoverContent align="end" className="w-[min(22rem,calc(100vw-1.5rem))] p-0">
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <span className="text-heading font-semibold">Background jobs</span>
          <span className="font-mono text-micro text-text-subtle">{active.length} running</span>
        </div>
        <div className="max-h-[min(26rem,70dvh)] overflow-y-auto">
          {error ? (
            <p className="px-4 py-6 text-center text-body text-text-muted">Could not load jobs.</p>
          ) : jobs.length === 0 ? (
            <div className="px-4 py-8 text-center">
              <p className="text-body text-text">Nothing running</p>
              <p className="mt-1 text-label text-text-muted">
                Checkpoints, rollbacks, syncs and imports show their progress here.
              </p>
            </div>
          ) : (
            <>
              {active.length > 0 && (
                <ul className="divide-y divide-border">
                  {active.map((job) => (
                    <JobRow key={job.id} job={job} name={names.get(job.databaseId ?? "")} onNavigate={() => setOpen(false)} />
                  ))}
                </ul>
              )}
              {recent.length > 0 && (
                <>
                  <div className="border-t border-border px-4 pb-1 pt-3 text-micro font-medium text-text-subtle first:border-t-0">
                    Recent
                  </div>
                  <ul className="pb-2">
                    {recent.map((job) => (
                      <RecentRow key={job.id} job={job} name={names.get(job.databaseId ?? "")} onNavigate={() => setOpen(false)} />
                    ))}
                  </ul>
                </>
              )}
            </>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}

function JobRow({ job, name, onNavigate }: { job: Job; name?: string; onNavigate: () => void }) {
  return (
    <li className="space-y-2 px-4 py-3">
      <JobProgress job={job} variant="compact" />
      {job.databaseId && (
        <Link
          to={databasePath(job.databaseId)}
          onClick={onNavigate}
          className="inline-flex items-center gap-1 rounded-sm text-micro text-text-muted outline-none hover:text-text focus-visible:ring-2 focus-visible:ring-ring/70"
        >
          {name ?? "Open database"}
          <ChevronRight aria-hidden className="size-3" />
        </Link>
      )}
    </li>
  );
}

const RECENT_STATE: Record<string, { dot: string; text: string; label: string | null }> = {
  failed: { dot: "bg-danger", text: "text-danger", label: "failed" },
  refused: { dot: "bg-warn", text: "text-warn", label: "refused" },
  "done-with-errors": { dot: "bg-warn", text: "text-warn", label: "with errors" },
  succeeded: { dot: "bg-success", text: "text-text-subtle", label: null },
};

function RecentRow({ job, name, onNavigate }: { job: Job; name?: string; onNavigate: () => void }) {
  const state = jobState(job);
  const look = RECENT_STATE[state] ?? RECENT_STATE.succeeded!;
  const detail = state === "refused" ? "Refused, nothing was changed" : state === "done-with-errors" ? "Finished with errors" : null;
  const body = (
    <>
      <span aria-hidden className={cn("size-1.5 shrink-0 rounded-full", look.dot)} />
      <span className="min-w-0 flex-1 truncate text-label text-text">
        {jobKindLabel(job.kind)}
        {name && <span className="text-text-muted"> · {name}</span>}
        {detail && <span className="sr-only">. {detail}</span>}
      </span>
      <span className={cn("shrink-0 text-micro", look.text)} data-job-state={state}>
        {look.label ?? formatRelativeTime(job.finishedAt ?? job.createdAt)}
      </span>
    </>
  );
  const cls = "flex items-center gap-2.5 px-4 py-1.5";
  if (!job.databaseId) return <li className={cls}>{body}</li>;
  return (
    <li>
      <Link
        to={databasePath(job.databaseId)}
        onClick={onNavigate}
        className={cn(cls, "outline-none transition-colors hover:bg-bg-hover focus-visible:bg-bg-hover")}
      >
        {body}
      </Link>
    </li>
  );
}
