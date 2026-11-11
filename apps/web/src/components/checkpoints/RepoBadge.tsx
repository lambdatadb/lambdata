import { GitBranch } from "lucide-react";
import type { Database, WorkingCopyStatus } from "@lambdata/shared";
import { Badge } from "../ui/Badge";
import { SimpleTooltip } from "../ui/Tooltip";
import { useCachedWorkingCopyStatus, useWorkingCopyStatus } from "./queries";

export function RepoBadge({ db, live = false, className }: { db: Database; live?: boolean; className?: string }) {
  const cached = useCachedWorkingCopyStatus(db.id);
  const fetched = useWorkingCopyStatus(db.id, { enabled: live && db.versioned });
  const status: WorkingCopyStatus | undefined = live ? (fetched.data ?? cached) : cached;
  if (!db.versioned) return null;
  const sameBase = status?.baseCheckpointId === db.baseCheckpointId;
  const synced = sameBase && status?.state === "dirty" && status.matchesLastSync === true;
  const dirty = sameBase && status?.state === "dirty" && !synced;
  const hash = db.baseShortHash;
  const description = !hash
    ? "Versioned, no checkpoint yet"
    : synced
      ? `Versioned at ${hash}, with synced data not yet in a checkpoint`
      : dirty
        ? `Versioned at ${hash}, with changes since that checkpoint`
        : `Versioned at checkpoint ${hash}`;
  return (
    <SimpleTooltip content={description}>
      <Badge variant="outline" size="sm" mono className={className}>
        <GitBranch aria-hidden />
        <span aria-hidden>{hash ?? "no checkpoint"}</span>
        {dirty && <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-warn" />}
        {synced && <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-info" />}
        <span className="sr-only">{description}</span>
      </Badge>
    </SimpleTooltip>
  );
}
