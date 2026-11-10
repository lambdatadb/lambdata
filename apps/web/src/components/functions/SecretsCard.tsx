import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { EdgeFunctionSecret } from "@lambdata/shared";
import { KeyRound, Lock, RotateCcw, Trash2 } from "lucide-react";
import {
  Alert,
  Button,
  Card,
  CardHeader,
  ConfirmDialog,
  Dialog,
  EmptyState,
  Field,
  Input,
  SimpleTooltip,
  TBody,
  TD,
  TH,
  THead,
  TR,
  Table,
  TableSkeleton,
  useToast,
} from "../ui";
import { api, errorMessage } from "../../lib/api";
import { formatDate, formatRelativeTime } from "../../lib/format";
import { SECRET_NAME, functionSecretsKey } from "./keys";

export function SecretsCard({ isAdmin }: { isAdmin: boolean }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [toDelete, setToDelete] = useState<string | null>(null);

  const secretsQuery = useQuery({
    queryKey: functionSecretsKey,
    queryFn: () => api.get<{ secrets: EdgeFunctionSecret[] }>("/functions/secrets"),
    enabled: isAdmin,
  });
  const secrets = secretsQuery.data?.secrets ?? [];

  const remove = useMutation({
    mutationFn: (name: string) => api.delete(`/functions/secrets/${encodeURIComponent(name)}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: functionSecretsKey }),
  });

  if (!isAdmin) {
    return (
      <Card className="flex items-center gap-3">
        <Lock className="size-4 shrink-0 text-text-subtle" aria-hidden />
        <p className="text-body text-text-muted">
          Function secrets are managed by admins. Functions read them as environment variables.
        </p>
      </Card>
    );
  }

  return (
    <Card flush>
      <CardHeader
        divided
        className="[&>div:first-child]:basis-64"
        title="Secrets"
        description="Encrypted environment variables available to every function on its next invocation."
        action={
          <Button size="sm" variant="secondary" onClick={() => setDialogOpen(true)}>
            <KeyRound aria-hidden /> Add secret
          </Button>
        }
      />
      {secretsQuery.isError ? (
        <div className="p-5">
          <Alert
            variant="danger"
            title="Could not load secrets"
            action={
              <Button size="xs" variant="secondary" onClick={() => secretsQuery.refetch()}>
                <RotateCcw aria-hidden /> Retry
              </Button>
            }
          >
            {errorMessage(secretsQuery.error, "The server did not answer.")}
          </Alert>
        </div>
      ) : !secretsQuery.isPending && secrets.length === 0 ? (
        <EmptyState
          variant="bare"
          size="sm"
          icon={KeyRound}
          title="No secrets yet"
          description="Store API keys here instead of in function source."
        />
      ) : (
        <Table flush caption="Function secrets">
          <THead>
            <TR>
              <TH>Name</TH>
              <TH>Updated</TH>
              <TH className="w-px">
                <span className="sr-only">Actions</span>
              </TH>
            </TR>
          </THead>
          <TBody>
            {secretsQuery.isPending ? (
              <TableSkeleton rows={2} cols={2} />
            ) : (
              secrets.map((secret) => (
                <TR key={secret.name}>
                  <TD mono className="text-text">
                    {secret.name}
                  </TD>
                  <TD className="whitespace-nowrap text-text-muted" title={formatDate(secret.updatedAt)}>
                    {formatRelativeTime(secret.updatedAt)}
                  </TD>
                  <TD className="text-right">
                    <SimpleTooltip content="Delete secret">
                      <Button
                        variant="ghost"
                        size="icon-xs"
                        aria-label={`Delete secret ${secret.name}`}
                        loading={remove.isPending && remove.variables === secret.name}
                        onClick={() => setToDelete(secret.name)}
                      >
                        <Trash2 aria-hidden />
                      </Button>
                    </SimpleTooltip>
                  </TD>
                </TR>
              ))
            )}
          </TBody>
        </Table>
      )}
      <SecretDialog
        open={dialogOpen}
        onClose={() => setDialogOpen(false)}
        existing={secrets.map((s) => s.name)}
      />
      <ConfirmDialog
        open={toDelete !== null}
        onClose={() => setToDelete(null)}
        onConfirm={() =>
          toDelete &&
          remove.mutate(toDelete, {
            onSuccess: () => {
              toast.success(`${toDelete} deleted`);
              setToDelete(null);
            },
            onError: (e) => toast.error(errorMessage(e, "Could not delete the secret")),
          })
        }
        loading={remove.isPending}
        tone="danger"
        title={`Delete ${toDelete}?`}
        confirmLabel="Delete secret"
        body="Functions stop receiving it from their next invocation. The stored value cannot be recovered."
      />
    </Card>
  );
}

function SecretDialog({ open, onClose, existing }: { open: boolean; onClose: () => void; existing: string[] }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [name, setName] = useState("");
  const [value, setValue] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setName("");
    setValue("");
    setSubmitted(false);
    setServerError(null);
  }, [open]);

  const save = useMutation({
    mutationFn: () => api.post<{ secret: EdgeFunctionSecret }>("/functions/secrets", { name, value }),
    onSuccess: () => qc.invalidateQueries({ queryKey: functionSecretsKey }),
  });

  const nameError = !name
    ? "Enter a name."
    : !SECRET_NAME.test(name)
      ? "Use 2 to 64 uppercase letters, numbers or underscores, starting with a letter."
      : name.startsWith("SUPABASE_")
        ? "Names starting with SUPABASE_ are reserved."
        : null;
  const valueError = value ? null : "Enter a value.";
  const replacing = existing.includes(name);

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Add secret"
      description="The value is encrypted at rest and never shown again."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form="function-secret" loading={save.isPending}>
            {replacing ? "Replace secret" : "Save secret"}
          </Button>
        </>
      }
    >
      <form
        id="function-secret"
        noValidate
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          setSubmitted(true);
          setServerError(null);
          if (nameError || valueError || save.isPending) return;
          save.mutate(undefined, {
            onSuccess: () => {
              toast.success(replacing ? `${name} replaced` : `${name} saved`);
              onClose();
            },
            onError: (err) => setServerError(errorMessage(err, "Could not save the secret")),
          });
        }}
      >
        <Field
          label="Name"
          required
          hint={replacing ? "A secret with this name exists; saving replaces its value." : "For example STRIPE_SECRET_KEY."}
          error={(submitted && nameError) || serverError || undefined}
        >
          <Input
            mono
            value={name}
            onChange={(e) => setName(e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, "_"))}
            placeholder="STRIPE_SECRET_KEY"
            autoComplete="off"
            spellCheck={false}
          />
        </Field>
        <Field label="Value" required error={submitted && valueError ? valueError : undefined}>
          <Input type="password" mono value={value} onChange={(e) => setValue(e.target.value)} autoComplete="new-password" />
        </Field>
      </form>
    </Dialog>
  );
}
