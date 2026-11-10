import { useEffect, useId, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ArrowRight, RotateCcw } from "lucide-react";
import { ApiError, errorMessage } from "../../lib/api";
import { formatNumber, pluralize } from "../../lib/format";
import { isJobConflict, useTrackJob } from "../../lib/jobs";
import { queryKeys } from "../../lib/queries";
import { formatConnectionAddress, useDatabaseHost } from "../../lib/useConnectionInfo";
import { useCredentialsReveal } from "../databases/CredentialsReveal";
import {
  AccessOptions,
  BuildManifest,
  deriveSchema,
  hostError,
  type CreateDatabaseTypeBodyProps,
} from "../databases/CreateDatabaseDialog";
import { JobConflictNotice } from "../jobs/JobConflictNotice";
import { Alert } from "../ui/Alert";
import { Button } from "../ui/Button";
import { DialogBody, DialogFooter } from "../ui/Dialog";
import { Field } from "../ui/Field";
import { Input } from "../ui/Input";
import { Switch } from "../ui/Switch";
import { createDatabaseFromUpload } from "./api";
import { displayNameFromFile, sentence } from "./format";
import { PlanReview } from "./PlanReview";
import { FileFacts, SourceStep } from "./SourceStep";
import { useImportSource, type ImportSourceState } from "./useImportSource";

function manifestRows(state: ImportSourceState): { label: string; value: ReactNode }[] {
  const dim = <span className="text-text-subtle">—</span>;
  if (state.phase === "idle") {
    return [{ label: "source", value: <span className="text-text-subtle">waiting for a file</span> }];
  }
  const source = { label: "source", value: <span className="text-text">{state.file.name}</span> };
  if (state.phase === "uploading") {
    const percent = state.total > 0 ? Math.floor((state.loaded / state.total) * 100) : 0;
    return [source, { label: "format", value: <span className="text-text-subtle">uploading · {percent}%</span> }];
  }
  if (state.phase === "analysing" || state.phase === "plan-failed") {
    return [
      source,
      { label: "format", value: <span className="text-text-muted">{state.upload.format === "sqlite" ? "sqlite 3" : "sql dump"}</span> },
      { label: "tables", value: state.phase === "analysing" ? <span className="text-text-subtle">analysing…</span> : dim },
    ];
  }
  const plan = state.plan;
  if (plan.format === "sql") {
    return [
      source,
      { label: "format", value: <span className="text-text-muted">sql dump{plan.compressed ? " · gzip" : ""}</span> },
      { label: "tables", value: <span className="text-text-muted">as the dump defines</span> },
    ];
  }
  return [
    source,
    { label: "format", value: <span className="text-text-muted">sqlite 3</span> },
    { label: "tables", value: <span className="text-text">{formatNumber(plan.totals.tables)}</span> },
    { label: "rows", value: <span className="text-text">{formatNumber(plan.totals.rows)}</span> },
  ];
}

function footerStatus(state: ImportSourceState, schema: string): ReactNode {
  if (state.phase === "idle") return "Choose a file to see what will be created.";
  if (state.phase === "uploading") return "Uploading…";
  if (state.phase === "analysing") return "Analysing the file…";
  if (state.phase === "plan-failed") return "The file could not be analysed.";
  const target = schema ? <span className="font-mono text-code text-text">{schema}</span> : "the new database";
  if (state.plan.format === "sql") return <>The dump loads into {target}.</>;
  return (
    <>
      {pluralize(state.plan.totals.tables, "table")} · {pluralize(state.plan.totals.rows, "row")} into {target}
    </>
  );
}

export function ImportCreateBody({ picker, onCancel, onFinished, onBusyChange }: CreateDatabaseTypeBodyProps) {
  const qc = useQueryClient();
  const reveal = useCredentialsReveal();
  const trackJob = useTrackJob();
  const source = useImportSource();
  const { state } = source;
  const [displayName, setDisplayName] = useState("");
  const [nameEdited, setNameEdited] = useState(false);
  const [connectionsFrom, setConnectionsFrom] = useState("%");
  const [tailnetOnly, setTailnetOnly] = useState(false);
  const conn = useDatabaseHost(tailnetOnly);
  const [versioned, setVersioned] = useState(true);
  const [touched, setTouched] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);
  const settingsId = useId();
  const settingsRef = useRef<HTMLElement>(null);
  const errorRef = useRef<HTMLDivElement>(null);
  const fileName = state.phase === "idle" ? null : state.file.name;

  useEffect(() => {
    if (!nameEdited) setDisplayName(fileName ? displayNameFromFile(fileName) : "");
  }, [fileName, nameEdited]);

  const schema = useMemo(() => (displayName.trim() ? deriveSchema(displayName) : ""), [displayName]);
  const hostProblem = tailnetOnly ? null : hostError(connectionsFrom);
  const nameProblem = displayName.trim() ? null : "Give the database a name.";
  const effectiveHost = tailnetOnly ? "100.%" : connectionsFrom.trim() || "%";

  const create = useMutation({
    mutationFn: (uploadId: string) =>
      createDatabaseFromUpload(uploadId, {
        displayName: displayName.trim(),
        connectionsFrom: tailnetOnly ? undefined : connectionsFrom.trim(),
        tailnetOnly,
        versioned,
      }),
    onSuccess: (data) => {
      source.consume();
      void qc.invalidateQueries({ queryKey: queryKeys.databases });
      void qc.invalidateQueries({ queryKey: queryKeys.dashboardSummary });
      trackJob(data.job);
      reveal({
        credentials: data.credentials,
        databaseId: data.database.id,
        tailnetOnly,
        jobId: data.job.id,
        jobTitle: fileName ? `Importing ${fileName}` : undefined,
        title: `${data.database.displayName} is ready`,
        description: `Save the password; it is shown once. The import of ${fileName ?? "your file"} is tracked below.`,
      });
      onFinished();
    },
    onError: () => {
      requestAnimationFrame(() => errorRef.current?.scrollIntoView({ block: "nearest", behavior: "smooth" }));
    },
  });

  const busy = source.busy || create.isPending;

  useEffect(() => {
    onBusyChange(busy);
  }, [busy, onBusyChange]);

  useEffect(() => () => onBusyChange(false), [onBusyChange]);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (state.phase !== "ready" || create.isPending) return;
    setTouched(true);
    if (nameProblem) {
      nameRef.current?.focus();
      return;
    }
    if (hostProblem) {
      requestAnimationFrame(() => {
        const input = settingsRef.current?.querySelector<HTMLInputElement>("input[aria-invalid=true]");
        input?.scrollIntoView({ block: "center", behavior: "smooth" });
        input?.focus({ preventScroll: true });
      });
      return;
    }
    create.mutate(state.upload.id);
  };

  const chooseAnother = () => {
    create.reset();
    source.reset();
  };

  const uploadGone = create.error instanceof ApiError && (create.error.status === 404 || create.error.status === 410);
  const conflict = isJobConflict(create.error);
  const ready = state.phase === "ready";

  const manifest = (
    <BuildManifest
      kind="standard"
      schema={schema}
      host={formatConnectionAddress(conn.host, conn.port)}
      from={effectiveHost}
      tailnetOnly={tailnetOnly}
      versioned={versioned}
      extra={manifestRows(state)}
      className="md:col-span-2"
    />
  );

  return (
    <form onSubmit={submit} noValidate className="flex min-h-0 flex-1 flex-col" data-dialog-fill={ready ? "" : undefined}>
      <DialogBody className="space-y-5 pt-3">
        {!ready && (
          <div className="space-y-2">
            <div className="text-label font-medium text-text-muted">Type</div>
            {picker}
          </div>
        )}

        {create.isError && (
          <div ref={errorRef} className="scroll-mt-4">
            {conflict ? (
              <JobConflictNotice error={create.error} onCleared={() => create.reset()} />
            ) : (
              <Alert
                variant="danger"
                title={uploadGone ? "The uploaded file is no longer available" : "Could not create the database"}
                action={
                  uploadGone ? (
                    <Button size="xs" variant="secondary" onClick={chooseAnother}>
                      <RotateCcw /> Upload again
                    </Button>
                  ) : undefined
                }
              >
                {sentence(errorMessage(create.error))}
              </Alert>
            )}
          </div>
        )}

        {state.phase !== "ready" ? (
          <div className="grid grid-cols-1 gap-6 md:grid-cols-5">
            <div className="min-w-0 md:col-span-3">
              <SourceStep source={source} />
            </div>
            {manifest}
          </div>
        ) : (
          <>
            <div className="grid grid-cols-1 items-start gap-x-4 gap-y-4 rounded-lg border border-border bg-bg-inset p-4 md:grid-cols-[minmax(0,1fr)_1rem_minmax(0,1fr)]">
              <div className="min-w-0 space-y-2">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-label font-medium text-text-muted">Source file</span>
                  <Button size="xs" variant="ghost" onClick={chooseAnother} disabled={create.isPending} className="-my-1 -mr-2">
                    Choose another file
                  </Button>
                </div>
                <FileFacts file={state.file} upload={state.upload} plan={state.plan} showHash={false} />
              </div>
              <ArrowRight aria-hidden className="mt-9 hidden size-4 text-text-subtle md:block" />
              <Field
                label="Display name"
                required
                error={touched ? nameProblem : null}
                hint={
                  <>
                    Schema <span className="font-mono text-text-muted">{schema || "—"}</span>
                  </>
                }
              >
                <Input
                  ref={nameRef}
                  value={displayName}
                  onChange={(e) => {
                    setNameEdited(true);
                    setDisplayName(e.target.value);
                  }}
                  placeholder="Game server"
                  autoComplete="off"
                  maxLength={200}
                  disabled={create.isPending}
                />
              </Field>
            </div>

            <PlanReview plan={state.plan} mode="create" targetLabel="the new database" />

            <section ref={settingsRef} aria-labelledby={settingsId} className="space-y-4 border-t border-border pt-5">
              <h3 id={settingsId} className="text-heading font-semibold text-text">
                Access and options
              </h3>
              <div className="grid grid-cols-1 gap-6 md:grid-cols-5">
                <div className="min-w-0 space-y-5 md:col-span-3">
                  <AccessOptions
                    tailnetOnly={tailnetOnly}
                    onTailnetOnlyChange={setTailnetOnly}
                    connectionsFrom={connectionsFrom}
                    onConnectionsFromChange={setConnectionsFrom}
                    error={touched ? hostProblem : null}
                    disabled={create.isPending}
                  />
                  <div className="space-y-3">
                    <div className="text-label font-medium text-text-muted">Options</div>
                    <Switch
                      checked={versioned}
                      onChange={setVersioned}
                      disabled={create.isPending}
                      label="Version this database"
                      description="Track working-copy changes against checkpoints, like a repository. Daily checkpoints run either way."
                    />
                  </div>
                </div>
                {manifest}
              </div>
            </section>
          </>
        )}
      </DialogBody>
      <DialogFooter>
        <div className="hidden min-w-0 truncate text-label text-text-muted sm:mr-auto sm:block">{footerStatus(state, schema)}</div>
        <Button variant="ghost" onClick={onCancel} disabled={create.isPending}>
          Cancel
        </Button>
        <Button type="submit" loading={create.isPending} disabled={!ready}>
          {create.isPending ? "Creating…" : "Create database"}
          {!create.isPending && <ArrowRight />}
        </Button>
      </DialogFooter>
    </form>
  );
}
