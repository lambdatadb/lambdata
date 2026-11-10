import { useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Plus, ShieldCheck } from "lucide-react";
import type { NotificationDestination, NotificationKind, NotificationTestResponse } from "@lambdata/shared";
import { PageHeader } from "../components/layout/PageShell";
import { QueryError } from "../components/layout/QueryError";
import { DestinationCard, type TestState } from "../components/notifications/DestinationCard";
import { DestinationDialog } from "../components/notifications/DestinationDialog";
import { GetStarted } from "../components/notifications/GetStarted";
import {
  isKind,
  notificationKeys,
  overallState,
  testDestination,
  useDestinationMutations,
  useDestinations,
  useNotificationCatalog,
} from "../components/notifications/model";
import { Alert, Badge, Button, Card, ConfirmDialog, EmptyState, SkeletonRows, toast } from "../components/ui";
import { errorMessage } from "../lib/api";
import { useIsAdmin } from "../lib/auth";
import { useDatabases } from "../lib/queries";

const SUBTITLE = "Optional messages to Discord, Slack, ntfy or your own webhook when something happens on this server.";

function StateBadge({ state }: { state: ReturnType<typeof overallState> }) {
  if (state === "on")
    return (
      <Badge variant="success" dot>
        on
      </Badge>
    );
  if (state === "paused")
    return (
      <Badge variant="outline" dot>
        paused
      </Badge>
    );
  return (
    <Badge variant="muted" dot>
      off
    </Badge>
  );
}

function useTestRunner() {
  const qc = useQueryClient();
  const [state, setState] = useState<Record<string, TestState>>({});
  const mutation = useMutation({
    mutationFn: (id: string) => testDestination(id),
    onMutate: (id) => setState((s) => ({ ...s, [id]: { status: "running" } })),
    onSuccess: (result: NotificationTestResponse, id) => setState((s) => ({ ...s, [id]: { status: "done", result } })),
    onError: (error, id) => setState((s) => ({ ...s, [id]: { status: "error", error } })),
    onSettled: (_data, _error, id) => {
      void qc.invalidateQueries({ queryKey: notificationKeys.deliveries(id) });
      void qc.invalidateQueries({ queryKey: notificationKeys.destinations });
    },
  });
  const dismiss = (id: string) =>
    setState((s) => {
      const next = { ...s };
      delete next[id];
      return next;
    });
  return { state, run: (id: string) => mutation.mutate(id), dismiss };
}

export function Notifications() {
  const isAdmin = useIsAdmin();
  const [params, setParams] = useSearchParams();
  const catalogQuery = useNotificationCatalog({ enabled: isAdmin });
  const catalog = catalogQuery.data;
  const destinationsQuery = useDestinations({ enabled: isAdmin && !!catalog, poll: 15_000 });
  const destinations = destinationsQuery.data;
  const databases = useDatabases({ enabled: isAdmin });
  const { update, remove } = useDestinationMutations();
  const tests = useTestRunner();
  const [editing, setEditing] = useState<{ dest: NotificationDestination; open: boolean } | null>(null);
  const [deleting, setDeleting] = useState<NotificationDestination | null>(null);
  const [toggling, setToggling] = useState<Set<string>>(() => new Set());

  const addParam = params.get("add");
  const adding = addParam !== null;
  const addKind = isKind(addParam) ? addParam : null;

  const databaseNames = useMemo(() => new Map((databases.data ?? []).map((d) => [d.id, d.displayName])), [databases.data]);

  const openAdd = (kind: NotificationKind | null) => {
    setEditing(null);
    setParams(
      (p) => {
        const next = new URLSearchParams(p);
        next.set("add", kind ?? "");
        return next;
      },
      { replace: false },
    );
  };

  const closeDialog = () => {
    if (adding) {
      setParams(
        (p) => {
          const next = new URLSearchParams(p);
          next.delete("add");
          return next;
        },
        { replace: true },
      );
    }
    setEditing((e) => (e ? { ...e, open: false } : e));
  };

  const onSaved = (dest: NotificationDestination, created: boolean) => {
    closeDialog();
    if (created) {
      toast.success(`${dest.name} added`, {
        description: dest.enabled ? "Send a test to check that messages arrive." : undefined,
        action: { label: "Send test", onClick: () => tests.run(dest.id) },
      });
    } else {
      toast.success("Changes saved");
    }
  };

  const toggle = async (dest: NotificationDestination, enabled: boolean) => {
    setToggling((s) => new Set(s).add(dest.id));
    try {
      await update.mutateAsync({ id: dest.id, body: { enabled } });
      toast.success(enabled ? `${dest.name} is on` : `${dest.name} is paused`, {
        description: enabled ? undefined : "Events that happen while it is paused are not sent later.",
      });
    } catch (error) {
      toast.error(enabled ? `Could not turn on ${dest.name}` : `Could not pause ${dest.name}`, { description: errorMessage(error) });
    } finally {
      setToggling((s) => {
        const next = new Set(s);
        next.delete(dest.id);
        return next;
      });
    }
  };

  const confirmDelete = () => {
    if (!deleting) return;
    const target = deleting;
    remove.mutate(target.id, {
      onSuccess: () => {
        setDeleting(null);
        tests.dismiss(target.id);
        toast.success(`${target.name} deleted`);
      },
      onError: (error) => toast.error(`Could not delete ${target.name}`, { description: errorMessage(error) }),
    });
  };

  if (!isAdmin) {
    return (
      <>
        <PageHeader title="Notifications" subtitle={SUBTITLE} />
        <EmptyState
          icon={ShieldCheck}
          title="Admins only"
          description="Notifications are set up by admins. Ask one if you want messages about this server."
        />
      </>
    );
  }

  const hasDestinations = (destinations?.length ?? 0) > 0;
  const enabledCount = destinations?.filter((d) => d.enabled).length ?? 0;
  const dialogMode = adding ? "add" : editing ? "edit" : "add";

  return (
    <>
      <PageHeader
        title="Notifications"
        subtitle={SUBTITLE}
        badges={destinations ? <StateBadge state={overallState(destinations)} /> : undefined}
        actions={
          hasDestinations ? (
            <Button onClick={() => openAdd(null)}>
              <Plus aria-hidden /> Add destination
            </Button>
          ) : undefined
        }
      />

      {catalogQuery.isPending || (catalog && destinationsQuery.isPending) ? (
        <Card>
          <SkeletonRows rows={4} label="Loading notifications" />
        </Card>
      ) : catalogQuery.isError ? (
        <QueryError error={catalogQuery.error} title="Could not load notifications" onRetry={catalogQuery.refetch} retrying={catalogQuery.isFetching} />
      ) : !catalog ? (
        <Alert variant="warning" title="This server does not send notifications yet">
          The API is older than this console. Update LambData and reload.
        </Alert>
      ) : destinationsQuery.isError && !destinations ? (
        <QueryError
          error={destinationsQuery.error}
          title="Could not load the destinations"
          onRetry={destinationsQuery.refetch}
          retrying={destinationsQuery.isFetching}
        />
      ) : !hasDestinations ? (
        <GetStarted onPick={openAdd} />
      ) : (
        <section aria-labelledby="destinations-title" className="space-y-3">
          {destinationsQuery.isError && (
            <QueryError
              error={destinationsQuery.error}
              title="Could not refresh the destinations; showing what was last read"
              onRetry={destinationsQuery.refetch}
              retrying={destinationsQuery.isFetching}
            />
          )}
          <div className="space-y-0.5">
            <h2 id="destinations-title" className="text-heading font-semibold text-text">
              Destinations
            </h2>
            <p className="text-body text-text-muted">
              {enabledCount === destinations!.length
                ? destinations!.length === 1
                  ? "Sending to one destination."
                  : `Sending to all ${destinations!.length}.`
                : `${enabledCount} of ${destinations!.length} on.`}{" "}
              Each one gets only the events picked for it.
            </p>
          </div>
          <ul className="space-y-3">
            {destinations!.map((dest) => (
              <DestinationCard
                key={dest.id}
                dest={dest}
                catalog={catalog}
                databaseNames={databaseNames}
                test={tests.state[dest.id]}
                toggling={toggling.has(dest.id)}
                onTest={() => tests.run(dest.id)}
                onDismissTest={() => tests.dismiss(dest.id)}
                onToggle={(enabled) => void toggle(dest, enabled)}
                onEdit={() => setEditing({ dest, open: true })}
                onDelete={() => setDeleting(dest)}
              />
            ))}
          </ul>
          <div className="space-y-1.5 pt-2 text-label text-text-muted">
            <p className="flex items-start gap-2">
              <ShieldCheck aria-hidden className="mt-px size-4 shrink-0 text-text-subtle" />
              <span>
                Messages carry names, short hashes, counts and who did it. Never row data, passwords, connection strings or email addresses.
              </span>
            </p>
            <p className="pl-6">
              A destination gets at most 20 messages a minute; a burst beyond that arrives as one summary. Failed messages are retried with
              growing pauses for over an hour.
            </p>
          </div>
        </section>
      )}

      {catalog && (
        <DestinationDialog
          open={adding || !!editing?.open}
          mode={dialogMode}
          initialKind={addKind}
          destination={dialogMode === "edit" ? (editing?.dest ?? null) : null}
          catalog={catalog}
          onClose={closeDialog}
          onSaved={onSaved}
        />
      )}

      <ConfirmDialog
        open={!!deleting}
        onClose={() => !remove.isPending && setDeleting(null)}
        onConfirm={confirmDelete}
        tone="danger"
        loading={remove.isPending}
        title={deleting ? `Delete ${deleting.name}?` : "Delete destination?"}
        description="LambData stops sending to it and forgets its address, secrets and delivery history. Messages already delivered stay where they are."
        confirmLabel="Delete destination"
      />
    </>
  );
}
