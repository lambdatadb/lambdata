import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { EdgeFunction, EdgeFunctionInvocation, EdgeFunctionSecret } from "@kilndb/shared";
import { api, ApiError } from "../lib/api";
import { useAuth } from "../lib/auth";
import { PageHeader } from "../components/layout/PageShell";
import { Badge } from "../components/ui/Badge";
import { Button } from "../components/ui/Button";
import { Card, CardTitle, SectionLabel } from "../components/ui/Card";
import { ConfirmDialog } from "../components/ui/ConfirmDialog";
import { Dialog } from "../components/ui/Dialog";
import { EmptyState } from "../components/ui/EmptyState";
import { Field, Input } from "../components/ui/Input";
import { Skeleton, SkeletonRows } from "../components/ui/Skeleton";
import { StatTile } from "../components/ui/StatTile";
import { Switch } from "../components/ui/Switch";
import { Icon } from "../components/ui/Icon";
import { useToast } from "../components/ui/Toast";
import { cn } from "../components/ui/cn";
import { formatBytes, formatDate, formatRelativeTime } from "../lib/format";

export function Functions() {
  const { user } = useAuth();
  const canWrite = user?.role !== "viewer";
  const isAdmin = user?.role === "admin";
  const toast = useToast();
  const qc = useQueryClient();
  const [selectedName, setSelectedName] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [secretOpen, setSecretOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<EdgeFunction | null>(null);
  const [secretToDelete, setSecretToDelete] = useState<string | null>(null);
  const [sourceDraft, setSourceDraft] = useState("");

  const functionsQuery = useQuery({
    queryKey: ["functions"],
    queryFn: () => api.get<{ functions: EdgeFunction[] }>("/functions"),
  });
  const functions = functionsQuery.data?.functions ?? [];
  const selected = useMemo(
    () => functions.find((fn) => fn.name === selectedName) ?? functions[0] ?? null,
    [functions, selectedName],
  );

  useEffect(() => {
    if (selected && selected.name !== selectedName) setSelectedName(selected.name);
  }, [selected, selectedName]);

  const sourceQuery = useQuery({
    queryKey: ["functions", selected?.name, "source"],
    queryFn: () => api.get<{ source: string }>(`/functions/${selected!.name}/source`),
    enabled: !!selected,
  });

  useEffect(() => {
    if (sourceQuery.data?.source !== undefined) setSourceDraft(sourceQuery.data.source);
  }, [sourceQuery.data?.source]);

  const logsQuery = useQuery({
    queryKey: ["functions", selected?.name, "logs"],
    queryFn: () =>
      api.get<{ invocations: EdgeFunctionInvocation[] }>(`/functions/${selected!.name}/logs`),
    enabled: !!selected,
    refetchInterval: 10_000,
  });

  const secretsQuery = useQuery({
    queryKey: ["functions", "secrets"],
    queryFn: () => api.get<{ secrets: EdgeFunctionSecret[] }>("/functions/secrets"),
    enabled: isAdmin,
  });

  const updateFunction = useMutation({
    mutationFn: ({ name, verifyJwt }: { name: string; verifyJwt: boolean }) =>
      api.patch<{ function: EdgeFunction }>(`/functions/${name}`, { verifyJwt }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["functions"] });
      toast.show("Function updated", "success");
    },
    onError: (e) => toast.show(e instanceof ApiError ? e.message : "update failed", "error"),
  });

  const saveSource = useMutation({
    mutationFn: () =>
      api.put<{ function: EdgeFunction }>(`/functions/${selected!.name}/source`, {
        source: sourceDraft,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["functions"] });
      qc.invalidateQueries({ queryKey: ["functions", selected?.name, "source"] });
      toast.show("Source saved", "success");
    },
    onError: (e) => toast.show(e instanceof ApiError ? e.message : "save failed", "error"),
  });

  const deleteFunctionMutation = useMutation({
    mutationFn: (name: string) => api.delete(`/functions/${name}`),
    onSuccess: () => {
      setSelectedName(null);
      setDeleteTarget(null);
      qc.invalidateQueries({ queryKey: ["functions"] });
      toast.show("Function deleted", "success");
    },
    onError: (e) => toast.show(e instanceof ApiError ? e.message : "delete failed", "error"),
  });

  const deleteSecret = useMutation({
    mutationFn: (name: string) => api.delete(`/functions/secrets/${name}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["functions", "secrets"] });
      setSecretToDelete(null);
      toast.show("Secret deleted", "success");
    },
    onError: (e) => toast.show(e instanceof ApiError ? e.message : "delete failed", "error"),
  });

  const totalInvocations = functions.reduce((sum, fn) => sum + fn.invocationCount, 0);
  const avgDurationMs = (() => {
    const durations = functions.map((fn) => fn.lastDurationMs).filter((n): n is number => n != null);
    if (!durations.length) return null;
    return Math.round(durations.reduce((sum, n) => sum + n, 0) / durations.length);
  })();
  const invokeUrl = selected ? `${window.location.origin}/functions/v1/${selected.name}` : "";

  return (
    <>
      <PageHeader
        title="Functions"
        subtitle="File-backed TypeScript endpoints routed through the self-hosted KilnDB runtime."
        actions={
          canWrite && (
            <Button onClick={() => setCreateOpen(true)}>
              <Icon name="add" size={15} />
              New function
            </Button>
          )
        }
      />

      {functionsQuery.isLoading ? (
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-5">
          {Array.from({ length: 3 }, (_, i) => (
            <Card key={i} className="p-4">
              <Skeleton className="h-3 w-20" />
              <Skeleton className="mt-3 h-6 w-24" />
            </Card>
          ))}
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-5">
          <StatTile label="Functions" icon="functions" value={functions.length} />
          <StatTile label="Invocations" icon="bolt" value={totalInvocations} />
          <StatTile
            label="Last duration"
            icon="timer"
            value={avgDurationMs}
            format={(n) => `${n} ms`}
          />
        </div>
      )}

      <div className="grid grid-cols-1 xl:grid-cols-[320px_minmax(0,1fr)_360px] gap-5">
        <Card className="p-0 overflow-hidden">
          <div className="p-5 border-b border-border">
            <SectionLabel>Function registry</SectionLabel>
            <p className="text-body text-text-muted">
              Source lives under the KilnDB data directory.
            </p>
          </div>
          {functionsQuery.isLoading ? (
            <div className="p-5">
              <SkeletonRows rows={4} />
            </div>
          ) : functions.length === 0 ? (
            <EmptyState
              className="border-0 bg-transparent shadow-none"
              icon="functions"
              title="No functions yet"
              action={
                canWrite ? (
                  <Button size="sm" variant="secondary" onClick={() => setCreateOpen(true)}>
                    <Icon name="add" size={14} />
                    Create function
                  </Button>
                ) : undefined
              }
            />
          ) : (
            <div className="divide-y divide-border">
              {functions.map((fn) => (
                <button
                  key={fn.name}
                  type="button"
                  onClick={() => setSelectedName(fn.name)}
                  className={cn(
                    "w-full px-5 py-4 text-left transition-colors hover:bg-bg-subtle/50",
                    selected?.name === fn.name && "bg-bg-subtle",
                  )}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <Icon name="functions" size={17} className="text-accent" />
                        <span className="font-semibold truncate">{fn.name}</span>
                      </div>
                      <div className="mt-1 font-mono text-micro text-text-subtle">
                        {fn.invocationCount.toLocaleString()} calls · {formatBytes(fn.sourceSizeBytes)}
                      </div>
                    </div>
                    <Badge tone={fn.verifyJwt ? "accent" : "warn"}>
                      {fn.verifyJwt ? "JWT" : "Public"}
                    </Badge>
                  </div>
                </button>
              ))}
            </div>
          )}
        </Card>

        <Card className="p-0 overflow-hidden">
          {!selected ? (
            <EmptyState
              className="border-0 bg-transparent shadow-none"
              icon="functions"
              title="No function selected"
              description="Create a function to expose an endpoint."
            />
          ) : (
            <>
              <div className="p-5 border-b border-border flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <CardTitle>{selected.name}</CardTitle>
                    <Badge tone={selected.lastStatusCode && selected.lastStatusCode >= 400 ? "danger" : "success"}>
                      {selected.lastStatusCode ? selected.lastStatusCode : "idle"}
                    </Badge>
                  </div>
                  <p className="mt-1 font-mono text-label text-text-muted truncate">{invokeUrl}</p>
                </div>
                {canWrite && (
                  <div className="flex items-center gap-2 shrink-0">
                    <Button
                      variant="secondary"
                      loading={saveSource.isPending}
                      onClick={() => saveSource.mutate()}
                    >
                      <Icon name="save" size={15} />
                      Save
                    </Button>
                    <Button variant="danger" onClick={() => setDeleteTarget(selected)}>
                      <Icon name="delete" size={15} />
                    </Button>
                  </div>
                )}
              </div>

              <div className="p-5 border-b border-border grid grid-cols-1 lg:grid-cols-2 gap-4">
                <Switch
                  checked={selected.verifyJwt}
                  disabled={!canWrite || updateFunction.isPending}
                  onChange={(verifyJwt) => updateFunction.mutate({ name: selected.name, verifyJwt })}
                  label="Verify App Auth JWT"
                  description="Require Authorization: Bearer for invocations."
                />
                <div className="min-w-0">
                  <SectionLabel dot={false}>Invoke URL</SectionLabel>
                  <code className="mt-1 block truncate rounded-md border border-border bg-bg-subtle px-2.5 py-2 text-label text-text-muted">
                    {invokeUrl}
                  </code>
                </div>
              </div>

              <div className="p-5">
                <SectionLabel>Source</SectionLabel>
                {sourceQuery.isLoading ? (
                  <Skeleton className="mt-3 h-[470px] w-full" />
                ) : (
                  <textarea
                    value={sourceDraft}
                    onChange={(e) => setSourceDraft(e.target.value)}
                    spellCheck={false}
                    disabled={!canWrite}
                    className="mt-3 h-[470px] w-full resize-none rounded-md border border-border bg-[#0b0f0d] p-4 font-mono text-xs leading-5 text-text outline-none focus:border-accent disabled:opacity-70"
                  />
                )}
              </div>
            </>
          )}
        </Card>

        <div className="space-y-5">
          <Card className="p-0 overflow-hidden">
            <div className="p-5 border-b border-border flex items-center justify-between">
              <div>
                <SectionLabel>Secrets</SectionLabel>
                <p className="text-body text-text-muted">Encrypted environment variables.</p>
              </div>
              {isAdmin && (
                <Button variant="secondary" size="sm" onClick={() => setSecretOpen(true)}>
                  <Icon name="key" size={14} />
                  Add
                </Button>
              )}
            </div>
            {!isAdmin ? (
              <div className="p-5 text-body text-text-muted">Admin access required.</div>
            ) : secretsQuery.isLoading ? (
              <div className="p-5">
                <SkeletonRows rows={2} />
              </div>
            ) : (secretsQuery.data?.secrets.length ?? 0) === 0 ? (
              <div className="p-5 text-body text-text-muted">No function secrets.</div>
            ) : (
              <div className="divide-y divide-border">
                {secretsQuery.data!.secrets.map((secret) => (
                  <div key={secret.name} className="px-5 py-3 flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <div className="font-mono text-label text-text truncate">{secret.name}</div>
                      <div className="text-micro text-text-subtle">
                        Updated {formatRelativeTime(secret.updatedAt)}
                      </div>
                    </div>
                    <Button
                      variant="ghost"
                      size="sm"
                      loading={deleteSecret.isPending && deleteSecret.variables === secret.name}
                      onClick={() => setSecretToDelete(secret.name)}
                    >
                      <Icon name="delete" size={14} />
                    </Button>
                  </div>
                ))}
              </div>
            )}
          </Card>

          <Card className="p-0 overflow-hidden">
            <div className="p-5 border-b border-border">
              <SectionLabel>Invocation logs</SectionLabel>
              <p className="text-body text-text-muted">Most recent function calls.</p>
            </div>
            {!selected ? (
              <div className="p-5 text-body text-text-muted">No function selected.</div>
            ) : logsQuery.isLoading ? (
              <div className="p-5">
                <SkeletonRows rows={3} />
              </div>
            ) : (logsQuery.data?.invocations.length ?? 0) === 0 ? (
              <EmptyState
                className="border-0 bg-transparent shadow-none p-8"
                icon="bolt"
                title="No invocations yet"
                description="Calls to this function appear here."
              />
            ) : (
              <div className="divide-y divide-border max-h-[470px] overflow-auto">
                {logsQuery.data!.invocations.map((log) => (
                  <InvocationRow key={log.id} log={log} />
                ))}
              </div>
            )}
          </Card>
        </div>
      </div>

      <CreateFunctionDialog open={createOpen} onClose={() => setCreateOpen(false)} />
      <SecretDialog open={secretOpen} onClose={() => setSecretOpen(false)} />
      <ConfirmDialog
        open={!!deleteTarget}
        onClose={() => setDeleteTarget(null)}
        onConfirm={() => deleteTarget && deleteFunctionMutation.mutate(deleteTarget.name)}
        title="Delete function"
        body={
          <>
            The <span className="font-mono text-text">{deleteTarget?.name}</span> function is
            permanently deleted and its endpoint stops serving.
          </>
        }
        confirmLabel="Delete function"
        tone="danger"
        loading={deleteFunctionMutation.isPending}
      />
      <ConfirmDialog
        open={!!secretToDelete}
        onClose={() => setSecretToDelete(null)}
        onConfirm={() => secretToDelete && deleteSecret.mutate(secretToDelete)}
        title="Delete secret"
        body={
          <>
            <span className="font-mono text-text">{secretToDelete}</span> is removed from every
            function's environment on its next invocation.
          </>
        }
        confirmLabel="Delete secret"
        tone="danger"
        loading={deleteSecret.isPending}
      />
    </>
  );
}

function InvocationRow({ log }: { log: EdgeFunctionInvocation }) {
  const failed = !!log.statusCode && log.statusCode >= 400;
  return (
    <div className="p-4 space-y-2">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 min-w-0">
          <Badge tone={failed ? "danger" : "success"}>{log.statusCode ?? "—"}</Badge>
          <span className="font-mono text-label text-text-muted truncate">{log.method} {log.path}</span>
        </div>
        <span className="text-label text-text-subtle tabular-nums shrink-0">{Math.round(log.durationMs)} ms</span>
      </div>
      <div className="text-micro text-text-subtle">{formatDate(log.createdAt)}</div>
      {(log.error || log.logs) && (
        <pre className="max-h-28 overflow-auto rounded-md border border-border bg-bg-subtle p-2 text-micro text-text-muted">
          {log.error ? `${log.error}\n` : ""}{log.logs}
        </pre>
      )}
    </div>
  );
}

function CreateFunctionDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [name, setName] = useState("");
  const [verifyJwt, setVerifyJwt] = useState(true);
  const qc = useQueryClient();
  const toast = useToast();

  const create = useMutation({
    mutationFn: () => api.post<{ function: EdgeFunction }>("/functions", { name, verifyJwt }),
    onSuccess: (res) => {
      qc.invalidateQueries({ queryKey: ["functions"] });
      toast.show(`Function ${res.function.name} created`, "success");
      setName("");
      setVerifyJwt(true);
      onClose();
    },
    onError: (e) => toast.show(e instanceof ApiError ? e.message : "create failed", "error"),
  });

  return (
    <Dialog open={open} onClose={onClose} title="New function" size="md">
      <div className="space-y-4">
        <Field label="Name" required hint="lowercase letters, numbers, underscores, and hyphens">
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="stripe-webhook" />
        </Field>
        <Switch
          checked={verifyJwt}
          onChange={setVerifyJwt}
          label="Verify App Auth JWT"
          description="Public webhooks can turn this off."
        />
        <div className="flex justify-end gap-2 pt-2">
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button loading={create.isPending} onClick={() => create.mutate()}>
            Create
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

function SecretDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [name, setName] = useState("");
  const [value, setValue] = useState("");
  const qc = useQueryClient();
  const toast = useToast();

  const save = useMutation({
    mutationFn: () => api.post<{ secret: EdgeFunctionSecret }>("/functions/secrets", { name, value }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["functions", "secrets"] });
      toast.show("Secret saved", "success");
      setName("");
      setValue("");
      onClose();
    },
    onError: (e) => toast.show(e instanceof ApiError ? e.message : "save failed", "error"),
  });

  return (
    <Dialog open={open} onClose={onClose} title="Function secret" size="md">
      <div className="space-y-4">
        <Field label="Name" required>
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="STRIPE_SECRET_KEY" />
        </Field>
        <Field label="Value" required>
          <Input
            value={value}
            onChange={(e) => setValue(e.target.value)}
            type="password"
            placeholder="••••••••"
          />
        </Field>
        <div className="flex justify-end gap-2 pt-2">
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button loading={save.isPending} onClick={() => save.mutate()}>
            Save
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
