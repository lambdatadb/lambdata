import { useState, type ReactNode } from "react";
import { ChevronDown, Database as DatabaseIcon, KeyRound, ListChecks, Pencil, Send, Trash2, TriangleAlert, X } from "lucide-react";
import type { NotificationCatalogResponse, NotificationDestination, NotificationTestResponse } from "@lambdata/shared";
import { Alert, Badge, Button, Card, Spinner, StatusDot, Switch, cn } from "../ui";
import { errorMessage } from "../../lib/api";
import { formatDate, formatRelativeTime, pluralize } from "../../lib/format";
import { priorityLabel } from "./ConnectionFields";
import { Deliveries } from "./Deliveries";
import { KINDS, anyPerDatabase, healthView, testOutcome } from "./model";
import { KindTile } from "./parts";

export type TestState =
  | { status: "running" }
  | { status: "done"; result: NotificationTestResponse }
  | { status: "error"; error: unknown };

export function scopeText(dest: NotificationDestination, names: Map<string, string>, catalog: NotificationCatalogResponse | null | undefined): string {
  if (catalog && !anyPerDatabase(catalog, dest.events)) return "No database events";
  if (dest.databaseIds === null) return "All databases";
  if (dest.databaseIds.length === 0) return "No databases";
  const known = dest.databaseIds.map((id) => names.get(id)).filter((n): n is string => !!n);
  if (dest.databaseIds.length <= 2 && known.length === dest.databaseIds.length) return known.join(", ");
  return pluralize(dest.databaseIds.length, "database");
}

export function eventsText(dest: NotificationDestination, catalog: NotificationCatalogResponse | null | undefined): string {
  const total = catalog?.events.length;
  if (total && dest.events.length === total) return "All events";
  return total ? `${dest.events.length} of ${total} events` : pluralize(dest.events.length, "event");
}

function Fact({ icon: Icon, children }: { icon: typeof ListChecks; children: ReactNode }) {
  return (
    <span className="inline-flex min-w-0 items-center gap-1.5">
      <Icon aria-hidden className="size-3.5 shrink-0 text-text-subtle" />
      <span className="min-w-0 truncate">{children}</span>
    </span>
  );
}

function Dismissible({ children, onDismiss }: { children: ReactNode; onDismiss: () => void }) {
  return (
    <div className="relative [&>div]:pr-11">
      {children}
      <Button size="icon-xs" variant="ghost" aria-label="Dismiss the test result" onClick={onDismiss} className="absolute right-2 top-2">
        <X />
      </Button>
    </div>
  );
}

export function TestResult({ state, onDismiss }: { state: TestState; onDismiss: () => void }) {
  if (state.status === "running") {
    return (
      <p className="flex items-center gap-2 text-label text-text-muted" role="status">
        <Spinner size="sm" decorative /> Sending a test message. This waits up to 10 seconds for an answer.
      </p>
    );
  }
  if (state.status === "error") {
    return (
      <Dismissible onDismiss={onDismiss}>
        <Alert variant="warning" title="Could not send the test" data-test-result="error">
          {errorMessage(state.error)}
        </Alert>
      </Dismissible>
    );
  }
  const outcome = testOutcome(state.result);
  if (outcome.ok) {
    return (
      <Dismissible onDismiss={onDismiss}>
        <Alert variant="success" title={outcome.title} data-test-result="ok" role="status">
          {outcome.detail}
        </Alert>
      </Dismissible>
    );
  }
  return (
    <Dismissible onDismiss={onDismiss}>
      <Alert variant="warning" title={outcome.title} data-test-result="failed" role="alert">
        <span className="block font-mono text-code text-text [overflow-wrap:anywhere]">{outcome.detail}</span>
        {outcome.hint && <span className="mt-1 block">{outcome.hint}</span>}
      </Alert>
    </Dismissible>
  );
}

export interface DestinationCardProps {
  dest: NotificationDestination;
  catalog: NotificationCatalogResponse | null | undefined;
  databaseNames: Map<string, string>;
  test?: TestState;
  toggling?: boolean;
  defaultShowDeliveries?: boolean;
  onTest: () => void;
  onDismissTest: () => void;
  onToggle: (enabled: boolean) => void;
  onEdit: () => void;
  onDelete: () => void;
}

export function DestinationCard({
  dest,
  catalog,
  databaseNames,
  test,
  toggling = false,
  defaultShowDeliveries = false,
  onTest,
  onDismissTest,
  onToggle,
  onEdit,
  onDelete,
}: DestinationCardProps) {
  const [showDeliveries, setShowDeliveries] = useState(defaultShowDeliveries);
  const health = healthView(dest);
  const failing = dest.health === "failing" && dest.enabled;
  const deliveriesId = `deliveries-${dest.id}`;

  return (
    <li>
      <Card
        flush
        className={cn(failing && "border-warn/45")}
        data-destination={dest.id}
        data-health={dest.health}
        aria-label={`${dest.name}, ${KINDS[dest.kind].label}`}
        role="group"
      >
        {failing && <span aria-hidden className="absolute inset-y-0 left-0 w-[3px] bg-warn" />}
        <div className="space-y-3 px-4 py-4 sm:px-5">
          <div className="flex items-start gap-3">
            <KindTile kind={dest.kind} tone={failing ? "warn" : dest.enabled ? "default" : "muted"} />
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <h3 className={cn("min-w-0 text-heading font-semibold [overflow-wrap:anywhere]", dest.enabled ? "text-text" : "text-text-muted")}>
                  {dest.name}
                </h3>
                <Badge variant="muted" size="sm">
                  {KINDS[dest.kind].label}
                </Badge>
                {failing && (
                  <Badge variant="warn" size="sm" dot>
                    failing
                  </Badge>
                )}
                {!dest.enabled && (
                  <Badge variant="outline" size="sm">
                    paused
                  </Badge>
                )}
              </div>
              <p className="mt-0.5 truncate font-mono text-code text-text-muted" title={dest.target}>
                {dest.target}
              </p>
            </div>
            <div className="flex shrink-0 items-center gap-2 pt-0.5">
              <span aria-hidden className="hidden text-label text-text-muted sm:inline">
                {dest.enabled ? "On" : "Off"}
              </span>
              <Switch checked={dest.enabled} onCheckedChange={onToggle} disabled={toggling} aria-label={`Send to ${dest.name}`} />
            </div>
          </div>

          <div className="flex flex-wrap gap-x-4 gap-y-1 text-label text-text-muted">
            <Fact icon={ListChecks}>{eventsText(dest, catalog)}</Fact>
            <Fact icon={DatabaseIcon}>{scopeText(dest, databaseNames, catalog)}</Fact>
            {dest.kind === "webhook" && (
              <Fact icon={KeyRound}>
                {dest.hasSecret ? "Signed" : "Not signed"}
                {dest.headerNames.length > 0 ? ` · ${pluralize(dest.headerNames.length, "header")}` : ""}
              </Fact>
            )}
            {dest.kind === "ntfy" && (
              <Fact icon={KeyRound}>
                {dest.hasSecret ? "Token" : "No token"} · priority {priorityLabel(dest.ntfyPriority).toLowerCase()}
              </Fact>
            )}
          </div>

          {failing ? (
            <div className="flex items-start gap-2 rounded-md border border-warn/30 bg-warn/[0.06] px-3 py-2 text-label" data-health-line="failing">
              <TriangleAlert aria-hidden className="mt-px size-3.5 shrink-0 text-warn" />
              <div className="min-w-0 space-y-0.5">
                <p className="text-text">
                  <span className="font-medium text-warn">{health.label}</span>
                  {health.at && (
                    <span className="text-text-muted" title={formatDate(health.at)}>
                      {" "}
                      · last tried {formatRelativeTime(health.at)}
                    </span>
                  )}
                </p>
                {health.detail && <p className="font-mono text-code text-text [overflow-wrap:anywhere]">{health.detail}</p>}
                <p className="text-text-muted">LambData keeps trying. Fix the address or the receiving end, then send a test.</p>
              </div>
            </div>
          ) : !dest.enabled ? (
            <p className="flex items-start gap-2 text-label text-text-muted" data-health-line="paused">
              <StatusDot tone="muted" className="mt-1.5" />
              <span>
                Paused. Events that happen while it is off are not sent later.
                {dest.lastSuccessAt && (
                  <span className="text-text-subtle" title={formatDate(dest.lastSuccessAt)}>
                    {" "}
                    Last delivered {formatRelativeTime(dest.lastSuccessAt)}.
                  </span>
                )}
              </span>
            </p>
          ) : (
            <p className="flex items-start gap-2 text-label text-text-muted" data-health-line={health.tone === "warn" ? "recent-failure" : dest.health}>
              <StatusDot tone={health.tone} className="mt-1.5" />
              {health.tone === "muted" ? (
                <span>Nothing delivered yet. Send a test to check that messages arrive.</span>
              ) : (
                <span className="min-w-0">
                  <span className={health.tone === "warn" ? "text-warn" : undefined}>{health.label}</span>
                  {health.at && <span title={formatDate(health.at)}> {formatRelativeTime(health.at)}</span>}
                  {health.tone === "warn" && health.detail && (
                    <span className="font-mono text-code text-text [overflow-wrap:anywhere]"> · {health.detail}</span>
                  )}
                </span>
              )}
            </p>
          )}

          <div className="flex flex-wrap items-center gap-2">
            <Button variant="secondary" size="xs" onClick={onTest} loading={test?.status === "running"}>
              <Send aria-hidden /> Send test
            </Button>
            <Button
              variant="ghost"
              size="xs"
              aria-expanded={showDeliveries}
              aria-controls={deliveriesId}
              onClick={() => setShowDeliveries((v) => !v)}
            >
              <span className="sm:hidden">Deliveries</span>
              <span className="hidden sm:inline">Recent deliveries</span>
              <ChevronDown aria-hidden className={cn("transition-transform", showDeliveries && "rotate-180")} />
            </Button>
            <div className="ml-auto flex items-center gap-1">
              <Button variant="ghost" size="xs" onClick={onEdit} aria-label={`Edit ${dest.name}`}>
                <Pencil aria-hidden />
                <span className="hidden sm:inline">Edit</span>
              </Button>
              <Button variant="ghost" size="icon-xs" aria-label={`Delete ${dest.name}`} onClick={onDelete}>
                <Trash2 />
              </Button>
            </div>
          </div>

          {test && <TestResult state={test} onDismiss={onDismissTest} />}
        </div>
        {showDeliveries && (
          <div id={deliveriesId}>
            <Deliveries destinationId={dest.id} catalog={catalog} />
          </div>
        )}
      </Card>
    </li>
  );
}
