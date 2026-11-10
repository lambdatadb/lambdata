import { RotateCw } from "lucide-react";
import type { NotificationCatalogResponse, NotificationDelivery } from "@lambdata/shared";
import { Badge, Button, SkeletonRows, Spinner } from "../ui";
import { QueryError } from "../layout/QueryError";
import { formatDate, formatRelativeTime, pluralize } from "../../lib/format";
import { DELIVERY_LIMIT, DELIVERY_STATUS, eventLabel, hasPending, useDeliveries } from "./model";

export function retryText(at: number | null, now = Date.now()): string {
  if (!at) return "waiting to retry";
  const ms = at - now;
  if (ms <= 1_000) return "retrying now";
  if (ms < 60_000) return `retry in ${Math.ceil(ms / 1_000)}s`;
  if (ms < 3_600_000) return `retry in ${Math.ceil(ms / 60_000)}m`;
  return `retry in ${Math.round(ms / 3_600_000)}h`;
}

export function deliveryWhen(d: NotificationDelivery, now = Date.now()): { text: string; at: number } {
  if (d.status === "sent" && d.sentAt) return { text: formatRelativeTime(d.sentAt), at: d.sentAt };
  if (d.status === "queued" && d.attempts > 0) return { text: retryText(d.nextAttemptAt, now), at: d.nextAttemptAt ?? d.createdAt };
  if (d.status === "queued") return { text: "waiting to send", at: d.createdAt };
  if (d.status === "sending") return { text: "sending now", at: d.createdAt };
  return { text: formatRelativeTime(d.createdAt), at: d.createdAt };
}

export function DeliveryRow({ delivery, catalog }: { delivery: NotificationDelivery; catalog: NotificationCatalogResponse | null | undefined }) {
  const meta = DELIVERY_STATUS[delivery.status];
  const when = deliveryWhen(delivery);
  const facts = [
    eventLabel(catalog, delivery.eventType),
    delivery.attempts > 0 ? pluralize(delivery.attempts, "attempt") : "not tried yet",
    delivery.status === "sent" && delivery.responseStatus ? `HTTP ${delivery.responseStatus}` : null,
  ].filter(Boolean);
  return (
    <li
      className="grid grid-cols-[4.75rem_minmax(0,1fr)] gap-x-3 gap-y-0.5 px-4 py-2.5 sm:grid-cols-[5.25rem_minmax(0,1fr)_auto] sm:px-5"
      data-delivery-status={delivery.status}
    >
      <div className="pt-px">
        <Badge variant={meta.tone} size="sm" dot>
          {meta.label}
        </Badge>
      </div>
      <div className="min-w-0">
        <p className="truncate text-body text-text" title={delivery.title}>
          {delivery.title}
        </p>
        <p className="text-micro text-text-subtle">{facts.join(" · ")}</p>
        {delivery.lastError && delivery.status !== "sent" && (
          <p className={delivery.status === "failed" ? "font-mono text-micro text-warn [overflow-wrap:anywhere]" : "font-mono text-micro text-text-muted [overflow-wrap:anywhere]"}>
            {delivery.lastError}
          </p>
        )}
      </div>
      <time className="col-start-2 text-micro text-text-subtle sm:col-start-auto sm:pt-0.5 sm:text-right" dateTime={new Date(when.at).toISOString()} title={formatDate(when.at)}>
        {when.text}
      </time>
    </li>
  );
}

export function DeliveryList({ deliveries, catalog }: { deliveries: NotificationDelivery[]; catalog: NotificationCatalogResponse | null | undefined }) {
  if (deliveries.length === 0) {
    return <p className="px-4 pb-4 text-label text-text-muted sm:px-5">Nothing sent yet. Send a test to check that messages arrive.</p>;
  }
  return (
    <>
      <ul className="divide-y divide-border border-t border-border">
        {deliveries.map((d) => (
          <DeliveryRow key={d.id} delivery={d} catalog={catalog} />
        ))}
      </ul>
      {deliveries.length >= DELIVERY_LIMIT && (
        <p className="border-t border-border px-4 py-2 text-micro text-text-subtle sm:px-5">The latest {DELIVERY_LIMIT}. LambData keeps up to 200 per destination for 14 days.</p>
      )}
    </>
  );
}

export function Deliveries({ destinationId, catalog }: { destinationId: string; catalog: NotificationCatalogResponse | null | undefined }) {
  const query = useDeliveries(destinationId, true);
  const pending = hasPending(query.data);
  return (
    <div className="border-t border-border" data-deliveries={destinationId}>
      <div className="flex min-h-11 flex-wrap items-center justify-between gap-x-3 gap-y-1 px-4 py-2 sm:px-5">
        <h4 className="text-label font-medium text-text-muted">Recent deliveries</h4>
        <div className="flex items-center gap-2 text-micro text-text-subtle">
          {pending && (
            <span className="inline-flex items-center gap-1.5" role="status">
              <Spinner size="xs" decorative /> Checking every few seconds
            </span>
          )}
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label="Refresh deliveries"
            onClick={() => void query.refetch()}
            loading={query.isFetching && !query.isPending}
          >
            <RotateCw />
          </Button>
        </div>
      </div>
      {query.isPending ? (
        <div className="px-4 pb-4 sm:px-5">
          <SkeletonRows rows={3} />
        </div>
      ) : query.isError ? (
        <div className="px-4 pb-4 sm:px-5">
          <QueryError error={query.error} title="Could not load the deliveries" onRetry={query.refetch} retrying={query.isFetching} />
        </div>
      ) : (
        <DeliveryList deliveries={query.data} catalog={catalog} />
      )}
    </div>
  );
}
