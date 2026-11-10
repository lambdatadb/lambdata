import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from "react";
import { Link, useNavigate } from "react-router-dom";
import { ArrowRight, Check, ChevronRight, History, KeyRound } from "lucide-react";
import type { DatabaseCredentials, Job } from "@lambdata/shared";
import { Alert } from "../ui/Alert";
import { Button } from "../ui/Button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "../ui/Collapsible";
import { CopyButton, CopyableField } from "../ui/CopyableField";
import { Dialog } from "../ui/Dialog";
import { FieldGroup } from "../ui/Field";
import { useTerminology } from "../../lib/terminology";
import { databasePath } from "../../lib/commands";
import { isJobActive, useJob } from "../../lib/jobs";
import { useDatabase } from "../../lib/queries";
import { isTailnetOnly, useRevealedCredentials } from "../../lib/useConnectionInfo";
import { importOutcome, importSuccessText, isImportJob } from "../import/result";
import { JobProgress } from "../jobs/JobProgress";

export interface CredentialsRevealRequest {
  credentials: DatabaseCredentials;
  title?: string;
  description?: ReactNode;
  databaseId?: string;
  tailnetOnly?: boolean;
  jobId?: string;
  jobTitle?: string;
  offerOpen?: boolean;
}

type Reveal = (request: CredentialsRevealRequest) => void;

const Ctx = createContext<Reveal | null>(null);

export function useCredentialsReveal(): Reveal {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useCredentialsReveal must be inside CredentialsRevealProvider");
  return ctx;
}

export function CredentialsRevealProvider({ children }: { children: ReactNode }) {
  const [queue, setQueue] = useState<{ key: number; request: CredentialsRevealRequest }[]>([]);
  const counter = useRef(0);
  const reveal = useCallback<Reveal>((request) => setQueue((q) => [...q, { key: ++counter.current, request }]), []);
  const current = queue[0] ?? null;
  const dismiss = useCallback(() => setQueue((q) => q.slice(1)), []);
  return (
    <Ctx.Provider value={reveal}>
      {children}
      {current && <RevealDialog key={current.key} request={current.request} onDone={dismiss} />}
    </Ctx.Provider>
  );
}

function allCredentialsText(c: DatabaseCredentials): string {
  return [
    `host=${c.host}`,
    `port=${c.port}`,
    `schema=${c.schema}`,
    `user=${c.user}`,
    `password=${c.password}`,
    `uri=${c.uri}`,
    `jdbc=${c.jdbc}`,
    `cli=${c.mysqlCli}`,
  ].join("\n");
}

const DEFAULT_DESCRIPTION = "The password is shown once. Copy it somewhere safe before you close this.";

function RevealDialog({ request, onDone }: { request: CredentialsRevealRequest; onDone: () => void }) {
  const navigate = useNavigate();
  const { job } = useJob(request.jobId);
  const database = useDatabase(request.tailnetOnly === undefined ? request.databaseId : null);
  const tailnetOnly = request.tailnetOnly ?? (database.data ? isTailnetOnly(database.data.connectionsFrom) : false);
  const { credentials, tailnetMissing } = useRevealedCredentials(request.credentials, tailnetOnly);
  const bodyRef = useRef<HTMLDivElement>(null);
  const active = !!request.jobId && (!job || isJobActive(job));
  const offerOpen = (request.offerOpen ?? true) && !!request.databaseId;

  const openDatabase = () => {
    onDone();
    if (request.databaseId) navigate(databasePath(request.databaseId));
  };

  return (
    <Dialog
      open
      onClose={() => undefined}
      dismissible={false}
      size="xl"
      initialFocus={bodyRef}
      title={request.title ?? "Save these credentials"}
      description={request.description ?? DEFAULT_DESCRIPTION}
      footer={
        <>
          <CopyButton
            value={allCredentialsText(credentials)}
            label="all credentials"
            text="Copy all"
            copiedText="Copied all"
            variant="ghost"
            size="md"
            className="sm:mr-auto"
          />
          {offerOpen && (
            <Button variant="secondary" onClick={openDatabase} disabled={active}>
              Open database <ArrowRight />
            </Button>
          )}
          <Button onClick={onDone}>
            <Check /> I&apos;ve saved it
          </Button>
        </>
      }
    >
      <div ref={bodyRef} tabIndex={-1} className="space-y-5 outline-none">
        {request.jobId && (
          <RevealJob job={job} title={request.jobTitle} databaseId={request.databaseId} onNavigate={onDone} />
        )}
        <CredentialsFields credentials={credentials} />
        {tailnetMissing && (
          <Alert variant="warning" title="This database accepts tailnet connections only">
            The tailnet address of this server is not known yet. Connect to it over Tailscale, using the server&apos;s tailnet
            address as the host.
          </Alert>
        )}
      </div>
    </Dialog>
  );
}

function RevealJob({
  job,
  title,
  databaseId,
  onNavigate,
}: {
  job: Job | undefined;
  title?: string;
  databaseId?: string;
  onNavigate: () => void;
}) {
  const running = !job || isJobActive(job);
  const importJob = isImportJob(job);
  const outcome = importJob ? importOutcome(job) : null;
  const link = (to: string, label: ReactNode) => (
    <Button size="xs" variant="secondary" asChild>
      <Link to={to} onClick={onNavigate}>
        {label}
      </Link>
    </Button>
  );
  const actions =
    job?.status === "succeeded" && databaseId ? (
      <>
        {link(databasePath(databaseId, "tables"), <>Browse tables <ArrowRight /></>)}
        {outcome?.checkpointId && link(databasePath(databaseId, "history", outcome.checkpointId), <><History /> Import checkpoint</>)}
      </>
    ) : job?.status === "failed" && databaseId && importJob ? (
      link(databasePath(databaseId, "import"), <>Try another file <ArrowRight /></>)
    ) : undefined;
  return (
    <div className="space-y-2">
      <JobProgress
        job={job}
        variant={running ? "compact" : "full"}
        title={title}
        successMessage={importJob ? importSuccessText(outcome, "create") : undefined}
        actions={actions}
        className={running ? "rounded-lg border border-border bg-bg-inset p-3" : undefined}
      />
      {job?.status === "failed" && importJob && (
        <p className="text-label text-text-muted">
          The database was created but holds no data yet. Its credentials below still work.
        </p>
      )}
    </div>
  );
}

export function CredentialsFields({ credentials }: { credentials: DatabaseCredentials }) {
  const t = useTerminology();
  const [showStrings, setShowStrings] = useState(false);
  const fields = useMemo(
    () => [
      { label: t("mysqlCli"), value: credentials.mysqlCli, copy: "command" },
      { label: t("jdbc"), value: credentials.jdbc, copy: "JDBC URL" },
      { label: t("uri"), value: credentials.uri, copy: "connection URI" },
    ],
    [credentials, t],
  );
  return (
    <div className="space-y-4">
      <div className="space-y-2 rounded-lg border border-warn/30 bg-warn/[0.05] p-3">
        <CopyableField label="Password" value={credentials.password} secret />
        <p className="flex items-start gap-1.5 text-micro text-text-muted">
          <KeyRound aria-hidden className="mt-px size-3.5 shrink-0 text-warn" />
          It cannot be shown again. Rotating the password issues a new one and disconnects clients using the old one.
        </p>
      </div>
      <FieldGroup>
        <CopyableField label="Host" value={credentials.host} />
        <CopyableField label="Port" value={String(credentials.port)} />
        <CopyableField label="Schema" value={credentials.schema} />
        <CopyableField label="User" value={credentials.user} />
      </FieldGroup>
      <Collapsible open={showStrings} onOpenChange={setShowStrings}>
        <CollapsibleTrigger asChild>
          <Button variant="ghost" size="sm" className="group -ml-2">
            <ChevronRight className="transition-transform group-data-[state=open]:rotate-90" />
            Connection strings
            <span className="text-text-subtle">include the password</span>
          </Button>
        </CollapsibleTrigger>
        <CollapsibleContent className="space-y-4 pt-3">
          {fields.map((field) => (
            <CopyableField key={field.copy} label={field.label} value={field.value} copyLabel={field.copy} />
          ))}
        </CollapsibleContent>
      </Collapsible>
    </div>
  );
}
