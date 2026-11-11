import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ShieldAlert } from "lucide-react";
import type { Database, RejectedConnection } from "@lambdata/shared";
import { Badge } from "../ui/Badge";
import { Button } from "../ui/Button";
import { Card, CardContent, CardFooter, CardHeader } from "../ui/Card";
import { ConfirmDialog } from "../ui/ConfirmDialog";
import { toast } from "../ui/Toast";
import { api, errorMessage } from "../../lib/api";
import { formatDate, formatRelativeTime } from "../../lib/format";
import { queryKeys } from "../../lib/queries";
import { REASON_LABELS, rejectionKeys, timesLabel, useDatabaseRejections } from "../../lib/connections";

export function RejectionRow({
  rejection,
  canAllow,
  onAllow,
  showAccount = false,
}: {
  rejection: RejectedConnection;
  canAllow: boolean;
  onAllow?: (rejection: RejectedConnection) => void;
  showAccount?: boolean;
}) {
  const tone = rejection.reason === "wrong-password" || rejection.reason === "unknown-account" ? "muted" : "warn";
  return (
    <li className="space-y-1.5 py-3 first:pt-0 last:pb-0" data-reason={rejection.reason}>
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5">
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          <span className="font-mono text-code text-text [overflow-wrap:anywhere]">{rejection.address}</span>
          {showAccount && rejection.account && (
            <span className="font-mono text-code text-text-muted [overflow-wrap:anywhere]">as {rejection.account}</span>
          )}
          <Badge size="sm" variant={tone}>
            {REASON_LABELS[rejection.reason]}
          </Badge>
        </div>
        <span className="text-label text-text-muted" title={`First ${formatDate(rejection.firstAt)}, last ${formatDate(rejection.lastAt)}`}>
          {timesLabel(rejection.count)}, last {formatRelativeTime(rejection.lastAt)}
        </span>
      </div>
      <p className="text-body text-text-muted">{rejection.explanation}</p>
      {canAllow && rejection.canAllow && onAllow && (
        <Button size="xs" variant="secondary" onClick={() => onAllow(rejection)}>
          Allow this address
        </Button>
      )}
    </li>
  );
}

export function AllowAddressSummary({ current, next }: { current: string; next: string }) {
  return (
    <div className="space-y-3" data-allow-summary>
      <p>
        This replaces the current “connections from” value. Clients that only matched the current value stop being able to
        sign in.
      </p>
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1.5 rounded-md border border-border bg-bg-inset px-3 py-2.5">
        <dt className="text-label text-text-muted">Current</dt>
        <dd className="font-mono text-code text-text [overflow-wrap:anywhere]">{current}</dd>
        <dt className="text-label text-text-muted">New</dt>
        <dd className="font-mono text-code text-accent [overflow-wrap:anywhere]">{next}</dd>
      </dl>
    </div>
  );
}

export function allowAddressRequest(databaseId: string, address: string) {
  return api.patch<{ database: Database | null; warnings?: string[] }>(`/databases/${encodeURIComponent(databaseId)}`, {
    connectionsFrom: address,
  });
}

export function RejectedConnectionsCard({ db, canWrite }: { db: Database; canWrite: boolean }) {
  const qc = useQueryClient();
  const query = useDatabaseRejections(db.id);
  const [pending, setPending] = useState<RejectedConnection | null>(null);
  const allow = useMutation({
    mutationFn: (address: string) => allowAddressRequest(db.id, address),
    onSuccess: (data) => {
      if (data.database) qc.setQueryData(queryKeys.database(db.id), { database: data.database });
      void qc.invalidateQueries({ queryKey: queryKeys.databases });
      void qc.invalidateQueries({ queryKey: rejectionKeys.database(db.id) });
      const warnings = data.warnings ?? [];
      if (warnings.length > 0) warnings.forEach((w) => toast.warning(w));
      else toast.success("Connections from updated");
    },
    onError: (error) => toast.error(errorMessage(error, "Could not update connections from")),
  });
  const rejections = query.data?.rejections ?? [];
  if (!query.data?.supported || rejections.length === 0) return null;

  return (
    <Card flush>
      <CardHeader
        divided
        title={
          <span className="inline-flex items-center gap-2">
            <ShieldAlert aria-hidden className="size-4 text-warn" />
            Rejected connections
          </span>
        }
        description="Sign-ins MariaDB refused for this database's account, grouped by address."
      />
      <CardContent>
        <ul className="divide-y divide-border">
          {rejections.map((r) => (
            <RejectionRow
              key={`${r.address}:${r.reason}`}
              rejection={r}
              canAllow={canWrite && !allow.isPending}
              onAllow={setPending}
            />
          ))}
        </ul>
      </CardContent>
      <CardFooter className="justify-start text-label text-text-muted">
        {query.data.since ? `Recorded since ${formatDate(query.data.since)}; kept for 30 days.` : "Kept for 30 days."}
      </CardFooter>
      <ConfirmDialog
        open={pending !== null}
        onClose={() => setPending(null)}
        onConfirm={() => {
          if (pending) allow.mutate(pending.address);
          setPending(null);
        }}
        title="Allow this address?"
        body={pending ? <AllowAddressSummary current={db.connectionsFrom} next={pending.address} /> : null}
        confirmLabel="Replace and allow"
        loading={allow.isPending}
      />
    </Card>
  );
}
