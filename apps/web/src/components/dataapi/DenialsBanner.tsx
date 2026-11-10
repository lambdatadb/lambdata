import { useMemo } from "react";
import { Check, ShieldAlert } from "lucide-react";
import { Badge, Button, Card, SimpleTooltip, useToast } from "../ui";
import { formatDate, formatRelativeTime } from "../../lib/format";
import {
  describeOperations,
  groupDenials,
  hasPolicy,
  useAddPolicy,
  useDismissDenials,
  type DataAccessOverview,
  type DenialGroup,
} from "./useDataAccess";
import { errorMessage } from "../../lib/api";

interface Props {
  overview: DataAccessOverview | undefined;
  canWrite: boolean;
  onReview: (databaseName: string, tableName: string) => void;
}

export function DenialsBanner({ overview, canWrite, onReview }: Props) {
  const toast = useToast();
  const addPolicy = useAddPolicy();
  const dismiss = useDismissDenials();
  const groups = useMemo(
    () => (overview?.supported ? groupDenials(overview.databases) : []),
    [overview],
  );

  if (groups.length === 0) return null;

  const total = groups.reduce((sum, g) => sum + g.total, 0);
  const latest = groups[0]!;
  const sample = `${latest.operations[0]?.operation ?? "select"} denied: table "${latest.tableName}" in database "${latest.databaseName}" has no Data API policy.`;
  const databaseNames = [...new Set(groups.map((g) => g.databaseName))];
  const pendingKey = addPolicy.isPending
    ? `${addPolicy.variables?.databaseName}.${addPolicy.variables?.tableName}`
    : null;

  const add = (group: DenialGroup) => {
    const operations = group.operations.map((o) => o.operation);
    addPolicy.mutate(
      { databaseName: group.databaseName, tableName: group.tableName, operations },
      {
        onSuccess: () =>
          toast.success(`Policy added to ${group.tableName}`, {
            description: `Allows ${describeOperations(operations)}. Requests for other operations stay denied.`,
            action: { label: "Review", onClick: () => onReview(group.databaseName, group.tableName) },
          }),
        onError: (e) => toast.error(errorMessage(e, "Could not add the policy")),
      },
    );
  };

  return (
    <Card flush className="border-warn/40" role="region" aria-labelledby="data-api-denials-title">
      <div className="flex flex-wrap items-start gap-x-4 gap-y-3 px-5 py-4">
        <span className="grid size-8 shrink-0 place-items-center rounded-md border border-warn/30 bg-warn/10 text-warn">
          <ShieldAlert className="size-4" aria-hidden />
        </span>
        <div className="min-w-0 flex-1 basis-64 space-y-1">
          <h2 id="data-api-denials-title" className="text-heading font-semibold text-text">
            {total.toLocaleString()} {total === 1 ? "request was" : "requests were"} denied since the upgrade
          </h2>
          <p className="text-body text-text-muted">
            The Data API is now closed by default: tables without a policy refuse requests. Add a policy for each table
            your apps use, or open the database below if every app user should reach it.
          </p>
          <p className="pt-1 text-label text-text-muted">
            Your apps got a 403 that names the table and points here, for example:
          </p>
          <p className="break-words rounded-md border border-border bg-bg-inset px-3 py-2 font-mono text-micro text-text-muted">
            {sample}
          </p>
        </div>
        {canWrite && (
          <SimpleTooltip content="Clears these counters. New denials show up again.">
            <Button
              variant="secondary"
              size="sm"
              loading={dismiss.isPending}
              onClick={() =>
                dismiss.mutate(databaseNames, {
                  onSuccess: () => toast.success("Denial counters cleared"),
                  onError: (e) => toast.error(errorMessage(e, "Could not clear the counters")),
                })
              }
            >
              Dismiss
            </Button>
          </SimpleTooltip>
        )}
      </div>
      <ul className="divide-y divide-border border-t border-border" aria-label="Denied tables">
        {groups.map((group) => {
          const covered = hasPolicy(group.summary, group.tableName);
          return (
            <li key={group.key} className="flex flex-wrap items-center gap-x-5 gap-y-2 px-5 py-3">
              <div className="order-1 min-w-0 flex-1 basis-[calc(100%-9rem)] md:basis-44">
                <div className="truncate font-mono text-code text-text">{group.tableName}</div>
                <div className="truncate text-micro text-text-subtle">
                  {group.displayName} <span className="font-mono">· {group.databaseName}</span>
                </div>
              </div>
              <div className="order-3 flex min-w-0 flex-wrap items-center gap-1.5 md:order-2">
                {group.operations.map((op) => (
                  <Badge key={op.operation} variant="muted" mono size="sm">
                    {op.operation}
                    <span className="text-text-subtle">×</span>
                    <span className="text-text">{typeof op.count === "number" ? op.count.toLocaleString() : op.count}</span>
                  </Badge>
                ))}
              </div>
              <div className="order-4 shrink-0 text-label text-text-muted md:order-3 md:w-28" title={formatDate(group.lastAt)}>
                last {formatRelativeTime(group.lastAt)}
              </div>
              <div className="order-2 flex shrink-0 justify-end md:order-4 md:w-[7.5rem]">
                {covered ? (
                  <Button variant="ghost" size="xs" onClick={() => onReview(group.databaseName, group.tableName)}>
                    <Check className="text-success" aria-hidden /> Has a policy
                  </Button>
                ) : canWrite ? (
                  <Button
                    variant="secondary"
                    size="xs"
                    loading={pendingKey === group.key}
                    disabled={addPolicy.isPending && pendingKey !== group.key}
                    onClick={() => add(group)}
                  >
                    Add policy
                  </Button>
                ) : (
                  <Badge variant="warn" size="sm">
                    no policy
                  </Badge>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </Card>
  );
}
