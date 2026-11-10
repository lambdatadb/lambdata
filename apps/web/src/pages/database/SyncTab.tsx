import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { GitBranch, Play } from "lucide-react";
import type { Database, Job, JobResponse, SyncJob, SyncJobResult, SyncSourceKind } from "@lambdata/shared";
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
import { Switch } from "../../components/ui/Switch";
import { useToast } from "../../components/ui/Toast";
import { invalidateHistory, useCheckpointList, useDatabaseJobs } from "../../components/checkpoints/queries";
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
        toast.success("Sync finished", {
          description: r ? (r.unchanged ? "No data changed." : `${pluralize(r.tables, "table")} copied.`) : undefined,
        });
      }
    },
  });

  const run = useMutation({
    mutationFn: () => api.post<JobResponse>(`/databases/${db.id}/sync/run`),
    onSuccess: (res) => {
      track(res.job);
      setJobId(res.job.id);
    },
  });

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
  const lastWithErrors = !!lastSync && jobState(lastSync) === "done-with-errors" && current.lastStatus === "ok";
  const lastFailures = lastWithErrors && lastSync ? jobCodeFailures(lastSync) : [];
  const byId = new Map((history.data?.checkpoints ?? []).map((cp) => [cp.id, cp]));
  const recorded = lastResult?.checkpointId ? byId.get(lastResult.checkpointId) : null;
  const preSync = lastResult?.preSyncCheckpointId ? byId.get(lastResult.preSyncCheckpointId) : null;
  const policy = history.data?.policy;
  const recordsHistory = db.versioned && (policy?.checkpointOnSync ?? true);
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
              onClick={() => run.mutate()}
              loading={run.isPending || (started.isActive && !showPanel)}
              disabled={busy}
            >
              <Play />
              Run now
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
            successMessage={syncSummary(live, byId)}
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
                    {lastResult.unchanged || !lastResult.checkpointId ? (
                      "no data changed"
                    ) : recorded ? (
                      <>
                        recorded{" "}
                        <Link
                          to={databasePath(db.id, "history", encodeURIComponent(recorded.id))}
                          className="font-mono text-code text-text underline decoration-border-control underline-offset-4 hover:decoration-accent"
                        >
                          {recorded.shortHash}
                        </Link>
                      </>
                    ) : (
                      "data changed"
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
        <p className="flex items-start gap-2 text-label text-text-muted">
          <GitBranch aria-hidden className="mt-0.5 size-3.5 shrink-0 text-text-subtle" />
          <span>
            {recordsHistory ? (
              <>
                This mirror is versioned: each sync that changes data is recorded in <HistoryLink db={db} /> as a checkpoint, and
                local edits are saved first so a sync never silently overwrites them.
              </>
            ) : db.versioned ? (
              <>
                Checkpoints after sync are turned off in the <HistoryLink db={db} /> policy, so syncs are not recorded.
              </>
            ) : (
              <>
                Turn on versioning in <HistoryLink db={db} /> to record each sync that changes data as a checkpoint you can roll
                back to.
              </>
            )}
          </span>
        </p>
      </CardContent>
    </Card>
  );
}

function HistoryLink({ db }: { db: Database }) {
  return (
    <Link to={databasePath(db.id, "history")} className="text-text underline decoration-border-control underline-offset-4 hover:decoration-accent">
      History
    </Link>
  );
}

function everyLabel(seconds: number): string {
  if (seconds % 3600 === 0) return seconds === 3600 ? "hour" : `${seconds / 3600} hours`;
  if (seconds % 60 === 0) return seconds === 60 ? "minute" : `${seconds / 60} minutes`;
  return `${seconds} seconds`;
}

function syncSummary(job: Job, byId: Map<string, { shortHash: string }>) {
  if (job.status !== "succeeded" || !job.result) return null;
  const r = job.result as unknown as SyncJobResult;
  if (jobState(job) === "done-with-errors") {
    const cp = r.checkpointId ? byId.get(r.checkpointId) : null;
    return (
      <>
        {pluralize(r.tables, "table")} copied and in place
        {cp ? (
          <>
            , recorded as <span className="font-mono text-code text-text">{cp.shortHash}</span>
          </>
        ) : null}
        . Some objects from the source could not be created in the mirror; they are listed below.
      </>
    );
  }
  if (r.unchanged || !r.checkpointId) return `${pluralize(r.tables, "table")} copied; no data changed.`;
  const cp = byId.get(r.checkpointId);
  return (
    <>
      {pluralize(r.tables, "table")} copied and recorded as{" "}
      {cp ? <span className="font-mono text-code text-text">{cp.shortHash}</span> : "a checkpoint"}.
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
  const [intervalSeconds, setIntervalSeconds] = useState(String(current?.intervalSeconds ?? 3600));
  const [enabled, setEnabled] = useState(current?.enabled ?? true);

  const save = useMutation({
    mutationFn: () =>
      api.put(`/databases/${db.id}/sync`, {
        sourceKind,
        sourceHost: sourceHost.trim(),
        sourcePort: Number(sourcePort) || 3306,
        sourceUser: sourceUser.trim(),
        sourcePassword: sourcePassword || undefined,
        sourceDatabase: sourceDatabase.trim(),
        intervalSeconds: Math.max(60, Number(intervalSeconds) || 3600),
        enabled,
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
              <Field label={t("intervalSeconds")} hint="At least 60 seconds">
                <Input mono type="number" inputMode="numeric" value={intervalSeconds} min={60} onChange={(e) => setIntervalSeconds(e.target.value)} />
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
            <Switch
              className="mt-5"
              checked={enabled}
              onCheckedChange={setEnabled}
              label="Sync on a schedule"
              description={
                enabled
                  ? "On. The mirror is refreshed at the interval above; Run now works either way."
                  : "Paused. The mirror keeps its current data until you run a sync by hand or turn this back on."
              }
            />
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
