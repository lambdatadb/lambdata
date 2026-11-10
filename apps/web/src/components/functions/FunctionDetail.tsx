import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { EdgeFunction } from "@lambdata/shared";
import { Ellipsis, Lock, Trash2 } from "lucide-react";
import {
  Badge,
  Button,
  Card,
  CardHeader,
  ConfirmDialog,
  CopyableField,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  Switch,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  useToast,
} from "../ui";
import { api, absoluteUrl, errorMessage } from "../../lib/api";
import { formatRelativeTime, pluralize } from "../../lib/format";
import { InvocationLog } from "./InvocationLog";
import { SourceEditor } from "./SourceEditor";
import { functionSourceKey, functionsListKey } from "./keys";

interface Props {
  fn: EdgeFunction;
  isAdmin: boolean;
  draft: string | undefined;
  onDraftChange: (value: string | undefined) => void;
  onDeleted: () => void;
}

export function statusTone(code: number | null): "success" | "danger" | "muted" {
  if (code === null) return "muted";
  return code >= 400 ? "danger" : "success";
}

export function FunctionDetail({ fn, isAdmin, draft, onDraftChange, onDeleted }: Props) {
  const qc = useQueryClient();
  const toast = useToast();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const path = `/functions/${encodeURIComponent(fn.name)}`;

  const update = useMutation({
    mutationFn: (verifyJwt: boolean) => api.patch<{ function: EdgeFunction }>(path, { verifyJwt }),
    onSuccess: () => qc.invalidateQueries({ queryKey: functionsListKey }),
  });

  const save = useMutation({
    mutationFn: (source: string) => api.put<{ function: EdgeFunction }>(`${path}/source`, { source }),
    onSuccess: (_res, source) => {
      qc.setQueryData(functionSourceKey(fn.name), { source });
      qc.invalidateQueries({ queryKey: functionsListKey });
    },
  });

  const remove = useMutation({
    mutationFn: () => api.delete(path),
    onSuccess: () => qc.invalidateQueries({ queryKey: functionsListKey }),
  });

  return (
    <Card flush>
      <CardHeader
        divided
        title={
          <span className="flex min-w-0 flex-wrap items-center gap-2">
            <span className="truncate font-mono">{fn.name}</span>
            {fn.lastStatusCode !== null && (
              <Badge variant={statusTone(fn.lastStatusCode)} mono size="sm">
                {fn.lastStatusCode}
              </Badge>
            )}
          </span>
        }
        description={
          fn.lastInvokedAt
            ? `${pluralize(Number(fn.invocationCount) || 0, "call")} · last ${formatRelativeTime(fn.lastInvokedAt)}${fn.lastDurationMs !== null ? ` in ${Math.round(Number(fn.lastDurationMs))} ms` : ""}`
            : "Not called yet"
        }
        action={
          isAdmin ? (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon-sm" aria-label={`Actions for ${fn.name}`}>
                  <Ellipsis aria-hidden />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem variant="danger" onSelect={() => setConfirmDelete(true)}>
                  <Trash2 aria-hidden /> Delete function
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          ) : undefined
        }
      />
      <div className="grid gap-4 border-b border-border px-5 py-4 xl:grid-cols-[minmax(0,1fr)_auto] xl:items-end">
        <CopyableField label="Invoke URL" value={absoluteUrl(`/functions/v1/${fn.name}`)} copyLabel="invoke URL" />
        <Switch
          checked={fn.verifyJwt}
          disabled={!isAdmin || update.isPending}
          onCheckedChange={(verifyJwt) =>
            update.mutate(verifyJwt, {
              onSuccess: () =>
                toast.success(verifyJwt ? `${fn.name} requires a token` : `${fn.name} is public`, {
                  description: verifyJwt ? undefined : "Anyone who knows the URL can call it.",
                }),
              onError: (e) => toast.error(errorMessage(e, "Could not update the function")),
            })
          }
          label="Require an App Auth token"
          className="xl:pb-2"
        />
      </div>
      {isAdmin ? (
        <Tabs defaultValue="source" className="gap-0">
          <TabsList aria-label={`${fn.name} sections`} className="px-3">
            <TabsTrigger value="source">
              Source
              {draft !== undefined && <span className="size-1.5 rounded-full bg-warn" aria-label="unsaved changes" />}
            </TabsTrigger>
            <TabsTrigger value="logs">Invocations</TabsTrigger>
          </TabsList>
          <TabsContent value="source" className="p-5">
            <SourceEditor
              fn={fn}
              isAdmin={isAdmin}
              draft={draft}
              saving={save.isPending}
              onDraftChange={onDraftChange}
              onSave={(source) =>
                save.mutate(source, {
                  onSuccess: () => {
                    onDraftChange(undefined);
                    toast.success(`${fn.name} saved`);
                  },
                  onError: (e) => toast.error(errorMessage(e, "Could not save the source")),
                })
              }
            />
          </TabsContent>
          <TabsContent value="logs">
            <InvocationLog name={fn.name} />
          </TabsContent>
        </Tabs>
      ) : (
        <div className="flex items-start gap-3 px-5 py-4 text-body text-text-muted">
          <Lock aria-hidden className="mt-0.5 size-4 shrink-0 text-text-subtle" />
          <p>
            Source and invocation logs are visible to admins only: the source can hold business logic and the logs can hold
            request data. Ask an admin if you need to see them.
          </p>
        </div>
      )}
      <ConfirmDialog
        open={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        onConfirm={() =>
          remove.mutate(undefined, {
            onSuccess: () => {
              toast.success(`${fn.name} deleted`);
              setConfirmDelete(false);
              onDraftChange(undefined);
              onDeleted();
            },
            onError: (e) => toast.error(errorMessage(e, "Could not delete the function")),
          })
        }
        loading={remove.isPending}
        tone="danger"
        challenge={fn.name}
        title={`Delete ${fn.name}?`}
        confirmLabel="Delete function"
        body="Its source and invocation history are removed and the endpoint stops answering. This cannot be undone."
      />
    </Card>
  );
}
