import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import type { EdgeFunction } from "@lambdata/shared";
import { CircleAlert, Plus, RotateCcw, SquareFunction, Zap } from "lucide-react";
import { api, errorMessage } from "../lib/api";
import { useAuth } from "../lib/auth";
import { PageHeader } from "../components/layout/PageShell";
import { Alert, Button, Card, CardHeader, EmptyState, Skeleton, StatTile, StatusDot, cn } from "../components/ui";
import { CreateFunctionDialog } from "../components/functions/CreateFunctionDialog";
import { FunctionDetail, statusTone } from "../components/functions/FunctionDetail";
import { SecretsCard } from "../components/functions/SecretsCard";
import { functionsListKey } from "../components/functions/keys";
import { pluralize } from "../lib/format";

export function Functions() {
  const { user } = useAuth();
  const isAdmin = user?.role === "admin";
  const [createOpen, setCreateOpen] = useState(false);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [params, setParams] = useSearchParams();

  const functionsQuery = useQuery({
    queryKey: functionsListKey,
    queryFn: () => api.get<{ functions: EdgeFunction[] }>("/functions"),
  });
  const functions = functionsQuery.data?.functions ?? [];
  const selected = functions.find((fn) => fn.name === params.get("fn")) ?? functions[0] ?? null;
  const loading = functionsQuery.isPending;
  const unsaved = Object.keys(drafts).length;

  useEffect(() => {
    if (unsaved === 0) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [unsaved]);

  const select = (name: string | null) => {
    const next = new URLSearchParams(params);
    if (name) next.set("fn", name);
    else next.delete("fn");
    setParams(next, { replace: true });
  };

  const setDraft = (name: string, value: string | undefined) =>
    setDrafts((current) => {
      const next = { ...current };
      if (value === undefined) delete next[name];
      else next[name] = value;
      return next;
    });

  const totalCalls = functions.reduce((sum, fn) => sum + (Number(fn.invocationCount) || 0), 0);
  const failing = functions.filter((fn) => fn.lastStatusCode !== null && fn.lastStatusCode >= 400).length;

  return (
    <>
      <PageHeader
        title="Functions"
        subtitle="TypeScript endpoints served by the LambData runtime, with source kept in the data directory."
        actions={
          isAdmin ? (
            <Button onClick={() => setCreateOpen(true)}>
              <Plus aria-hidden /> New function
            </Button>
          ) : undefined
        }
      />
      <div className="space-y-5">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          <StatTile label="Functions" icon={SquareFunction} loading={loading} value={functionsQuery.data ? functions.length : null} />
          <StatTile label="Calls, all time" icon={Zap} loading={loading} value={functionsQuery.data ? totalCalls : null} />
          <StatTile
            label="Last call failed"
            className="col-span-2 sm:col-span-1"
            icon={CircleAlert}
            loading={loading}
            value={functionsQuery.data ? failing : null}
            hint={functionsQuery.data ? (failing === 0 ? "every function answered" : "returned a 4xx or 5xx") : undefined}
          />
        </div>

        {functionsQuery.isError ? (
          <Alert
            variant="danger"
            title="Could not load functions"
            action={
              <Button size="xs" variant="secondary" onClick={() => functionsQuery.refetch()}>
                <RotateCcw aria-hidden /> Retry
              </Button>
            }
          >
            {errorMessage(functionsQuery.error, "The server did not answer.")}
          </Alert>
        ) : loading ? (
          <div className="grid gap-5 lg:grid-cols-[16rem_minmax(0,1fr)]" aria-busy="true">
            <Card className="space-y-4">
              {Array.from({ length: 3 }, (_, i) => (
                <div key={i} className="space-y-1.5">
                  <Skeleton className="h-4 w-32" />
                  <Skeleton className="h-3 w-20" />
                </div>
              ))}
            </Card>
            <Card className="space-y-4">
              <Skeleton className="h-5 w-40" />
              <Skeleton className="h-9 w-full" />
              <Skeleton className="h-64 w-full" />
            </Card>
          </div>
        ) : functions.length === 0 ? (
          <EmptyState
            icon={SquareFunction}
            title="No functions yet"
            description={
              isAdmin
                ? "Create a function to get an HTTPS endpoint that runs your TypeScript, with App Auth and secrets built in."
                : "Only admins can create functions and edit their source. Ask an admin to add one; you can then see its calls here."
            }
            action={
              isAdmin ? (
                <Button size="sm" variant="secondary" onClick={() => setCreateOpen(true)}>
                  <Plus aria-hidden /> New function
                </Button>
              ) : undefined
            }
          />
        ) : (
          <div className="grid items-start gap-5 lg:grid-cols-[16rem_minmax(0,1fr)]">
            <Card flush>
              <CardHeader divided title="Functions" />
              <nav aria-label="Functions">
                <ul className="space-y-0.5 p-2">
                  {functions.map((fn) => {
                    const active = fn.name === selected?.name;
                    const next = new URLSearchParams(params);
                    next.set("fn", fn.name);
                    return (
                      <li key={fn.name}>
                        <Link
                          to={`?${next.toString()}`}
                          replace
                          aria-current={active ? "page" : undefined}
                          className={cn(
                            "relative flex items-center gap-2.5 rounded-md px-2.5 py-2 text-text-muted outline-none transition-colors hover:bg-bg-hover hover:text-text focus-visible:ring-2 focus-visible:ring-ring/70",
                            active &&
                              "bg-bg-selected text-text before:absolute before:left-0 before:top-2 before:h-[calc(100%-1rem)] before:w-0.5 before:rounded-full before:bg-accent",
                          )}
                        >
                          <StatusDot
                            tone={statusTone(fn.lastStatusCode)}
                            label={fn.lastStatusCode === null ? "not called yet" : `last call returned ${fn.lastStatusCode}`}
                          />
                          <span className="min-w-0 flex-1">
                            <span className="block truncate font-mono text-code">{fn.name}</span>
                            <span className="block truncate text-micro text-text-subtle">
                              {pluralize(Number(fn.invocationCount) || 0, "call")} · {fn.verifyJwt ? "token required" : "public"}
                            </span>
                          </span>
                          {drafts[fn.name] !== undefined && (
                            <span className="size-1.5 shrink-0 rounded-full bg-warn" aria-label="unsaved changes" />
                          )}
                        </Link>
                      </li>
                    );
                  })}
                </ul>
              </nav>
            </Card>
            {selected && (
              <FunctionDetail
                key={selected.name}
                fn={selected}
                isAdmin={isAdmin}
                draft={drafts[selected.name]}
                onDraftChange={(value) => setDraft(selected.name, value)}
                onDeleted={() => select(null)}
              />
            )}
          </div>
        )}

        <SecretsCard isAdmin={isAdmin} />
      </div>
      <CreateFunctionDialog open={createOpen} onClose={() => setCreateOpen(false)} onCreated={(fn) => select(fn.name)} />
    </>
  );
}
