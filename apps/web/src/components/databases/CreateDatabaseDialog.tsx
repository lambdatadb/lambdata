import { useEffect, useMemo, useRef, useState, type ComponentType, type ReactNode } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ArrowLeftRight, ArrowRight, Database as DatabaseIcon, FileUp } from "lucide-react";
import type { Database, DatabaseCredentials, DatabaseKind } from "@lambdata/shared";
import { api, errorMessage } from "../../lib/api";
import { formatConnectionAddress, useDatabaseHost } from "../../lib/useConnectionInfo";
import type { DatabaseReach } from "../../lib/connections";
import { useIsAdmin } from "../../lib/auth";
import { queryKeys } from "../../lib/queries";
import { useTermNode } from "../../lib/terminology";
import { Alert } from "../ui/Alert";
import { Button } from "../ui/Button";
import {
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogRoot,
  DialogTitle,
} from "../ui/Dialog";
import { Field } from "../ui/Field";
import { Input } from "../ui/Input";
import { RadioCard, RadioGroup } from "../ui/RadioGroup";
import { Switch } from "../ui/Switch";
import { cn } from "../ui/cn";
import { ImportCreateBody } from "../import/ImportCreateBody";
import { useCredentialsReveal } from "./CredentialsReveal";
import { ReachNotice } from "./ReachNotice";

export interface CreateDatabaseTypeBodyProps {
  type: string;
  picker: ReactNode;
  onCancel: () => void;
  onFinished: () => void;
  onBusyChange: (busy: boolean) => void;
}

export interface DatabaseTypeOption {
  value: string;
  title: string;
  description: string;
  icon: ReactNode;
  badge?: ReactNode;
  disabled?: boolean;
  Body: ComponentType<CreateDatabaseTypeBodyProps>;
}

export const DATABASE_TYPES: DatabaseTypeOption[] = [
  {
    value: "standard",
    title: "Standard",
    description: "A fresh, empty schema",
    icon: <DatabaseIcon />,
    Body: ProvisionBody,
  },
  {
    value: "mirror",
    title: "Mirror",
    description: "Syncs from an external source",
    icon: <ArrowLeftRight />,
    Body: ProvisionBody,
  },
  {
    value: "import",
    title: "Import",
    description: "From a SQLite or SQL dump file",
    icon: <FileUp />,
    Body: ImportCreateBody,
  },
];

const PICKER_COLUMNS: Record<number, string> = {
  1: "sm:grid-cols-1",
  2: "sm:grid-cols-2",
  3: "sm:grid-cols-3",
  4: "sm:grid-cols-2 lg:grid-cols-4",
};

function resolveType(value: string | null | undefined): string {
  const match = DATABASE_TYPES.find((t) => t.value === value && !t.disabled);
  return match?.value ?? DATABASE_TYPES[0]!.value;
}

interface Props {
  open: boolean;
  onClose: () => void;
  initialType?: string | null;
}

export function CreateDatabaseDialog({ open, onClose, initialType }: Props) {
  const [type, setType] = useState(() => resolveType(initialType));
  const [busy, setBusy] = useState(false);
  const contentRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    setType(resolveType(initialType));
    setBusy(false);
  }, [open, initialType]);

  const option = DATABASE_TYPES.find((t) => t.value === type) ?? DATABASE_TYPES[0]!;
  const Body = option.Body;

  const picker = (
    <RadioGroup
      value={type}
      onValueChange={setType}
      disabled={busy}
      aria-label="Database type"
      className={cn("grid-cols-1", PICKER_COLUMNS[DATABASE_TYPES.length] ?? "sm:grid-cols-3")}
    >
      {DATABASE_TYPES.map((t) => (
        <RadioCard
          key={t.value}
          value={t.value}
          icon={t.icon}
          title={t.title}
          description={t.description}
          badge={t.badge}
          disabled={t.disabled}
          layout="inline"
        />
      ))}
    </RadioGroup>
  );

  return (
    <DialogRoot
      open={open}
      onOpenChange={(next) => {
        if (!next && !busy) onClose();
      }}
    >
      <DialogContent
        ref={contentRef}
        size="4xl"
        dismissible={!busy}
        className="has-[[data-dialog-fill]]:h-[calc(100dvh-2rem)]"
        onOpenAutoFocus={(event) => {
          const target = contentRef.current?.querySelector<HTMLElement>("[data-autofocus]");
          if (!target) return;
          event.preventDefault();
          target.focus();
        }}
      >
        <DialogHeader>
          <DialogTitle>Create a database</DialogTitle>
          <DialogDescription>A schema, a dedicated MariaDB user and ready-made connection strings.</DialogDescription>
        </DialogHeader>
        <Body
          type={type}
          picker={picker}
          onCancel={onClose}
          onFinished={onClose}
          onBusyChange={setBusy}
        />
      </DialogContent>
    </DialogRoot>
  );
}

export function deriveSchema(displayName: string): string {
  const slug = displayName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 48);
  return slug || "db";
}

const HOST_PATTERN = /^[A-Za-z0-9.%_:\-/]+$/;

export function hostError(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return "Enter a host pattern. Use % to allow any host.";
  if (!HOST_PATTERN.test(trimmed)) return "Use letters, digits, dots, colons, % and _ only, for example 192.168.1.%";
  return null;
}

function ProvisionBody({ type, picker, onCancel, onFinished, onBusyChange }: CreateDatabaseTypeBodyProps) {
  const qc = useQueryClient();
  const reveal = useCredentialsReveal();
  const [displayName, setDisplayName] = useState("");
  const [connectionsFrom, setConnectionsFrom] = useState("%");
  const [tailnetOnly, setTailnetOnly] = useState(false);
  const conn = useDatabaseHost(tailnetOnly);
  const isAdmin = useIsAdmin();
  const [versioned, setVersioned] = useState(false);
  const [showInVitals, setShowInVitals] = useState(true);
  const [touched, setTouched] = useState(false);
  const kind: DatabaseKind = type === "mirror" ? "mirror" : "standard";

  const schema = useMemo(() => (displayName.trim() ? deriveSchema(displayName) : ""), [displayName]);
  const hostProblem = tailnetOnly ? null : hostError(connectionsFrom);
  const nameProblem = displayName.trim() ? null : "Give the database a name.";
  const effectiveHost = tailnetOnly ? "100.%" : connectionsFrom.trim() || "%";

  const mutation = useMutation({
    mutationFn: () =>
      api.post<{ database: Database; credentials: DatabaseCredentials }>("/databases", {
        displayName: displayName.trim(),
        kind,
        connectionsFrom: tailnetOnly ? undefined : connectionsFrom.trim(),
        tailnetOnly,
        versioned,
        showInVitals,
      }),
    onMutate: () => onBusyChange(true),
    onSettled: () => onBusyChange(false),
    onSuccess: (data) => {
      void qc.invalidateQueries({ queryKey: queryKeys.databases });
      void qc.invalidateQueries({ queryKey: queryKeys.dashboardSummary });
      reveal({
        credentials: data.credentials,
        databaseId: data.database.id,
        tailnetOnly,
        title: `${data.database.displayName} is ready`,
        description:
          kind === "mirror"
            ? "Save the password; it is shown once. Then open the database and set its source on the Sync tab."
            : "Save the password; it is shown once.",
      });
      onFinished();
    },
  });

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    setTouched(true);
    if (nameProblem || hostProblem || mutation.isPending) return;
    mutation.mutate();
  };

  return (
    <form onSubmit={submit} noValidate className="flex min-h-0 flex-1 flex-col">
      <DialogBody className="space-y-5 pt-3">
        <div className="space-y-2">
          <div className="text-label font-medium text-text-muted">Type</div>
          {picker}
        </div>
        <div className="grid grid-cols-1 gap-6 md:grid-cols-5">
          <div className="space-y-5 md:col-span-3">
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
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                placeholder="Customer Portal"
                data-autofocus
                autoComplete="off"
                maxLength={200}
                disabled={mutation.isPending}
              />
            </Field>

            <AccessOptions
              tailnetOnly={tailnetOnly}
              onTailnetOnlyChange={setTailnetOnly}
              connectionsFrom={connectionsFrom}
              onConnectionsFromChange={setConnectionsFrom}
              error={touched ? hostProblem : null}
              disabled={mutation.isPending}
            />

            <div className="space-y-3">
              <div className="text-label font-medium text-text-muted">Options</div>
              <Switch
                checked={versioned}
                onChange={setVersioned}
                disabled={mutation.isPending}
                label="Version this database"
                description="Track working-copy changes against checkpoints, like a repository. Daily checkpoints run either way."
              />
              <Switch
                checked={showInVitals}
                onChange={setShowInVitals}
                disabled={mutation.isPending}
                label="Show in dashboard vitals"
                description="Include its size in the cluster chart on the dashboard."
              />
            </div>
          </div>

          <BuildManifest
            kind={kind}
            schema={schema}
            host={manifestHost(conn)}
            from={effectiveHost}
            tailnetOnly={tailnetOnly}
            versioned={versioned}
            className="md:col-span-2"
          />
        </div>

        <ReachNotice reach={conn.reach} isAdmin={isAdmin} compact />

        {mutation.isError && (
          <Alert variant="danger" title="Could not provision the database">
            {errorMessage(mutation.error)}
          </Alert>
        )}
      </DialogBody>
      <DialogFooter>
        <Button variant="ghost" onClick={onCancel} disabled={mutation.isPending}>
          Cancel
        </Button>
        <Button type="submit" loading={mutation.isPending}>
          {mutation.isPending ? "Provisioning…" : "Provision database"}
          {!mutation.isPending && <ArrowRight />}
        </Button>
      </DialogFooter>
    </form>
  );
}

export interface AccessOptionsProps {
  tailnetOnly: boolean;
  onTailnetOnlyChange: (value: boolean) => void;
  connectionsFrom: string;
  onConnectionsFromChange: (value: string) => void;
  error: string | null;
  disabled?: boolean;
}

export function AccessOptions({
  tailnetOnly,
  onTailnetOnlyChange,
  connectionsFrom,
  onConnectionsFromChange,
  error,
  disabled,
}: AccessOptionsProps) {
  const term = useTermNode();
  return (
    <div className="space-y-3">
      <div className="text-label font-medium text-text-muted">Access</div>
      <Switch
        checked={tailnetOnly}
        onChange={onTailnetOnlyChange}
        disabled={disabled}
        label="Tailnet only"
        description="Accept connections from your Tailscale network only (100.%)."
      />
      {!tailnetOnly && (
        <Field label={term("connectionsFrom")} error={error} hint={term("connectionsFromHelp")}>
          <Input
            mono
            value={connectionsFrom}
            onChange={(e) => onConnectionsFromChange(e.target.value)}
            placeholder="%"
            autoComplete="off"
            spellCheck={false}
            disabled={disabled}
          />
        </Field>
      )}
    </div>
  );
}

export function manifestHost(conn: { host: string; port: number; reach: DatabaseReach }): ReactNode {
  if (conn.reach === "not-yet") return <span className="text-warn">not reachable yet</span>;
  const address = formatConnectionAddress(conn.host, conn.port);
  if (conn.reach === "this-machine") return `${address} · this machine`;
  return address;
}

export interface BuildManifestProps {
  kind: string;
  schema: string;
  host: ReactNode;
  from: string;
  tailnetOnly?: boolean;
  versioned?: boolean;
  extra?: { label: string; value: ReactNode }[];
  className?: string;
}

export function BuildManifest({ kind, schema, host, from, tailnetOnly, versioned, extra = [], className }: BuildManifestProps) {
  const user = schema ? `ld_${schema.slice(0, 12)}_····` : null;
  const rows: { label: string; value: ReactNode }[] = [
    { label: "kind", value: <span className="text-text">{kind}</span> },
    { label: "schema", value: schema ? <span className="text-accent">{schema}</span> : <Dim /> },
    { label: "user", value: user ? <span className="text-text-muted">{user}</span> : <Dim /> },
    {
      label: "pass",
      value: (
        <span className="text-text-muted">
          <span aria-hidden className="tracking-[0.15em]">••••••••</span>
          <span className="sr-only">generated</span> <span className="text-text-subtle">24 ch · auto</span>
        </span>
      ),
    },
    { label: "host", value: <span className="text-text-muted">{host}</span> },
    { label: "from", value: <span className={tailnetOnly ? "text-accent" : "text-text-muted"}>{from}</span> },
    { label: "history", value: <span className="text-text-muted">{versioned ? "versioned" : "daily checkpoints"}</span> },
    ...extra,
  ];
  return (
    <aside
      aria-label="Build manifest"
      className={cn("h-fit min-w-0 rounded-lg border border-border bg-bg-inset p-4", className)}
    >
      <div className="mb-3 flex items-center gap-1.5 font-mono text-micro text-text-subtle">
        <span aria-hidden className="size-1.5 rounded-full bg-accent" />
        build manifest
      </div>
      <dl className="space-y-1 font-mono text-code">
        {rows.map((row, i) => (
          <div key={row.label} className="flex min-w-0 items-baseline gap-2">
            <span aria-hidden className="select-none text-text-subtle">
              {i === rows.length - 1 ? "└─" : "├─"}
            </span>
            <dt className="w-14 shrink-0 text-micro text-text-subtle">{row.label}</dt>
            <dd className="min-w-0 flex-1 truncate">{row.value}</dd>
          </div>
        ))}
      </dl>
      <div className="mt-4 border-t border-dashed border-border pt-3">
        <div className="mb-1.5 font-mono text-micro text-text-subtle">grant</div>
        <pre className="whitespace-pre-wrap break-words font-mono text-micro leading-relaxed text-text-muted">
          GRANT ALL ON <span className="text-accent">{schema || "…"}</span>.*{"\n"}TO {user ?? "…"}@
          <span className={tailnetOnly ? "text-accent" : "text-text"}>&apos;{from}&apos;</span>
        </pre>
      </div>
    </aside>
  );
}

function Dim() {
  return <span className="text-text-subtle">—</span>;
}
