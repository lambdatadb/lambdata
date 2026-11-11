import { useEffect, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CalendarClock, Play, SlidersHorizontal } from "lucide-react";
import type { CheckpointPolicy, Database, Job, SyncJob, SyncJobResult, SyncSourceKind } from "@lambdata/shared";
import { QueryError } from "../../components/layout/QueryError";
import { CodeFailureList } from "../../components/jobs/CodeFailureList";
import { JobConflictNotice } from "../../components/jobs/JobConflictNotice";
import { finishedWithErrorsText, JobProgress } from "../../components/jobs/JobProgress";
import { Alert } from "../../components/ui/Alert";
import { Badge } from "../../components/ui/Badge";
import { Button } from "../../components/ui/Button";
import { Card, CardContent, CardFooter, CardHeader } from "../../components/ui/Card";
import { Field, FieldGroup } from "../../components/ui/Field";
import { Input } from "../../components/ui/Input";
import { SelectMenu } from "../../components/ui/Select";
import { SkeletonRows } from "../../components/ui/Skeleton";
import { useToast } from "../../components/ui/Toast";
import { invalidateHistory, useCheckpointList, useDatabaseJobs } from "../../components/checkpoints/queries";
import { compactSummary, formatDue, settingsSummary, syncCheckpointLine, syncIntervalLabel } from "../../components/checkpoints/policy";
import { useSyncNow } from "../../components/sync/SyncNow";
import { changeHeadline, notComparedText, readSyncChanges, SyncChanges } from "../../components/sync/SyncChanges";
import { api, errorMessage } from "../../lib/api";
import { useCanWriteDatabase } from "../../lib/auth";
import { databasePath } from "../../lib/commands";
import { formatDate, formatRelativeTime, pluralize } from "../../lib/format";
import { isJobActive, isJobConflict, useActiveJobs, useJob, useTrackJob } from "../../lib/jobs";
import { jobCodeFailures, jobState } from "../../lib/jobOutcome";
import { queryKeys } from "../../lib/queries";
import { useTerminology } from "../../lib/terminology";
import type { DatabaseTabProps } from "./types";

const REVEAL_AFTER_MS = 1_000;

export function SyncTab({ db }: DatabaseTabProps) {
  const query = useQuery({
    queryKey: queryKeys.sync(db.id),
    queryFn: () => api.get<{ sync: SyncJob | null }>(`/databases/${db.id}/sync`),
  });

  if (query.isPending) {
    return (
      <Card>
        <SkeletonRows rows={5} />
      </Card>
    );
  }
  if (query.isError) {
    return <QueryError error={query.error} title="Could not load the sync configuration" onRetry={query.refetch} />;
  }
  const current = query.data.sync;
  return (
    <div className="space-y-4">
      {current && <SyncStatusCard db={db} current={current} />}
      <SyncForm key={current?.id ?? "new"} db={db} current={current} />
    </div>
  );
}

function SyncStatusCard({ db, current }: { db: Database; current: SyncJob }) {
  const qc = useQueryClient();
  const toast = useToast();
  const track = useTrackJob();
  const canWrite = useCanWriteDatabase(db);
  const active = useActiveJobs(db.id);
  const recent = useDatabaseJobs(db.id, active.hasActive);
  const history = useCheckpointList(db.id);
  const [jobId, setJobId] = useState<string | null>(null);
  const [revealed, setRevealed] = useState<string | null>(null);
  const started = useJob(jobId, {
    onDone: (job) => {
      void qc.invalidateQueries({ queryKey: queryKeys.sync(db.id) });
      void invalidateHistory(qc, db.id);
      if (jobState(job) === "done-with-errors") {
        toast.warning("Sync finished with errors", {
          description: `${finishedWithErrorsText(jobCodeFailures(job))} in the mirror. The tables are in place.`,
        });
      } else if (job.status === "succeeded") {
        const r = job.result as unknown as SyncJobResult | null;
        const line = r ? syncCheckpointLine(r, null, intervalRef.current) : null;
        const changes = readSyncChanges(r?.changes);
        const what = changes ? [`${changeHeadline(changes)}.`, notComparedText(changes)].filter(Boolean).join(" ") : r?.unchanged ? "No data changed." : r ? `${pluralize(r.tables, "table")} copied.` : null;
        toast.success("Sync finished", {
          description: r ? [what, line ? `${line.text}.`.replace(/\.\.$/, ".") : null].filter(Boolean).join(" ") : undefined,
        });
      }
    },
  });

  const intervalRef = useRef<number | null>(null);
  intervalRef.current = history.data?.policy.autoIntervalHours ?? null;
  const sync = useSyncNow(db, (job) => {
    track(job);
    setJobId(job.id);
  });
  const run = sync.run;
  const [params, setParams] = useSearchParams();
  const wantsRun = params.get("run") === "1";

  useEffect(() => {
    if (!wantsRun || !sync.ready) return;
    setParams(
      (p) => {
        const next = new URLSearchParams(p);
        next.delete("run");
        return next;
      },
      { replace: true },
    );
    if (canWrite && !active.hasActive) sync.start();
  }, [wantsRun, sync.ready]);

  const otherActive = active.jobs.find((j) => j.id !== jobId && isJobActive(j)) ?? null;
  const live: Job | null = started.job && (isJobActive(started.job) || revealed === started.job.id) ? started.job : otherActive;
  const busy = active.hasActive || started.isActive;

  useEffect(() => {
    if (!live || !isJobActive(live) || revealed === live.id) return;
    const begun = live.startedAt ?? live.createdAt;
    const timer = setTimeout(() => setRevealed(live.id), Math.max(0, REVEAL_AFTER_MS - (Date.now() - begun)));
    return () => clearTimeout(timer);
  }, [live, revealed]);

  useEffect(() => {
    if (started.job?.status === "failed") setRevealed(started.job.id);
  }, [started.job?.status, started.job?.id]);

  const lastSync = (recent.data ?? [])
    .filter((j) => j.kind === "sync.run" && !isJobActive(j))
    .sort((a, b) => (b.finishedAt ?? b.createdAt) - (a.finishedAt ?? a.createdAt))[0];
  const lastResult = lastSync?.status === "succeeded" ? (lastSync.result as unknown as SyncJobResult | null) : null;
  const lastChanges = readSyncChanges(lastResult?.changes);
  const lastWithErrors = !!lastSync && jobState(lastSync) === "done-with-errors" && current.lastStatus === "ok";
  const lastFailures = lastWithErrors && lastSync ? jobCodeFailures(lastSync) : [];
  const byId = new Map((history.data?.checkpoints ?? []).map((cp) => [cp.id, cp]));
  const recorded = lastResult?.checkpointId ? byId.get(lastResult.checkpointId) : null;
  const preSync = lastResult?.preSyncCheckpointId ? byId.get(lastResult.preSyncCheckpointId) : null;
  const policy = history.data?.policy;
  const lastLine = lastResult ? syncCheckpointLine(lastResult, recorded?.shortHash ?? null, policy?.autoIntervalHours ?? null) : null;
  const showPanel = live && revealed === live.id;

  return (
    <Card flush>
      <CardHeader
        divided
        title="Last sync"
        description={
          current.enabled
            ? `Copies ${current.sourceHost}/${current.sourceDatabase} into this mirror every ${everyLabel(current.intervalSeconds)}.`
            : `Copies ${current.sourceHost}/${current.sourceDatabase} into this mirror when you run it. The schedule is paused.`
        }
        action={
          canWrite ? (
            <Button
              size="sm"
              variant="secondary"
              onClick={sync.start}
              loading={run.isPending || (started.isActive && !showPanel)}
              disabled={busy || !sync.ready}
            >
              <Play />
              Sync now
            </Button>
          ) : undefined
        }
      />
      <CardContent className="space-y-4">
        {showPanel && live ? (
          <JobProgress
            job={live}
            title={
              isJobActive(live)
                ? "Syncing"
                : live.status === "failed"
                  ? "Sync failed"
                  : jobState(live) === "done-with-errors"
                    ? "Sync finished with errors"
                    : "Sync finished"
            }
            successMessage={syncSummary(live, byId, policy?.autoIntervalHours ?? null)}
          />
        ) : (
          <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1.5 text-body">
            {current.lastRunAt ? (
              <>
                <Badge variant={lastWithErrors ? "warn" : current.lastStatus === "ok" ? "success" : "danger"} size="md" dot>
                  {lastWithErrors ? "finished with errors" : current.lastStatus === "ok" ? "succeeded" : "failed"}
                </Badge>
                <span className="text-text-muted" title={formatDate(current.lastRunAt)}>
                  {formatRelativeTime(current.lastRunAt)}
                </span>
                {lastResult && (
                  <span className="basis-full text-text-muted sm:basis-auto">
                    <span aria-hidden className="hidden sm:inline">· </span>
                    {pluralize(lastResult.tables, "table")} ·{" "}
                    {lastChanges
                      ? lastChanges.tablesChanged === 0
                        ? (lastChanges.tablesNotCompared ?? 0) > 0
                          ? "not fully compared"
                          : "nothing changed"
                        : `${pluralize(lastChanges.tablesChanged, "table")} changed`
                      : lastResult.unchanged
                        ? "no data changed"
                        : "data changed"}
                    {lastLine && (
                      <>
                        {" "}
                        ·{" "}
                        {recorded ? (
                          <Link
                            to={databasePath(db.id, "history", encodeURIComponent(recorded.id))}
                            className="text-text underline decoration-border-control underline-offset-4 hover:decoration-accent"
                          >
                            {lastLine.text}
                          </Link>
                        ) : (
                          <span className={lastLine.tone === "warn" ? "text-warn" : undefined}>{lastLine.text}</span>
                        )}
                      </>
                    )}
                    {preSync && (
                      <>
                        {" "}
                        · local changes saved as{" "}
                        <Link
                          to={databasePath(db.id, "history", encodeURIComponent(preSync.id))}
                          className="font-mono text-code text-text underline decoration-border-control underline-offset-4 hover:decoration-accent"
                        >
                          {preSync.shortHash}
                        </Link>
                      </>
                    )}
                  </span>
                )}
              </>
            ) : (
              <span className="text-text-muted">This mirror has not synced yet.</span>
            )}
            {!current.enabled && <Badge variant="muted">paused</Badge>}
          </div>
        )}
        {!showPanel && lastChanges && (lastChanges.tablesChanged > 0 || (lastChanges.tablesNotCompared ?? 0) > 0) && <SyncChanges changes={lastChanges} />}
        {!showPanel && lastWithErrors && lastSync && (
          <Alert variant="warning" title={`${finishedWithErrorsText(lastFailures)} in the mirror`} data-job-state="done-with-errors">
            <div className="space-y-2.5">
              <p>The last sync copied every table and they are in place. These views, triggers or routines from the source are missing here:</p>
              <CodeFailureList failures={lastFailures} />
              {lastSync.warnings.length > 0 && (
                <ul className="list-disc space-y-1 pl-5 text-label">
                  {lastSync.warnings.map((warning, i) => (
                    <li key={i} className="break-words">
                      {warning}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </Alert>
        )}
        {!showPanel && current.lastStatus === "error" && current.lastError && (
          <Alert variant="danger" title="The last sync failed">
            <span className="break-words">{current.lastError}</span> The mirror kept its previous data.
          </Alert>
        )}
        {isJobConflict(run.error) && <JobConflictNotice error={run.error} onCleared={() => run.reset()} />}
        {run.isError && !isJobConflict(run.error) && (
          <Alert variant="danger" title="Could not start the sync">
            {errorMessage(run.error)}
          </Alert>
        )}
        <ScheduleNote db={db} current={current} policy={policy} />
      </CardContent>
      {sync.dialog}
    </Card>
  );
}

function ScheduleNote({ db, current, policy }: { db: Database; current: SyncJob; policy: CheckpointPolicy | undefined }) {
  const next = useCheckpointList(db.id).data?.schedule?.nextDueAt ?? null;
  return (
    <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2 rounded-md border border-border bg-bg-inset px-3 py-2.5" data-sync-schedule>
      <div className="flex min-w-0 items-start gap-2 text-label text-text-muted">
        <CalendarClock aria-hidden className="mt-0.5 size-3.5 shrink-0 text-text-subtle" />
        <div className="min-w-0 space-y-0.5">
          <p>
            <span className="text-text">{current.enabled ? syncIntervalLabel(current.intervalSeconds) : "Paused"}</span>
            {policy && <> · checkpoints: {compactSummary(policy, true).toLowerCase()}</>}
            {next && <> · next checkpoint due after {formatDue(next)}</>}
          </p>
          {policy && <p className="text-text-subtle">{settingsSummary({ kind: "mirror", policy, sync: current }).slice(1).join(" ")}</p>}
        </div>
      </div>
      <SettingsLink db={db} />
    </div>
  );
}

function SettingsLink({ db }: { db: Database }) {
  return (
    <Link
      to={databasePath(db.id, "settings")}
      className="inline-flex shrink-0 items-center gap-1.5 text-label text-text underline decoration-border-control underline-offset-4 hover:decoration-accent"
    >
      <SlidersHorizontal aria-hidden className="size-3.5" />
      Change in Settings
    </Link>
  );
}

function everyLabel(seconds: number): string {
  if (seconds % 3600 === 0) return seconds === 3600 ? "hour" : `${seconds / 3600} hours`;
  if (seconds % 60 === 0) return seconds === 60 ? "minute" : `${seconds / 60} minutes`;
  return `${seconds} seconds`;
}

export function syncSummary(job: Job, byId: Map<string, { shortHash: string }>, intervalHours: number | null = null) {
  if (job.status !== "succeeded" || !job.result) return null;
  const r = job.result as unknown as SyncJobResult;
  const cp = r.checkpointId ? byId.get(r.checkpointId) : null;
  const line = syncCheckpointLine(r, cp?.shortHash ?? null, intervalHours);
  const copied = jobState(job) === "done-with-errors" ? `${pluralize(r.tables, "table")} copied and in place` : `${pluralize(r.tables, "table")} copied`;
  const changes = readSyncChanges(r.changes);
  const changed = changes ? "" : r.unchanged ? "; no data changed" : "";
  return (
    <>
      <span className="block">
        {copied}
        {changed}.
        {jobState(job) === "done-with-errors" ? " Some objects from the source could not be created in the mirror; they are listed below." : ""}
      </span>
      {changes && <SyncChanges changes={changes} className="my-2" />}
      {line && (
        <span className={line.tone === "warn" ? "block text-warn" : line.tone === "success" ? "block text-text" : "block"} data-sync-checkpoint={r.checkpointKind ?? r.checkpointSkipped ?? "none"}>
          {line.text.endsWith(".") ? line.text : `${line.text}.`}
        </span>
      )}
    </>
  );
}

function SyncForm({ db, current }: { db: Database; current: SyncJob | null }) {
  const qc = useQueryClient();
  const toast = useToast();
  const t = useTerminology();
  const canWrite = useCanWriteDatabase(db);

  const [sourceKind, setSourceKind] = useState<SyncSourceKind>(current?.sourceKind ?? "mysql");
  const [sourceHost, setSourceHost] = useState(current?.sourceHost ?? "");
  const [sourcePort, setSourcePort] = useState(String(current?.sourcePort ?? 3306));
  const [sourceUser, setSourceUser] = useState(current?.sourceUser ?? "");
  const [sourcePassword, setSourcePassword] = useState("");
  const [sourceDatabase, setSourceDatabase] = useState(current?.sourceDatabase ?? "");

  const save = useMutation({
    mutationFn: () =>
      api.put(`/databases/${db.id}/sync`, {
        sourceKind,
        sourceHost: sourceHost.trim(),
        sourcePort: Number(sourcePort) || 3306,
        sourceUser: sourceUser.trim(),
        sourcePassword: sourcePassword || undefined,
        sourceDatabase: sourceDatabase.trim(),
        intervalSeconds: current?.intervalSeconds ?? 3600,
        enabled: current?.enabled ?? true,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.sync(db.id) });
      toast.show("Sync saved", "success");
    },
    onError: (e) => toast.show(errorMessage(e, "Save failed"), "error"),
  });

  const missing = !sourceHost.trim() || !sourceUser.trim() || !sourceDatabase.trim() || (!current && !sourcePassword);

  return (
    <Card flush>
      <CardHeader divided title={t("mirrorSource")} description="Where this mirror copies its data from." />
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (!missing && canWrite) save.mutate();
        }}
      >
        <CardContent>
          <fieldset disabled={!canWrite} className="min-w-0">
            <FieldGroup>
              <Field label="Source kind">
                <SelectMenu
                  value={sourceKind}
                  onValueChange={(value) => setSourceKind(value as SyncSourceKind)}
                  disabled={!canWrite}
                  options={[
                    { value: "mysql", label: "MySQL / MariaDB" },
                    { value: "postgres", label: "PostgreSQL" },
                  ]}
                />
              </Field>
              <Field label="Source host" required>
                <Input mono value={sourceHost} onChange={(e) => setSourceHost(e.target.value)} placeholder="db.example.com" autoComplete="off" spellCheck={false} />
              </Field>
              <Field label="Source port" required>
                <Input mono type="number" inputMode="numeric" value={sourcePort} onChange={(e) => setSourcePort(e.target.value)} />
              </Field>
              <Field label="Source user" required>
                <Input mono value={sourceUser} onChange={(e) => setSourceUser(e.target.value)} autoComplete="off" spellCheck={false} />
              </Field>
              <Field label="Source password" hint={current ? "Leave blank to keep the current password" : undefined} required={!current}>
                <Input type="password" value={sourcePassword} onChange={(e) => setSourcePassword(e.target.value)} autoComplete="new-password" />
              </Field>
              <Field label="Source database" required>
                <Input mono value={sourceDatabase} onChange={(e) => setSourceDatabase(e.target.value)} autoComplete="off" spellCheck={false} />
              </Field>
            </FieldGroup>
            <p className="mt-5 text-label text-text-muted">
              {current
                ? "How often it syncs, and the checkpoints it records, are set in Settings."
                : "Once saved, it syncs every hour. Change how often, and the checkpoints it records, in Settings."}
            </p>
          </fieldset>
        </CardContent>
        {canWrite && (
          <CardFooter>
            <Button type="submit" size="sm" loading={save.isPending} disabled={missing}>
              Save
            </Button>
          </CardFooter>
        )}
      </form>
    </Card>
  );
}
