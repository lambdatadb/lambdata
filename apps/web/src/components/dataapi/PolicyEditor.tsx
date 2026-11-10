import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { DataApiAccessSummary, DataApiPolicy, DataApiTable } from "@lambdata/shared";
import { Plus, Trash2 } from "lucide-react";
import { Alert, Badge, Button, ConfirmDialog, Field, SelectMenu, Switch, useToast } from "../ui";
import { api, errorMessage } from "../../lib/api";
import { formatRelativeTime } from "../../lib/format";
import {
  DATA_OPERATIONS,
  OPERATION_METHOD,
  dataAccessKey,
  describeOperations,
  deniedOperations,
  operationsForNewPolicy,
  schemaKey,
  useAddPolicy,
} from "./useDataAccess";

const NO_OWNER = "__none__";

const OPERATION_LABEL = {
  select: "Read",
  insert: "Insert",
  update: "Update",
  delete: "Delete",
} as const;

const OPERATION_FIELD = {
  select: "selectEnabled",
  insert: "insertEnabled",
  update: "updateEnabled",
  delete: "deleteEnabled",
} as const;

interface Props {
  databaseName: string;
  table: DataApiTable;
  access: DataApiAccessSummary | null | undefined;
  canWrite: boolean;
}

export function PolicyEditor({ databaseName, table, access, canWrite }: Props) {
  const qc = useQueryClient();
  const toast = useToast();
  const addPolicy = useAddPolicy();
  const [confirmRemove, setConfirmRemove] = useState(false);
  const policyPath = `/data-policies/${encodeURIComponent(databaseName)}/${encodeURIComponent(table.name)}`;

  const refresh = () => {
    qc.invalidateQueries({ queryKey: schemaKey(databaseName) });
    qc.invalidateQueries({ queryKey: dataAccessKey });
  };

  const update = useMutation({
    mutationFn: (patch: Partial<DataApiPolicy>) => api.patch<{ policy: DataApiPolicy }>(policyPath, patch),
    onSuccess: refresh,
  });

  const remove = useMutation({
    mutationFn: () => api.delete<{ policy: DataApiPolicy }>(policyPath),
    onSuccess: refresh,
  });

  const policy = table.policy;
  const denied = deniedOperations(access, table.name);
  const newOps = operationsForNewPolicy(access, table.name);
  const closed = access?.mode === "closed";
  const open = access?.mode === "open";
  const busy = update.isPending || remove.isPending;

  const patch = (body: Partial<DataApiPolicy>, message: string) =>
    update.mutate(body, {
      onSuccess: () => toast.success(message),
      onError: (e) => toast.error(errorMessage(e, "Could not update the policy")),
    });

  return (
    <section aria-labelledby="policy-title" className="space-y-4 border-b border-border px-5 py-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h4 id="policy-title" className="text-body font-medium text-text">
          Policy
        </h4>
        {policy ? (
          <Badge variant={policy.ownerColumn ? "info" : "muted"}>
            {policy.ownerColumn ? `scoped to ${policy.ownerColumn}` : "all rows"}
          </Badge>
        ) : (
          <Badge variant={closed ? "warn" : "muted"}>{closed ? "denied" : open ? "open" : "no policy"}</Badge>
        )}
      </div>

      {!policy ? (
        <Alert
          variant={closed ? "warning" : open ? "info" : "neutral"}
          title={
            closed
              ? "No policy, so every request is denied"
              : open
                ? "No policy, so the open database lets every app user in"
                : "No policy stored"
          }
        >
          {closed
            ? `${access?.displayName ?? databaseName} is closed.`
            : open
              ? `${access?.displayName ?? databaseName} is open: any signed-in app user can read and write this table.`
              : "The server's default for tables without a policy applies."}{" "}
          {canWrite
            ? denied.length > 0
              ? `A new policy allows what was denied: ${describeOperations(newOps)}.`
              : `A new policy starts with ${describeOperations(newOps)} allowed; tighten it here afterwards.`
            : null}
          {canWrite && (
            <div className="mt-3">
              <Button
                size="xs"
                variant="secondary"
                loading={addPolicy.isPending}
                onClick={() =>
                  addPolicy.mutate(
                    { databaseName, tableName: table.name, operations: newOps },
                    {
                      onSuccess: () => toast.success(`Policy added to ${table.name}`),
                      onError: (e) => toast.error(errorMessage(e, "Could not add the policy")),
                    },
                  )
                }
              >
                <Plus aria-hidden /> Add policy
              </Button>
            </div>
          )}
        </Alert>
      ) : (
        <>
          <div className="grid gap-x-4 gap-y-3 sm:grid-cols-2 xl:grid-cols-4">
            {DATA_OPERATIONS.map((op) => {
              const field = OPERATION_FIELD[op];
              const enabled = policy[field];
              return (
                <Switch
                  key={op}
                  checked={enabled}
                  disabled={!canWrite || busy}
                  onCheckedChange={(next) =>
                    patch(
                      { [field]: next } as Partial<DataApiPolicy>,
                      `${OPERATION_LABEL[op]} ${next ? "allowed" : "blocked"} on ${table.name}`,
                    )
                  }
                  label={OPERATION_LABEL[op]}
                  description={
                    <span className="font-mono">
                      {OPERATION_METHOD[op]} · {enabled ? "allowed" : "blocked"}
                    </span>
                  }
                />
              );
            })}
          </div>
          <Field
            label="Owner column"
            hint="Rows are filtered to the signed-in app user's id. Inserts must set it."
            className="max-w-md"
          >
            <SelectMenu
              value={policy.ownerColumn ?? NO_OWNER}
              disabled={!canWrite || busy}
              onValueChange={(value) => {
                const ownerColumn = value === NO_OWNER ? null : value;
                patch(
                  { ownerColumn },
                  ownerColumn ? `${table.name} is scoped to ${ownerColumn}` : `${table.name} is no longer owner scoped`,
                );
              }}
              options={[
                { value: NO_OWNER, label: "None, all rows" },
                ...table.columns.map((column) => ({
                  value: column.name,
                  label: <span className="font-mono text-code">{column.name}</span>,
                })),
              ]}
            />
          </Field>
          <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border pt-3">
            <span className="text-micro text-text-subtle">
              {policy.updatedAt ? `Updated ${formatRelativeTime(policy.updatedAt)}` : "Stored policy"}
            </span>
            {canWrite && (
              <Button variant="danger-soft" size="xs" onClick={() => setConfirmRemove(true)}>
                <Trash2 aria-hidden /> Remove policy
              </Button>
            )}
          </div>
        </>
      )}

      <ConfirmDialog
        open={confirmRemove}
        onClose={() => setConfirmRemove(false)}
        onConfirm={() =>
          remove.mutate(undefined, {
            onSuccess: () => {
              setConfirmRemove(false);
              toast.success(`Policy removed from ${table.name}`);
            },
            onError: (e) => toast.error(errorMessage(e, "Could not remove the policy")),
          })
        }
        loading={remove.isPending}
        tone="danger"
        title={`Remove the policy on ${table.name}?`}
        confirmLabel="Remove policy"
        body={
          open
            ? `${access?.displayName ?? databaseName} is open, so the table falls back to read and write for every signed-in app user.`
            : closed
              ? `${access?.displayName ?? databaseName} is closed, so every Data API request to this table will be denied.`
              : "The table falls back to the server's default for tables without a policy."
        }
      />
    </section>
  );
}
