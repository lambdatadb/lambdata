import { Link } from "react-router-dom";
import { ArrowLeftRight, Database as DatabaseIcon, UserRound } from "lucide-react";
import type { Database } from "@lambdata/shared";
import { Badge } from "../ui/Badge";
import { Card } from "../ui/Card";
import { RepoBadge } from "../checkpoints/RepoBadge";
import { databasePath } from "../../lib/commands";
import { formatRelativeTime } from "../../lib/format";

export function DatabaseCard({ db }: { db: Database }) {
  const Icon = db.kind === "mirror" ? ArrowLeftRight : DatabaseIcon;
  return (
    <Card interactive className="group flex flex-col gap-4 p-4">
      <div className="flex items-start gap-3">
        <div className="grid size-9 shrink-0 place-items-center rounded-md border border-border bg-bg-raised text-text-muted transition-colors group-hover:text-text">
          <Icon aria-hidden className="size-4" />
        </div>
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-body font-medium text-text">
            <Link
              to={databasePath(db.id)}
              className="stretched-link rounded-sm outline-none focus-visible:underline focus-visible:decoration-accent focus-visible:underline-offset-4"
            >
              {db.displayName}
            </Link>
          </h3>
          <p className="truncate font-mono text-code text-text-muted">{db.name}</p>
        </div>
        <div className="flex shrink-0 flex-wrap items-center justify-end gap-1">
          {db.status !== "active" && (
            <Badge variant="warn" size="sm" dot>
              {db.status}
            </Badge>
          )}
          {db.kind === "mirror" && (
            <Badge variant="info" size="sm">
              mirror
            </Badge>
          )}
          {db.tailscaleExposed && (
            <Badge variant="muted" size="sm">
              tailnet
            </Badge>
          )}
        </div>
      </div>
      <div className="flex items-center justify-between gap-3 border-t border-border pt-3 text-label text-text-muted">
        <span className="flex min-w-0 items-center gap-1.5 truncate">
          <UserRound aria-hidden className="size-3.5 shrink-0 text-text-subtle" />
          <span className="truncate">{db.ownerDisplayName ?? "Unknown owner"}</span>
        </span>
        <span className="flex shrink-0 items-center gap-2">
          <RepoBadge db={db} />
          <span className="text-text-subtle">{formatRelativeTime(db.createdAt)}</span>
        </span>
      </div>
    </Card>
  );
}
