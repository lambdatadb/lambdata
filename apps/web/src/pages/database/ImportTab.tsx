import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ArrowRight, Database as DatabaseIcon, FileCode2, FileUp, History, RotateCcw } from "lucide-react";
import type { Database, ImportRecord, Job } from "@lambdata/shared";
import { replaceDatabaseFromUpload, useImportHistory } from "../../components/import/api";
import { shortHash } from "../../components/import/format";
import { importOutcome, importSuccessText, isImportJob } from "../../components/import/result";
import { PlanReview } from "../../components/import/PlanReview";
import { FileStrip, SourceStep } from "../../components/import/SourceStep";
import { useImportSource, type ImportSource } from "../../components/import/useImportSource";
import { JobConflictNotice } from "../../components/jobs/JobConflictNotice";
import { JobProgress } from "../../components/jobs/JobProgress";
import { QueryError } from "../../components/layout/QueryError";
import { Alert } from "../../components/ui/Alert";
import { Badge } from "../../components/ui/Badge";
import { Button } from "../../components/ui/Button";
import { Card, CardContent, CardHeader } from "../../components/ui/Card";
import { ConfirmDialog } from "../../components/ui/ConfirmDialog";
import { EmptyState } from "../../components/ui/EmptyState";
import { SkeletonRows } from "../../components/ui/Skeleton";
import { errorMessage } from "../../lib/api";
import { useCanWriteDatabase } from "../../lib/auth";
import { databasePath } from "../../lib/commands";
import { formatBytes, formatDate, formatRelativeTime, pluralize } from "../../lib/format";
import { isJobConflict, useActiveJobs, useJob, useTrackJob } from "../../lib/jobs";
import type { DatabaseTabProps } from "./types";

export function ImportTab({ db }: DatabaseTabProps) {
  const canReplace = useCanWriteDatabase(db);
  return (
    <div className="space-y-4">
      {db.kind === "mirror" && canReplace && (
        <Alert variant="warning" title="This database is a mirror">
          The next sync from its source replaces whatever you import here. Pause the schedule on the{" "}
          <Link to={databasePath(db.id, "sync")} className="text-text underline underline-offset-4">
            Sync tab
          </Link>{" "}
          first if the imported data should stay.
        </Alert>
      )}
      {canReplace ? (
        <ReplaceCard db={db} />
      ) : (
        <Alert variant="neutral" title="Only the owner can replace this data">
          {db.ownerDisplayName ? `${db.ownerDisplayName} owns ${db.displayName}.` : `${db.displayName} belongs to another user.`} Ask them or
          an administrator to import a file into it.
        </Alert>
      )}
      <HistoryCard db={db} />
    </div>
  );
}

const REVEAL_RUNNING_MS = 700;

function ReplaceCard({ db }: { db: Database }) {
  const qc = useQueryClient();
  const trackJob = useTrackJob();
  const source = useImportSource();
  const { state } = source;
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [jobId, setJobId] = useState<string | null>(null);
  const [jobFile, setJobFile] = useState<string | null>(null);
  const [startedHere, setStartedHere] = useState(false);
  const [revealRunning, setRevealRunning] = useState(false);
  const active = useActiveJobs(db.id);
  const runningImport = active.jobs.find(isImportJob);

  useEffect(() => {
    setRevealRunning(false);
    if (!jobId) return;
    if (!startedHere) {
      setRevealRunning(true);
      return;
    }
    const timer = setTimeout(() => setRevealRunning(true), REVEAL_RUNNING_MS);
    return () => clearTimeout(timer);
  }, [jobId, startedHere]);

  const { job, isFinished } = useJob(jobId, {
    onDone: () => {
      void qc.invalidateQueries({ predicate: (q) => q.queryKey.includes(db.id) });
    },
  });

  const replace = useMutation({
    mutationFn: (uploadId: string) => replaceDatabaseFromUpload(db.id, uploadId),
    onSuccess: ({ job: started }) => {
      source.consume();
      trackJob(started);
      setJobFile(state.phase === "ready" ? state.upload.fileName : null);
      setStartedHere(true);
      setJobId(started.id);
      setConfirmOpen(false);
    },
    onError: () => setConfirmOpen(false),
  });

  const resetReplace = replace.reset;
  const dismissed = useRef(new Set<string>());

  useEffect(() => {
    if (!jobId && runningImport && !dismissed.current.has(runningImport.id)) {
      setStartedHere(false);
      setJobId(runningImport.id);
      resetReplace();
    }
  }, [jobId, runningImport, resetReplace]);

  const clearJob = (discard: boolean) => {
    if (jobId) dismissed.current.add(jobId);
    setJobId(null);
    setJobFile(null);
    setStartedHere(false);
    replace.reset();
    source.consume(false);
    if (discard) source.reset();
  };

  const showJob = !!jobId && (revealRunning || isFinished || state.phase !== "ready");
  const starting = replace.isPending || (!!jobId && !showJob);
  const conflict = isJobConflict(replace.error);

  return (
    <Card flush>
      <CardHeader
        divided
        title="Replace data from file"
        description={
          <>
            Load a SQLite database or a SQL dump into <span className="text-text">{db.displayName}</span> in place of everything it
            holds now. Before anything changes, a safety checkpoint of the current data is taken, so you can undo it from History.
          </>
        }
      />
      <CardContent className="space-y-4">
        {replace.isError &&
          (conflict ? (
            <JobConflictNotice error={replace.error} onCleared={() => replace.reset()} />
          ) : (
            <Alert variant="danger" title="The import did not start">
              {errorMessage(replace.error)}
            </Alert>
          ))}

        {showJob ? (
          <JobPanel
            db={db}
            job={job}
            fileName={jobFile}
            canRetry={state.phase === "ready"}
            pendingFile={!startedHere && state.phase === "ready" ? state.upload.fileName : null}
            onRetry={() => clearJob(false)}
            onAnother={() => clearJob(true)}
          />
        ) : state.phase === "ready" ? (
          <>
            <FileStrip
              file={state.file}
              upload={state.upload}
              plan={state.plan}
              action={
                <>
                  <Button size="sm" variant="ghost" onClick={source.reset} disabled={starting}>
                    Choose another file
                  </Button>
                  <Button size="sm" variant="danger" onClick={() => setConfirmOpen(true)} loading={starting}>
                    {starting ? "Starting…" : "Replace data…"}
                  </Button>
                </>
              }
            />
            <PlanReview
              plan={state.plan}
              mode="replace"
              targetLabel={<span className="font-mono text-code text-text">{db.name}</span>}
            />
          </>
        ) : (
          <SourceStep source={source} />
        )}
      </CardContent>
      {state.phase === "ready" && !jobId && (
        <ConfirmReplace
          db={db}
          source={source}
          open={confirmOpen}
          loading={replace.isPending}
          onClose={() => setConfirmOpen(false)}
          onConfirm={() => state.phase === "ready" && replace.mutate(state.upload.id)}
        />
      )}
    </Card>
  );
}

function ConfirmReplace({
  db,
  source,
  open,
  loading,
  onClose,
  onConfirm,
}: {
  db: Database;
  source: ImportSource;
  open: boolean;
  loading: boolean;
  onClose: () => void;
  onConfirm: () => void;
}) {
  const { state } = source;
  if (state.phase !== "ready") return null;
  const plan = state.plan;
  const contents =
    plan.format === "sqlite"
      ? `${pluralize(plan.totals.tables, "table")} and ${pluralize(plan.totals.rows, "row")}`
      : "whatever the dump defines";
  return (
    <ConfirmDialog
      open={open}
      onClose={onClose}
      onConfirm={onConfirm}
      title={`Replace the data in ${db.displayName}?`}
      description={
        <>
          Everything now in <span className="font-mono text-code text-text">{db.name}</span>, its tables, views and triggers, is replaced
          by <span className="font-mono text-code text-text">{state.upload.fileName}</span> ({contents}).
        </>
      }
      confirmLabel="Replace data"
      tone="danger"
      size="md"
      loading={loading}
      challenge={db.name}
    >
      <ul className="space-y-2 text-body text-text-muted">
        <li className="flex gap-2.5">
          <DatabaseIcon aria-hidden className="mt-0.5 size-4 shrink-0 text-text-subtle" />
          <span>
            The new data is built in a staging copy first. If anything fails before the swap,{" "}
            <span className="font-mono text-code text-text">{db.name}</span> stays exactly as it is.
          </span>
        </li>
        <li className="flex gap-2.5">
          <History aria-hidden className="mt-0.5 size-4 shrink-0 text-text-subtle" />
          <span>
            Just before the swap, a safety checkpoint of the current data is taken, so you can undo this from History. If that checkpoint
            can&apos;t be taken, nothing changes.
          </span>
        </li>
      </ul>
    </ConfirmDialog>
  );
}

function JobPanel({
  db,
  job,
  fileName,
  canRetry,
  pendingFile,
  onRetry,
  onAnother,
}: {
  db: Database;
  job: Job | undefined;
  fileName: string | null;
  canRetry: boolean;
  pendingFile: string | null;
  onRetry: () => void;
  onAnother: () => void;
}) {
  const result = importOutcome(job);
  const succeeded = job?.status === "succeeded";
  const failed = job?.status === "failed";
  return (
    <div className="space-y-3">
      <JobProgress
        job={job}
        title={fileName ? `Replacing the data from ${fileName}` : undefined}
        successMessage={importSuccessText(result, "replace")}
      />
      {succeeded && (
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" variant="secondary" asChild>
            <Link to={databasePath(db.id, "tables")}>
              Browse tables <ArrowRight />
            </Link>
          </Button>
          {result?.safetyCheckpointId && (
            <Button size="sm" variant="ghost" asChild>
              <Link to={databasePath(db.id, "history", result.safetyCheckpointId)}>
                <History /> Checkpoint before the import
              </Link>
            </Button>
          )}
          {result?.checkpointId && result.checkpointId !== result.safetyCheckpointId && (
            <Button size="sm" variant="ghost" asChild>
              <Link to={databasePath(db.id, "history", result.checkpointId)}>
                <History /> Import checkpoint
              </Link>
            </Button>
          )}
          {pendingFile ? (
            <Button size="sm" variant="ghost" onClick={onRetry} className="sm:ml-auto">
              <RotateCcw /> Back to {pendingFile}
            </Button>
          ) : (
            <Button size="sm" variant="ghost" onClick={onAnother} className="sm:ml-auto">
              <FileUp /> Import another file
            </Button>
          )}
        </div>
      )}
      {failed && (
        <div className="flex flex-wrap items-center gap-2">
          {canRetry && (
            <Button size="sm" variant="secondary" onClick={onRetry}>
              <RotateCcw /> Back to the plan
            </Button>
          )}
          <Button size="sm" variant="ghost" onClick={onAnother}>
            <FileUp /> Choose another file
          </Button>
        </div>
      )}
    </div>
  );
}

function HistoryCard({ db }: { db: Database }) {
  const history = useImportHistory(db.id);
  const records = [...(history.data ?? [])].sort((a, b) => b.importedAt - a.importedAt);
  return (
    <Card flush>
      <CardHeader divided title="Import history" description={`Files loaded into ${db.displayName}, newest first.`} />
      {history.isPending ? (
        <CardContent>
          <SkeletonRows rows={3} label="Loading import history" />
        </CardContent>
      ) : history.isError ? (
        <CardContent>
          <QueryError
            error={history.error}
            title="Could not load the import history"
            onRetry={() => history.refetch()}
            retrying={history.isFetching}
          />
        </CardContent>
      ) : records.length === 0 ? (
        <EmptyState
          variant="bare"
          size="sm"
          icon={FileUp}
          title="No imports yet"
          description="SQLite files and SQL dumps loaded into this database are listed here."
        />
      ) : (
        <ul className="divide-y divide-border">
          {records.map((record) => (
            <HistoryRow key={record.id} record={record} />
          ))}
        </ul>
      )}
    </Card>
  );
}

function HistoryRow({ record }: { record: ImportRecord }) {
  const Icon = record.format === "sql" ? FileCode2 : DatabaseIcon;
  const contents: string[] = [];
  if (record.tableCount !== null) contents.push(pluralize(record.tableCount, "table"));
  if (record.rowCount !== null) contents.push(pluralize(record.rowCount, "row"));
  if (contents.length === 0) contents.push(record.format === "sql" ? "SQL dump" : "SQLite file");
  return (
    <li className="flex items-start gap-3 px-5 py-3.5">
      <span className="mt-0.5 grid size-8 shrink-0 place-items-center rounded-md border border-border bg-bg-raised text-text-muted">
        <Icon aria-hidden className="size-4" />
      </span>
      <div className="min-w-0 flex-1 space-y-0.5">
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          <span className="min-w-0 truncate font-mono text-code text-text" title={record.fileName}>
            {record.fileName}
          </span>
          <Badge size="sm" variant="muted">
            {record.mode === "create" ? "created the database" : "replaced the data"}
          </Badge>
        </div>
        <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-label text-text-muted">
          <span>{contents.join(" · ")}</span>
          {record.warningCount > 0 && (
            <span className="inline-flex items-center gap-1.5">
              <span aria-hidden className="size-1.5 rounded-full bg-warn" />
              {pluralize(record.warningCount, "warning")}
            </span>
          )}
          <span className="text-text-subtle">{formatBytes(record.sizeBytes)}</span>
          <span className="hidden font-mono text-micro text-text-subtle sm:inline" title={`sha256 ${record.sha256}`}>
            {shortHash(record.sha256)}
          </span>
        </div>
      </div>
      <div className="shrink-0 text-right text-label">
        <time dateTime={new Date(record.importedAt).toISOString()} title={formatDate(record.importedAt)} className="text-text-muted">
          {formatRelativeTime(record.importedAt)}
        </time>
        {record.importedByDisplayName && <div className="max-w-[10rem] truncate text-micro text-text-subtle">{record.importedByDisplayName}</div>}
      </div>
    </li>
  );
}

