import { Archive, FileWarning } from "lucide-react";
import type { UnconvertedSnapshot } from "@lambdata/shared";
import { Badge } from "../ui/Badge";
import { Card, CardHeader } from "../ui/Card";
import { formatBytes, formatDate, formatRelativeTime, pluralize } from "../../lib/format";

export function UnconvertedSnapshots({ items }: { items: UnconvertedSnapshot[] }) {
  if (items.length === 0) return null;
  const sorted = [...items].sort((a, b) => b.createdAt - a.createdAt);
  return (
    <Card flush aria-label="Snapshots that could not be converted" data-unconverted={items.length}>
      <CardHeader
        divided
        title={
          <span className="flex min-w-0 items-start gap-2">
            <Archive aria-hidden className="mt-1 size-4 shrink-0 text-text-subtle" />
            <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
              Old snapshots that could not be converted
              <Badge variant="warn" size="sm">
                {pluralize(items.length, "snapshot")}
              </Badge>
            </span>
          </span>
        }
        description={
          <>
            {items.length === 1 ? "This snapshot was" : "These snapshots were"} taken before checkpoints existed. LambData could not turn{" "}
            {items.length === 1 ? "it" : "them"} into checkpoints, so {items.length === 1 ? "it is" : "they are"} not part of the history
            above and cannot be rolled back to from the console. LambData tries again every time it starts, and the original{" "}
            {items.length === 1 ? "file is" : "files are"} left untouched on disk.
          </>
        }
      />
      <ul className="divide-y divide-border" aria-label="Unconverted snapshots, newest first">
        {sorted.map((snap) => (
          <li key={snap.snapshotId} className="flex min-w-0 items-start gap-3 px-5 py-3.5">
            <span className="mt-0.5 grid size-8 shrink-0 place-items-center rounded-md border border-warn/30 bg-warn/[0.06] text-warn">
              <FileWarning aria-hidden className="size-4" />
            </span>
            <div className="min-w-0 flex-1 space-y-2">
              <div className="space-y-0.5">
                <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                  <span className="text-body font-medium text-text">
                    {snap.trigger === "scheduled" ? "Automatic snapshot" : "Manual snapshot"} from{" "}
                    <time dateTime={new Date(snap.createdAt).toISOString()}>{formatDate(snap.createdAt)}</time>
                  </span>
                  <Badge variant="muted" size="sm">
                    not converted
                  </Badge>
                </div>
                <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-label text-text-muted">
                  <span className="font-mono text-code text-text">{formatBytes(snap.sizeBytes)}</span>
                  <span aria-hidden className="text-text-subtle">·</span>
                  <span>
                    {snap.attempts === 1 ? "Tried once" : `Tried ${pluralize(snap.attempts, "time")}`}, last{" "}
                    <time dateTime={new Date(snap.failedAt).toISOString()} title={formatDate(snap.failedAt)}>
                      {formatRelativeTime(snap.failedAt)}
                    </time>
                  </span>
                </div>
              </div>
              <div className="space-y-1">
                <p className="text-micro font-medium text-text-subtle">Why it failed</p>
                <p className="max-h-40 overflow-y-auto whitespace-pre-line break-words rounded-md border border-border bg-bg-inset px-3 py-2 text-label text-text-muted">
                  {snap.reason}
                </p>
              </div>
            </div>
          </li>
        ))}
      </ul>
    </Card>
  );
}
