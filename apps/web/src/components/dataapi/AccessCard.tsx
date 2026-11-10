import { useState } from "react";
import type { UseQueryResult } from "@tanstack/react-query";
import type { DataApiAccessSummary } from "@lambdata/shared";
import { Lock, LockOpen, Plus, RotateCcw } from "lucide-react";
import {
  Alert,
  Badge,
  Button,
  Card,
  CardHeader,
  ConfirmDialog,
  Skeleton,
  Switch,
  useToast,
} from "../ui";
import {
  describeOperations,
  operationsForNewPolicy,
  useAddPolicy,
  useSetAccessMode,
  type DataAccessOverview,
} from "./useDataAccess";
import { errorMessage } from "../../lib/api";

const PREVIEW_COUNT = 6;

interface Props {
  query: UseQueryResult<DataAccessOverview>;
  canWrite: boolean;
  onReview: (databaseName: string, tableName: string) => void;
}

export function AccessCard({ query, canWrite, onReview }: Props) {
  const toast = useToast();
  const setMode = useSetAccessMode();
  const addPolicy = useAddPolicy();
  const [pending, setPending] = useState<DataApiAccessSummary | null>(null);

  const overview = query.data;
  const signupEnabled = overview?.supported ? overview.signupEnabled : false;

  const changeMode = (summary: DataApiAccessSummary, open: boolean) => {
    if (open || summary.tablesWithoutPolicy.length > 0) {
      setPending({ ...summary, mode: open ? "open" : "closed" });
      return;
    }
    commitMode(summary, false);
  };

  const commitMode = (summary: DataApiAccessSummary, open: boolean) => {
    setMode.mutate(
      { databaseName: summary.databaseName, mode: open ? "open" : "closed" },
      {
        onSuccess: () => {
          setPending(null);
          toast.success(open ? `${summary.displayName} is open` : `${summary.displayName} is closed`, {
            description: open
              ? "Tables without a policy accept requests from any signed-in app user."
              : "Tables without a policy now refuse requests.",
          });
        },
        onError: (e) => toast.error(errorMessage(e, "Could not change access")),
      },
    );
  };

  const add = (summary: DataApiAccessSummary, tableName: string) => {
    const operations = operationsForNewPolicy(summary, tableName);
    addPolicy.mutate(
      { databaseName: summary.databaseName, tableName, operations },
      {
        onSuccess: () =>
          toast.success(`Policy added to ${tableName}`, {
            description: `Allows ${describeOperations(operations)}. Tighten it in the table's policy.`,
            action: { label: "Review", onClick: () => onReview(summary.databaseName, tableName) },
          }),
        onError: (e) => toast.error(errorMessage(e, "Could not add the policy")),
      },
    );
  };

  return (
    <Card flush>
      <CardHeader
        divided
        className="[&>div:first-child]:basis-64"
        title="Access"
        description="Closed databases refuse requests to tables that have no policy. Open databases let any signed-in app user read and write those tables."
        action={
          overview?.supported ? (
            <Badge variant={signupEnabled ? "warn" : "muted"} dot>
              Public signup {signupEnabled ? "on" : "off"}
            </Badge>
          ) : undefined
        }
      />
      {query.isPending ? (
        <div className="divide-y divide-border" role="status" aria-label="Loading access">
          {Array.from({ length: 2 }, (_, i) => (
            <div key={i} className="flex items-center gap-4 px-5 py-4">
              <div className="flex-1 space-y-2">
                <Skeleton className="h-4 w-40" />
                <Skeleton className="h-3 w-24" />
              </div>
              <Skeleton className="h-5 w-9 rounded-full" />
            </div>
          ))}
        </div>
      ) : query.isError ? (
        <div className="p-5">
          <Alert
            variant="danger"
            title="Could not load Data API access"
            action={
              <Button size="xs" variant="secondary" onClick={() => query.refetch()}>
                <RotateCcw aria-hidden /> Retry
              </Button>
            }
          >
            {errorMessage(query.error, "The server did not answer.")}
          </Alert>
        </div>
      ) : !overview?.supported ? (
        <div className="p-5">
          <Alert variant="neutral" title="This server does not report access modes yet">
            Per-database modes and denied requests appear here once the server is updated. Until then, tables
            without a policy follow the server&apos;s built-in default.
          </Alert>
        </div>
      ) : overview.databases.length === 0 ? (
        <p className="px-5 py-8 text-center text-body text-text-muted">
          No databases yet. Each database you create gets its own access mode here.
        </p>
      ) : (
        <ul className="divide-y divide-border">
          {overview.databases.map((summary) => (
            <AccessRow
              key={summary.databaseId || summary.databaseName}
              summary={summary}
              canWrite={canWrite}
              modePending={setMode.isPending && setMode.variables?.databaseName === summary.databaseName}
              addingTable={
                addPolicy.isPending && addPolicy.variables?.databaseName === summary.databaseName
                  ? addPolicy.variables.tableName
                  : null
              }
              addBusy={addPolicy.isPending}
              onModeChange={(open) => changeMode(summary, open)}
              onAdd={(tableName) => add(summary, tableName)}
              onReview={(tableName) => onReview(summary.databaseName, tableName)}
            />
          ))}
        </ul>
      )}

      <ConfirmDialog
        open={pending !== null}
        onClose={() => setPending(null)}
        onConfirm={() => pending && commitMode(pending, pending.mode === "open")}
        loading={setMode.isPending}
        tone={pending?.mode === "open" ? "danger" : "default"}
        size="md"
        title={pending?.mode === "open" ? `Open ${pending.displayName}?` : `Close ${pending?.displayName}?`}
        confirmLabel={pending?.mode === "open" ? "Open database" : "Close database"}
        body={
          pending?.mode === "open" ? (
            <>
              Any signed-in app user can read and write every table without a policy
              {pending.tablesWithoutPolicy.length > 0 ? (
                <>
                  {" "}
                  ({pending.tablesWithoutPolicy.length} now:{" "}
                  <span className="font-mono text-text">{pending.tablesWithoutPolicy.slice(0, 4).join(", ")}</span>
                  {pending.tablesWithoutPolicy.length > 4 ? ", …" : ""})
                </>
              ) : null}
              , including tables you create later.
              {signupEnabled ? " Public signup is on, so anyone who can reach this server can become an app user." : ""}
            </>
          ) : pending ? (
            <>
              {pending.tablesWithoutPolicy.length} {pending.tablesWithoutPolicy.length === 1 ? "table has" : "tables have"} no
              policy and will start refusing requests:{" "}
              <span className="font-mono text-text">{pending.tablesWithoutPolicy.slice(0, 4).join(", ")}</span>
              {pending.tablesWithoutPolicy.length > 4 ? ", …" : ""}. Apps that use them will see errors until you add
              policies.
            </>
          ) : null
        }
      />
    </Card>
  );
}

interface RowProps {
  summary: DataApiAccessSummary;
  canWrite: boolean;
  modePending: boolean;
  addingTable: string | null;
  addBusy: boolean;
  onModeChange: (open: boolean) => void;
  onAdd: (tableName: string) => void;
  onReview: (tableName: string) => void;
}

function AccessRow({ summary, canWrite, modePending, addingTable, addBusy, onModeChange, onAdd, onReview }: RowProps) {
  const [expanded, setExpanded] = useState(false);
  const open = summary.mode === "open";
  const missing = summary.tablesWithoutPolicy;
  const visible = expanded ? missing : missing.slice(0, PREVIEW_COUNT);
  const listId = `access-missing-${summary.databaseName}`;

  return (
    <li className="px-5 py-4">
      <div className="flex flex-wrap items-center gap-x-5 gap-y-3">
        <div className="min-w-0 flex-1 basis-56">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <span className="truncate font-medium text-text">{summary.displayName}</span>
            {open ? (
              <Badge variant="warn">
                <LockOpen aria-hidden /> Open
              </Badge>
            ) : (
              <Badge variant="muted">
                <Lock aria-hidden /> Closed
              </Badge>
            )}
          </div>
          <div className="mt-0.5 truncate font-mono text-micro text-text-subtle">{summary.databaseName}</div>
        </div>
        <div className="text-label text-text-muted">
          <span className="font-mono text-text">{summary.tableCount}</span> {summary.tableCount === 1 ? "table" : "tables"}
          <span className="px-1.5 text-text-subtle">·</span>
          {missing.length === 0 ? (
            "all have a policy"
          ) : (
            <>
              <span className="font-mono text-text">{missing.length}</span> without a policy
            </>
          )}
        </div>
        <Switch
          checked={open}
          disabled={!canWrite || modePending}
          onCheckedChange={onModeChange}
          label="Open"
          aria-label={`Open access for ${summary.displayName}`}
        />
      </div>
      {missing.length > 0 && (
        <div className="mt-3 space-y-2">
          <p className="text-micro text-text-subtle">
            {open
              ? "Without a policy, so any signed-in app user can read and write them:"
              : "Without a policy, so every request to them is denied:"}
          </p>
          <ul id={listId} className="grid gap-1.5 sm:grid-cols-2 xl:grid-cols-3">
            {visible.map((tableName) => (
              <li
                key={tableName}
                className="flex min-w-0 items-center justify-between gap-2 rounded-md border border-border bg-bg-inset py-1 pl-2.5 pr-1"
              >
                <button
                  type="button"
                  onClick={() => onReview(tableName)}
                  className="min-w-0 truncate rounded-sm text-left font-mono text-code text-text-muted outline-none hover:text-text focus-visible:ring-2 focus-visible:ring-ring/70"
                >
                  {tableName}
                </button>
                {canWrite && (
                  <Button
                    size="xs"
                    variant="ghost"
                    loading={addingTable === tableName}
                    disabled={addBusy && addingTable !== tableName}
                    onClick={() => onAdd(tableName)}
                    aria-label={`Add policy to ${tableName}`}
                  >
                    <Plus aria-hidden /> Add policy
                  </Button>
                )}
              </li>
            ))}
          </ul>
          {missing.length > PREVIEW_COUNT && (
            <Button
              variant="link"
              size="xs"
              aria-expanded={expanded}
              aria-controls={listId}
              onClick={() => setExpanded((v) => !v)}
            >
              {expanded ? "Show fewer" : `Show all ${missing.length}`}
            </Button>
          )}
        </div>
      )}
    </li>
  );
}
