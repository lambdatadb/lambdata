import { Copy, Download, History, MoreHorizontal, Pencil, Pin, PinOff, RotateCcw, ShieldCheck, Trash2, TriangleAlert } from "lucide-react";
import type { Checkpoint, WorkingCopyState } from "@lambdata/shared";
import { Badge } from "../ui/Badge";
import { Button } from "../ui/Button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../ui/DropdownMenu";
import { SimpleTooltip } from "../ui/Tooltip";
import { copyText } from "../ui/useCopyToClipboard";
import { toast } from "../ui/Toast";
import { cn } from "../ui/cn";
import { focusRing } from "../ui/styles";
import { api } from "../../lib/api";
import { formatBytes, formatDate, formatRelativeTime, pluralize } from "../../lib/format";
import type { GraphRow } from "./graph";
import { GraphCell, type NodeShape, type WorkingTone } from "./GraphCell";
import { isAutomatic, isLegacy, newBytesLabel, sizeTitle, triggerMeta } from "./meta";
import { checkpointPath, type HistoryPermissions } from "./queries";

export interface CheckpointActions {
  open: (cp: Checkpoint) => void;
  restore: (cp: Checkpoint) => void;
  togglePin: (cp: Checkpoint) => void;
  edit: (cp: Checkpoint) => void;
  remove: (cp: Checkpoint) => void;
}

export interface CheckpointRowProps {
  cp: Checkpoint;
  row: GraphRow;
  laneWidth: number;
  graphWidth: number;
  selected: boolean;
  restoring: boolean;
  permissions: HistoryPermissions;
  busyReason: string | null;
  workingState: WorkingCopyState | null;
  workingTone: WorkingTone;
  actions: CheckpointActions;
}

export function checkpointDownloadUrl(cp: Checkpoint): string {
  return api.downloadUrl(checkpointPath(cp.databaseId, `/${encodeURIComponent(cp.id)}/download`));
}

function nodeShape(cp: Checkpoint): NodeShape {
  if (cp.isBase) return "head";
  if (isLegacy(cp)) return "legacy";
  return isAutomatic(cp.trigger) ? "auto" : "commit";
}

export function HeadBadge({ className }: { className?: string }) {
  return (
    <Badge variant="solid" size="sm" mono className={cn("font-semibold", className)}>
      HEAD
    </Badge>
  );
}

export function LegacyBadge({ className }: { className?: string }) {
  return (
    <SimpleTooltip content="Converted from a snapshot taken before checkpoints existed. You can roll back to it and download it like any other checkpoint, but it has no per-table breakdown.">
      <Badge variant="muted" size="sm" className={cn("cursor-default", className)}>
        <History aria-hidden />
        Converted snapshot
      </Badge>
    </SimpleTooltip>
  );
}

export function TriggerBadge({ cp }: { cp: Checkpoint }) {
  if (cp.trigger === "legacy") return null;
  const meta = triggerMeta(cp.trigger);
  return (
    <SimpleTooltip content={meta.hint}>
      <Badge variant={meta.variant} size="sm" className="cursor-default">
        {meta.label}
      </Badge>
    </SimpleTooltip>
  );
}

export function checkpointLimitations(cp: Pick<Checkpoint, "limitations">): string[] {
  return (cp.limitations ?? []).filter((item) => typeof item === "string" && item.trim().length > 0);
}

export function verifiedText(cp: Pick<Checkpoint, "verifiedAt">): string | null {
  if (!cp.verifiedAt) return null;
  return `Verified ${formatRelativeTime(cp.verifiedAt)}: loaded into a scratch copy and matched what was recorded`;
}

export function VerifiedMarker({ cp }: { cp: Checkpoint }) {
  const text = verifiedText(cp);
  if (!text) return null;
  return (
    <SimpleTooltip content={`${text} (${formatDate(cp.verifiedAt)})`}>
      <ShieldCheck aria-label={text} role="img" className="relative z-10 size-3.5 shrink-0 text-success" />
    </SimpleTooltip>
  );
}

export function LimitationsMarker({ cp }: { cp: Checkpoint }) {
  const items = checkpointLimitations(cp);
  if (items.length === 0) return null;
  const label = items.length === 1 ? "1 limitation" : `${items.length} limitations`;
  return (
    <SimpleTooltip
      content={
        <span className="block space-y-1">
          <span className="block font-medium">Captured with {label}</span>
          {items.slice(0, 4).map((item, i) => (
            <span key={i} className="block text-text-muted">
              {item}
            </span>
          ))}
          {items.length > 4 && <span className="block text-text-muted">and {items.length - 4} more; open it for the full list</span>}
        </span>
      }
    >
      <TriangleAlert aria-label={`Captured with ${label}`} role="img" className="relative z-10 size-3.5 shrink-0 text-warn" />
    </SimpleTooltip>
  );
}

export function rollbackLabel(cp: Checkpoint, workingState: WorkingCopyState | null): { label: string; disabled: string | null } {
  if (cp.isBase && workingState === "clean") return { label: "Roll back here", disabled: "The live data already matches this checkpoint" };
  if (cp.isBase && workingState === "dirty") return { label: "Discard changes since this", disabled: null };
  return { label: "Roll back to this…", disabled: null };
}

export function CheckpointRow({
  cp,
  row,
  laneWidth,
  graphWidth,
  selected,
  restoring,
  permissions,
  busyReason,
  workingState,
  workingTone,
  actions,
}: CheckpointRowProps) {
  const legacy = isLegacy(cp);
  const author = cp.createdByDisplayName ?? (cp.createdByUserId ? "Unknown user" : "LambData");
  const rollback = rollbackLabel(cp, workingState);

  return (
    <li className="group/row relative flex min-w-0" data-checkpoint={cp.shortHash}>
      <div className="relative shrink-0" style={{ width: graphWidth }}>
        <GraphCell row={row} laneWidth={laneWidth} width={graphWidth} shape={nodeShape(cp)} workingTone={workingTone} pulsing={restoring} />
      </div>
      <div
        className={cn(
          "relative flex min-w-0 flex-1 items-start gap-3 border-b border-border/70 py-3 pl-1 pr-3 transition-colors sm:pr-4",
          "group-last/row:border-b-0 hover:bg-bg-raised/40",
          selected && "bg-bg-selected/50 hover:bg-bg-selected/50",
        )}
      >
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2">
            <button
              type="button"
              onClick={() => actions.open(cp)}
              className={cn(
                "stretched-link min-w-0 truncate rounded-sm text-left text-body font-medium text-text",
                "outline-none focus-visible:underline focus-visible:decoration-accent focus-visible:underline-offset-4",
                isAutomatic(cp.trigger) && !cp.isBase && "font-normal text-text-muted",
              )}
              title={cp.message}
            >
              {cp.message}
            </button>
            {cp.isBase && <HeadBadge />}
            {cp.pinned && (
              <SimpleTooltip content="Pinned: retention never removes it">
                <Pin aria-label="Pinned" className="relative z-10 size-3.5 shrink-0 text-text-muted" />
              </SimpleTooltip>
            )}
            <VerifiedMarker cp={cp} />
            <LimitationsMarker cp={cp} />
          </div>
          <div className="mt-1 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-label text-text-muted">
            <span className="font-mono text-code leading-4 text-text">{cp.shortHash}</span>
            {legacy ? <LegacyBadge className="relative z-10" /> : <span className="relative z-10 inline-flex">
                <TriggerBadge cp={cp} />
              </span>}
            <time dateTime={new Date(cp.createdAt).toISOString()} title={formatDate(cp.createdAt)}>
              {formatRelativeTime(cp.createdAt)}
            </time>
            <span aria-hidden className="hidden text-text-subtle md:inline">·</span>
            <span className="hidden max-w-[12rem] truncate md:inline">{author}</span>
            {cp.tableCount !== null && (
              <>
                <span aria-hidden className="text-text-subtle">·</span>
                <span>{pluralize(cp.tableCount, "table")}</span>
              </>
            )}
          </div>
          <div className="mt-1 flex items-center gap-2 font-mono text-micro text-text-muted sm:hidden" title={sizeTitle(cp)}>
            <span className="text-text">{formatBytes(cp.logicalBytes)}</span>
            <span className={cp.newBytes > 0 ? "text-text-muted" : "text-text-subtle"}>{newBytesLabel(cp)}</span>
          </div>
        </div>
        <div className="hidden shrink-0 flex-col items-end pt-px text-right sm:flex" title={sizeTitle(cp)}>
          <span className="font-mono text-code text-text">{formatBytes(cp.logicalBytes)}</span>
          <span className={cn("font-mono text-micro", cp.newBytes > 0 ? "text-text-muted" : "text-text-subtle")}>
            {newBytesLabel(cp)}
          </span>
        </div>
        <div className="relative z-10 -my-0.5 flex shrink-0 items-center gap-0.5">
          <SimpleTooltip content={`Download ${cp.shortHash} as .sql.gz`}>
            <Button asChild variant="ghost" size="icon-sm" className="hidden md:inline-flex">
              <a href={checkpointDownloadUrl(cp)} download aria-label={`Download ${cp.shortHash}`}>
                <Download />
              </a>
            </Button>
          </SimpleTooltip>
          <RowMenu
            cp={cp}
            permissions={permissions}
            busyReason={busyReason}
            rollback={rollback}
            actions={actions}
          />
        </div>
      </div>
    </li>
  );
}

function RowMenu({
  cp,
  permissions,
  busyReason,
  rollback,
  actions,
}: {
  cp: Checkpoint;
  permissions: HistoryPermissions;
  busyReason: string | null;
  rollback: { label: string; disabled: string | null };
  actions: CheckpointActions;
}) {
  const rollbackBlocked = rollback.disabled ?? busyReason;
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon-sm" aria-label={`Actions for ${cp.shortHash}`} className={focusRing}>
          <MoreHorizontal />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-60">
        <DropdownMenuLabel className="font-mono">{cp.shortHash}</DropdownMenuLabel>
        {permissions.canRestore && (
          <DropdownMenuItem disabled={!!rollbackBlocked} onSelect={() => actions.restore(cp)}>
            <RotateCcw />
            <span className="min-w-0 flex-1">
              {rollback.label}
              {rollbackBlocked && <span className="block text-micro text-text-subtle">{rollbackBlocked}</span>}
            </span>
          </DropdownMenuItem>
        )}
        <DropdownMenuItem asChild>
          <a href={checkpointDownloadUrl(cp)} download>
            <Download />
            Download .sql.gz
          </a>
        </DropdownMenuItem>
        <DropdownMenuItem
          onSelect={async () => {
            const ok = await copyText(cp.hash);
            if (ok) toast.success("Full hash copied", { description: cp.hash });
            else toast.error("Could not copy the hash");
          }}
        >
          <Copy />
          Copy full hash
        </DropdownMenuItem>
        {permissions.canWrite && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => actions.togglePin(cp)}>
              {cp.pinned ? <PinOff /> : <Pin />}
              {cp.pinned ? "Unpin" : "Pin (keep forever)"}
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => actions.edit(cp)}>
              <Pencil />
              Edit message…
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="danger" disabled={!!busyReason} onSelect={() => actions.remove(cp)}>
              <Trash2 />
              Delete…
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
