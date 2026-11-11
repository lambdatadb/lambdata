import { useState } from "react";
import { Link } from "react-router-dom";
import { ChevronRight, MessageSquareQuote } from "lucide-react";
import type { TokenActivityEntry } from "@lambdata/shared";
import { Badge } from "../ui/Badge";
import { Button } from "../ui/Button";
import { CodeBlock } from "../ui/CodeBlock";
import { cn } from "../ui/cn";
import { databasePath } from "../../lib/commands";
import { formatDate, formatRelativeTime } from "../../lib/format";
import { outcomeView } from "../../lib/accessTokens";
import { ViaBadge } from "./parts";

export function ActivityRow({ entry, initiallyOpen = false }: { entry: TokenActivityEntry; initiallyOpen?: boolean }) {
  const [open, setOpen] = useState(initiallyOpen);
  const outcome = outcomeView(entry.outcome);
  const detailId = `activity-detail-${entry.id}`;
  return (
    <li className="border-b border-border px-4 py-3 last:border-b-0 sm:px-5" data-activity={entry.id} data-outcome={entry.outcome}>
      <div className="flex min-w-0 items-start gap-3">
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
            <span className="min-w-0 text-body text-text [overflow-wrap:anywhere]">{entry.summary}</span>
            <Badge variant={outcome.variant} size="sm">
              {outcome.label}
            </Badge>
          </div>
          <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-label text-text-muted">
            <time dateTime={new Date(entry.at).toISOString()} title={formatDate(entry.at)}>
              {formatRelativeTime(entry.at)}
            </time>
            {entry.databaseName && (
              <>
                <span aria-hidden className="text-text-subtle">·</span>
                {entry.databaseId ? (
                  <Link to={databasePath(entry.databaseId)} className="text-text underline decoration-border-control underline-offset-4 hover:decoration-text">
                    {entry.databaseName}
                  </Link>
                ) : (
                  <span>{entry.databaseName}</span>
                )}
              </>
            )}
            {entry.from && (
              <>
                <span aria-hidden className="text-text-subtle">·</span>
                <span className="font-mono text-code">{entry.from}</span>
              </>
            )}
            <ViaBadge via={entry.via} />
            <span className="font-mono text-micro text-text-subtle">HTTP {entry.status}</span>
          </div>
          {entry.note && (
            <p className="flex items-start gap-1.5 text-label text-text-muted" data-activity-note>
              <MessageSquareQuote aria-hidden className="mt-0.5 size-3.5 shrink-0 text-text-subtle" />
              <span className="[overflow-wrap:anywhere]">
                <span className="sr-only">Agent's note: </span>“{entry.note}”
              </span>
            </p>
          )}
        </div>
        {entry.detail && (
          <Button
            variant="ghost"
            size="icon-xs"
            aria-expanded={open}
            aria-controls={detailId}
            aria-label={open ? "Hide details" : "Show details"}
            onClick={() => setOpen((v) => !v)}
          >
            <ChevronRight aria-hidden className={cn("transition-transform", open && "rotate-90")} />
          </Button>
        )}
      </div>
      {open && entry.detail && (
        <div id={detailId} className="mt-2">
          <CodeBlock code={entry.detail} wrap wrapToggle={false} maxHeight={240} />
        </div>
      )}
    </li>
  );
}

export function ActivityList({
  entries,
  hasMore,
  loadingMore,
  onMore,
}: {
  entries: TokenActivityEntry[];
  hasMore: boolean;
  loadingMore?: boolean;
  onMore?: () => void;
}) {
  if (entries.length === 0) {
    return <p className="px-5 py-8 text-center text-body text-text-muted">Nothing yet. Every request this token makes appears here.</p>;
  }
  return (
    <>
      <ul aria-label="Activity of this token">
        {entries.map((entry) => (
          <ActivityRow key={entry.id} entry={entry} />
        ))}
      </ul>
      {hasMore && (
        <div className="flex justify-center border-t border-border px-5 py-3">
          <Button variant="ghost" size="sm" loading={loadingMore} onClick={onMore}>
            Show older activity
          </Button>
        </div>
      )}
    </>
  );
}
