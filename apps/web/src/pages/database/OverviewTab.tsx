import { useState } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { KeyRound } from "lucide-react";
import type { Database, DatabaseCredentials } from "@lambdata/shared";
import { Alert } from "../../components/ui/Alert";
import { Button } from "../../components/ui/Button";
import { Card, CardContent, CardFooter, CardHeader } from "../../components/ui/Card";
import { ConfirmDialog } from "../../components/ui/ConfirmDialog";
import { CopyableField } from "../../components/ui/CopyableField";
import { DescriptionItem, DescriptionList } from "../../components/ui/DescriptionList";
import { Field, FieldGroup } from "../../components/ui/Field";
import { Input } from "../../components/ui/Input";
import { Switch } from "../../components/ui/Switch";
import { toast } from "../../components/ui/Toast";
import { useCredentialsReveal } from "../../components/databases/CredentialsReveal";
import { ReachNotice } from "../../components/databases/ReachNotice";
import { RejectedConnectionsCard } from "../../components/databases/RejectedConnections";
import { VitalsStrip } from "../../components/databases/VitalsStrip";
import { RepoBadge } from "../../components/checkpoints/RepoBadge";
import { compactSummary } from "../../components/checkpoints/policy";
import { useCheckpointList } from "../../components/checkpoints/queries";
import { api, errorMessage } from "../../lib/api";
import { useAuth, useCanWriteDatabase, useIsAdmin } from "../../lib/auth";
import { databasePath } from "../../lib/commands";
import { formatDate } from "../../lib/format";
import { queryKeys } from "../../lib/queries";
import { renderInlineCode, useTerminology } from "../../lib/terminology";
import { isTailnetOnly, useConnectionInfo, useDatabaseEndpoints, type DatabaseEndpoint } from "../../lib/useConnectionInfo";
import type { DatabaseReach } from "../../lib/connections";
import type { DatabaseTabProps } from "./types";

function usePatchDatabase(db: Database) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (patch: Partial<Pick<Database, "connectionsFrom" | "showInVitals" | "versioned" | "displayName">>) =>
      api.patch<{ database: Database | null; warnings?: string[] }>(`/databases/${db.id}`, patch),
    onSuccess: (data) => {
      if (data.database) qc.setQueryData(queryKeys.database(db.id), { database: data.database });
      void qc.invalidateQueries({ queryKey: queryKeys.databases });
      void qc.invalidateQueries({ queryKey: ["dashboard"] });
    },
  });
}

export function OverviewTab({ db }: DatabaseTabProps) {
  const { user } = useAuth();
  const canWrite = useCanWriteDatabase(db);
  const [accessWarnings, setAccessWarnings] = useState<string[]>([]);
  return (
    <div className="space-y-4">
      {user?.dataViewEnabled && <VitalsStrip databaseId={db.id} />}
      {accessWarnings.length > 0 && (
        <Alert
          variant="warning"
          title="Allowed hosts changed, with warnings"
          action={
            <Button size="xs" variant="ghost" onClick={() => setAccessWarnings([])}>
              Dismiss
            </Button>
          }
        >
          <ul className="list-disc space-y-1 pl-4">
            {accessWarnings.map((warning, i) => (
              <li key={i} className="break-words">
                {warning}
              </li>
            ))}
          </ul>
        </Alert>
      )}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <div className="space-y-4 lg:col-span-2">
          <ConnectionCard db={db} />
          <AccessCard key={`${db.id}:${db.connectionsFrom}`} db={db} onWarnings={setAccessWarnings} />
          <RejectedConnectionsCard db={db} canWrite={canWrite} />
        </div>
        <DetailsCard db={db} />
      </div>
    </div>
  );
}

function ConnectionCard({ db }: { db: Database }) {
  const t = useTerminology();
  const canWrite = useCanWriteDatabase(db);
  const reveal = useCredentialsReveal();
  const isAdmin = useIsAdmin();
  const endpoints = useDatabaseEndpoints(db);
  const { reach } = useConnectionInfo();
  const [confirming, setConfirming] = useState(false);

  const rotate = useMutation({
    mutationFn: () => api.post<{ credentials: DatabaseCredentials }>(`/databases/${db.id}/rotate-password`),
    onSuccess: (data) => {
      reveal({
        credentials: data.credentials,
        databaseId: db.id,
        tailnetOnly: isTailnetOnly(db.connectionsFrom),
        offerOpen: false,
        title: "New password",
        description: (
          <>
            The previous password for <span className="font-mono text-code text-text">{db.mysqlUser}</span> no longer works.
            Update your clients with this one; it is shown once.
          </>
        ),
      });
    },
    onError: (error) => toast.error(errorMessage(error, "Could not rotate the password")),
  });

  return (
    <Card flush>
      <CardHeader
        divided
        title="Connection"
        description="Connect with any MySQL or MariaDB client."
        action={
          canWrite ? (
            <Button variant="secondary" size="sm" loading={rotate.isPending} onClick={() => setConfirming(true)}>
              <KeyRound /> {t("rotatePassword")}
            </Button>
          ) : undefined
        }
      />
      <CardContent className="space-y-4">
        <ConnectionFacts db={db} endpoints={endpoints} reach={reach} isAdmin={isAdmin} />
      </CardContent>
      <CardFooter className="justify-start text-label text-text-muted">
        The password is stored encrypted and never shown again. {canWrite ? "Rotate it to get a new one." : ""}
      </CardFooter>
      <ConfirmDialog
        open={confirming}
        onClose={() => setConfirming(false)}
        onConfirm={() => {
          setConfirming(false);
          rotate.mutate();
        }}
        tone="danger"
        title="Rotate the password?"
        body={
          <>
            A new password for <span className="font-mono text-text">{db.mysqlUser}</span> is generated and shown once.
            Clients using the current password stop connecting until you update them.
          </>
        }
        confirmLabel="Rotate password"
      />
    </Card>
  );
}

export function ConnectionFacts({
  db,
  endpoints,
  reach,
  isAdmin,
}: {
  db: Pick<Database, "name" | "mysqlUser" | "connectionsFrom">;
  endpoints: DatabaseEndpoint[];
  reach: DatabaseReach;
  isAdmin: boolean;
}) {
  const primary = endpoints[0]!;
  const others = endpoints.slice(1);
  const hostLabel =
    reach === "this-machine" ? "Host (this machine only)" : primary.label === "Tailnet" ? "Host (tailnet)" : "Host";
  return (
    <>
      {reach === "not-yet" && <ReachNotice reach={reach} isAdmin={isAdmin} />}
      <FieldGroup>
        {reach !== "not-yet" && <CopyableField label={hostLabel} value={primary.host} />}
        <CopyableField label="Port" value={String(primary.port)} />
        <CopyableField label="Schema" value={db.name} />
        <CopyableField label="User" value={db.mysqlUser} />
      </FieldGroup>
      {reach === "this-machine" && <ReachNotice reach={reach} isAdmin={isAdmin} />}
      {reach === "outside" &&
        others.map((endpoint) => (
          <CopyableField
            key={endpoint.label}
            label={`${endpoint.label} host`}
            value={endpoint.host}
            copyLabel={`${endpoint.label.toLowerCase()} host`}
          />
        ))}
      {reach === "outside" && isTailnetOnly(db.connectionsFrom) && !endpoints.some((e) => e.label === "Tailnet") && (
        <Alert variant="warning" title="Tailnet only, but the tailnet is down">
          This database accepts connections from 100.% addresses only. Bring Tailscale up on the Network page to reach it.
        </Alert>
      )}
    </>
  );
}

const HOST_PATTERN = /^[A-Za-z0-9.%_:\-/]+$/;

function AccessCard({ db, onWarnings }: { db: Database; onWarnings: (warnings: string[]) => void }) {
  const t = useTerminology();
  const canWrite = useCanWriteDatabase(db);
  const patch = usePatchDatabase(db);
  const [value, setValue] = useState(db.connectionsFrom);
  const trimmed = value.trim();
  const dirty = trimmed !== db.connectionsFrom;
  const problem = !trimmed
    ? "Enter a host pattern. Use % to allow any host."
    : !HOST_PATTERN.test(trimmed)
      ? "Use letters, digits, dots, colons, % and _ only."
      : null;

  return (
    <Card flush>
      <CardHeader divided title="Access" description="Which client addresses MariaDB accepts for this user." />
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (!dirty || problem || !canWrite) return;
          patch.mutate(
            { connectionsFrom: trimmed },
            {
              onSuccess: (data) => {
                const warnings = data.warnings ?? [];
                onWarnings(warnings);
                if (warnings.length === 0) toast.success("Allowed hosts updated");
              },
              onError: (error) => toast.error(errorMessage(error, "Could not update allowed hosts")),
            },
          );
        }}
      >
        <CardContent>
          <Field label={t("connectionsFrom")} hint={renderInlineCode(t("connectionsFromHelp"))} error={dirty ? problem : null}>
            <Input
              mono
              value={value}
              onChange={(e) => setValue(e.target.value)}
              placeholder="%"
              spellCheck={false}
              autoComplete="off"
              disabled={!canWrite || patch.isPending}
            />
          </Field>
        </CardContent>
        {canWrite && (
          <CardFooter>
            {dirty && (
              <Button variant="ghost" size="sm" onClick={() => setValue(db.connectionsFrom)} disabled={patch.isPending}>
                Reset
              </Button>
            )}
            <Button type="submit" size="sm" variant="secondary" loading={patch.isPending} disabled={!dirty || !!problem}>
              Save
            </Button>
          </CardFooter>
        )}
      </form>
    </Card>
  );
}

function DetailsCard({ db }: { db: Database }) {
  const canWrite = useCanWriteDatabase(db);
  const patch = usePatchDatabase(db);
  const [optimistic, setOptimistic] = useState<boolean | null>(null);
  const showInVitals = optimistic ?? db.showInVitals;
  const policy = useCheckpointList(db.id).data?.policy;

  return (
    <Card flush className="h-fit">
      <CardHeader divided title="Details" />
      <CardContent className="space-y-5">
        <DescriptionList>
          <DescriptionItem term="Created">{formatDate(db.createdAt)}</DescriptionItem>
          <DescriptionItem term="Owner">{db.ownerDisplayName ?? "—"}</DescriptionItem>
          <DescriptionItem term="Kind">
            <span className="capitalize">{db.kind}</span>
          </DescriptionItem>
          <DescriptionItem term="Status">
            <span className="capitalize">{db.status}</span>
          </DescriptionItem>
          <DescriptionItem term="Checkpoints">
            <Link
              to={databasePath(db.id, "settings")}
              className="rounded-sm outline-none hover:text-text focus-visible:ring-2 focus-visible:ring-ring/70"
              data-overview-schedule
            >
              {policy ? compactSummary(policy, db.kind === "mirror") : "—"}
            </Link>
          </DescriptionItem>
          <DescriptionItem term="Versioned">
            <Link
              to={databasePath(db.id, "history")}
              className="inline-flex items-center gap-2 rounded-sm outline-none hover:text-text focus-visible:ring-2 focus-visible:ring-ring/70"
            >
              {db.versioned ? <RepoBadge db={db} live /> : "No"}
            </Link>
          </DescriptionItem>
        </DescriptionList>
        <div className="border-t border-border pt-4">
          <Switch
            checked={showInVitals}
            disabled={!canWrite || patch.isPending}
            onChange={(next) => {
              setOptimistic(next);
              patch.mutate(
                { showInVitals: next },
                {
                  onSuccess: () => setOptimistic(null),
                  onError: (error) => {
                    setOptimistic(null);
                    toast.error(errorMessage(error, "Could not update the dashboard setting"));
                  },
                },
              );
            }}
            label="Show in dashboard vitals"
            description="Include this database in the cluster storage chart."
          />
        </div>
      </CardContent>
    </Card>
  );
}
