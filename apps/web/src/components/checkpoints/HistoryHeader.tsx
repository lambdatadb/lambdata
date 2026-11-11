import { Link } from "react-router-dom";
import { CalendarClock, GitBranch, HardDrive, SlidersHorizontal } from "lucide-react";
import type { CheckpointListResponse, Database } from "@lambdata/shared";
import { Card } from "../ui/Card";
import { Skeleton } from "../ui/Skeleton";
import { StatusDot } from "../ui/Badge";
import { databasePath } from "../../lib/commands";
import { formatBytes, formatDate, formatRelativeTime, pluralize } from "../../lib/format";
import { savingsPercent } from "./meta";
import { compactSummary, formatDue, lastCheckFoundNothing } from "./policy";

function SettingsLink({ db, canWrite }: { db: Database; canWrite: boolean }) {
  return (
    <Link
      to={databasePath(db.id, "settings")}
      className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md border border-border-strong bg-bg-raised px-2.5 text-label font-medium text-text transition-colors hover:border-border-input hover:bg-bg-hover"
    >
      <SlidersHorizontal aria-hidden className="size-3.5" />
      {canWrite ? "Change in Settings" : "See Settings"}
    </Link>
  );
}

export interface HistoryHeaderProps {
  db: Database;
  data: CheckpointListResponse | undefined;
  loading: boolean;
  canWrite: boolean;
}

export function HistoryHeader({ db, data, loading, canWrite }: HistoryHeaderProps) {
  const policy = data?.policy;
  const storage = data?.storage;
  const schedule = data?.schedule;
  const versioned = policy?.versioned ?? db.versioned;
  const unshared = (data?.checkpoints ?? []).reduce((n, cp) => n + cp.storedBytes, 0);
  const saving = savingsPercent(storage?.storedBytes ?? 0, unshared);

  return (
    <Card flush className="grid grid-cols-1 divide-y divide-border md:grid-cols-[minmax(0,1.25fr)_minmax(0,1fr)_minmax(0,1fr)] md:divide-x md:divide-y-0">
      <div className="min-w-0 px-5 py-4" data-versioned={versioned ? "on" : "off"}>
        <div className="flex items-center justify-between gap-2 text-label font-medium text-text-muted">
          <span className="inline-flex items-center gap-1.5">
            <GitBranch aria-hidden className="size-3.5 text-text-subtle" />
            Versioning
          </span>
        </div>
        <div className="mt-1.5 flex items-center gap-2 text-body font-medium text-text">
          <StatusDot tone={versioned ? "success" : "muted"} />
          {versioned ? "Versioned" : "Not versioned"}
        </div>
        <p className="mt-0.5 text-micro text-text-subtle">
          {versioned
            ? "Its card shows whether the live data changed since the last checkpoint."
            : "Turn it on in Settings to compare the live data with the last checkpoint."}
        </p>
      </div>
      <div className="min-w-0 px-5 py-4">
        <div className="flex items-center justify-between gap-2 text-label font-medium text-text-muted">
          <span>History storage</span>
          <HardDrive aria-hidden className="size-3.5 text-text-subtle" />
        </div>
        {loading ? (
          <div className="mt-2 space-y-1.5">
            <Skeleton className="h-6 w-28" />
            <Skeleton className="h-3 w-40" />
          </div>
        ) : !storage ? (
          <p className="mt-1.5 text-body text-text-subtle">Unavailable</p>
        ) : (
          <>
            <div className="mt-1 flex flex-wrap items-baseline gap-x-2">
              <span className="font-mono text-metric font-medium tracking-[-0.04em] text-text">{formatBytes(storage.storedBytes)}</span>
              <span className="text-label text-text-muted">on disk</span>
            </div>
            <StorageBar stored={storage.storedBytes} unshared={unshared} />
            <p className="mt-1.5 text-micro text-text-subtle">
              {storage.checkpoints === 0 ? (
                "No checkpoints stored yet"
              ) : (
                <>
                  {pluralize(storage.checkpoints, "checkpoint")} ·{" "}
                  <span className="font-mono text-text-muted">{formatBytes(storage.logicalBytes)}</span> of SQL, compressed
                  {saving !== null && saving > 0 && (
                    <>
                      {" "}
                      · sharing unchanged tables saves{" "}
                      <span className="text-text-muted">
                        {formatBytes(unshared - storage.storedBytes)} ({saving}%)
                      </span>
                    </>
                  )}
                </>
              )}
            </p>
          </>
        )}
      </div>
      <div className="min-w-0 px-5 py-4">
        <div className="flex items-center justify-between gap-2 text-label font-medium text-text-muted">
          <span>Automatic checkpoints</span>
          <CalendarClock aria-hidden className="size-3.5 text-text-subtle" />
        </div>
        {loading ? (
          <div className="mt-2 space-y-1.5">
            <Skeleton className="h-5 w-32" />
            <Skeleton className="h-3 w-44" />
          </div>
        ) : !policy ? (
          <p className="mt-1.5 text-body text-text-subtle">Unavailable</p>
        ) : (
          <div className="mt-1.5 flex flex-wrap items-center justify-between gap-x-3 gap-y-2" data-policy-summary>
            <div className="min-w-0">
              <div className="text-body font-medium text-text">{compactSummary(policy, db.kind === "mirror")}</div>
              <p className="text-micro text-text-subtle">
                {schedule?.nextDueAt ? (
                  <span title={formatDate(schedule.nextDueAt)}>Next due after {formatDue(schedule.nextDueAt)}</span>
                ) : schedule?.lastAutomaticAt ? (
                  <span title={formatDate(schedule.lastAutomaticAt)}>
                    Last automatic check {formatRelativeTime(schedule.lastAutomaticAt)}
                    {lastCheckFoundNothing(schedule.lastAutomaticAt, data?.checkpoints) ? " (nothing had changed)" : ""}
                  </span>
                ) : (
                  "Manual, pinned and HEAD checkpoints are always kept"
                )}
              </p>
            </div>
            <SettingsLink db={db} canWrite={canWrite} />
          </div>
        )}
      </div>
    </Card>
  );
}

function StorageBar({ stored, unshared }: { stored: number; unshared: number }) {
  const ratio = unshared > 0 ? Math.min(1, stored / unshared) : 0;
  const label =
    unshared > 0
      ? `${formatBytes(stored)} on disk; ${formatBytes(unshared)} if every checkpoint stored all of its tables`
      : "Nothing stored yet";
  return (
    <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-bg-hover" role="img" aria-label={label} title={label}>
      <div className="h-full rounded-full bg-accent" style={{ width: `${unshared > 0 ? Math.max(2, ratio * 100) : 0}%` }} />
    </div>
  );
}
