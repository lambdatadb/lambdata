import { useState } from "react";
import { Link } from "react-router-dom";
import { Check, ChevronRight, MessageSquareQuote, X } from "lucide-react";
import type { Approval } from "@lambdata/shared";
import { Badge } from "../ui/Badge";
import { Button } from "../ui/Button";
import { Card } from "../ui/Card";
import { CodeBlock } from "../ui/CodeBlock";
import { cn } from "../ui/cn";
import { databasePath } from "../../lib/commands";
import { formatDate, formatRelativeTime } from "../../lib/format";
import { approvalActionLabel, approvalStatusView, effectiveApprovalStatus, tokenPath } from "../../lib/accessTokens";

function untilText(at: number, now: number): string {
  const ms = at - now;
  if (ms <= 0) return "expired";
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `expires in ${Math.max(1, minutes)} min`;
  const hours = Math.round(minutes / 60);
  return `expires in ${hours} ${hours === 1 ? "hour" : "hours"}`;
}

function Meta({ approval }: { approval: Approval }) {
  return (
    <>
      <Link to={tokenPath(approval.tokenId)} className="font-medium text-text underline decoration-border-control underline-offset-4 hover:decoration-text">
        {approval.tokenName}
      </Link>
      {approval.databaseName && (
        <>
          <span aria-hidden className="text-text-subtle">·</span>
          {approval.databaseId ? (
            <Link to={databasePath(approval.databaseId)} className="underline decoration-border-control underline-offset-4 hover:decoration-text">
              {approval.databaseName}
            </Link>
          ) : (
            <span>{approval.databaseName}</span>
          )}
        </>
      )}
    </>
  );
}

function Note({ note }: { note: string | null }) {
  if (!note) return null;
  return (
    <p className="flex items-start gap-1.5 text-label text-text-muted" data-approval-note>
      <MessageSquareQuote aria-hidden className="mt-0.5 size-3.5 shrink-0 text-text-subtle" />
      <span className="[overflow-wrap:anywhere]">
        <span className="sr-only">Agent's note: </span>“{note}”
      </span>
    </p>
  );
}

function Detail({ id, detail }: { id: string; detail: string | null }) {
  const [open, setOpen] = useState(false);
  if (!detail) return null;
  return (
    <div className="space-y-2">
      <Button variant="link" size="xs" aria-expanded={open} aria-controls={`approval-detail-${id}`} onClick={() => setOpen((v) => !v)}>
        <ChevronRight aria-hidden className={cn("transition-transform", open && "rotate-90")} />
        {open ? "Hide the exact request" : "Show the exact request"}
      </Button>
      {open && (
        <div id={`approval-detail-${id}`}>
          <CodeBlock code={detail} wrap wrapToggle={false} maxHeight={240} />
        </div>
      )}
    </div>
  );
}

export function PendingApprovalCard({
  approval,
  now,
  busy,
  onApprove,
  onDeny,
}: {
  approval: Approval;
  now: number;
  busy?: "approve" | "deny" | null;
  onApprove: () => void;
  onDeny: () => void;
}) {
  const expired = effectiveApprovalStatus(approval, now) !== "pending";
  return (
    <Card className="space-y-3" data-approval={approval.id} data-approval-state={expired ? "expired" : "pending"}>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 space-y-1.5">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="muted" size="sm">
              {approvalActionLabel(approval.action)}
            </Badge>
            {expired && (
              <Badge variant="muted" size="sm" dot>
                expired
              </Badge>
            )}
          </div>
          <p className="text-body font-medium text-text [overflow-wrap:anywhere]">{approval.summary}</p>
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-label text-text-muted">
            <Meta approval={approval} />
            <span aria-hidden className="text-text-subtle">·</span>
            <time dateTime={new Date(approval.requestedAt).toISOString()} title={formatDate(approval.requestedAt)}>
              asked {formatRelativeTime(approval.requestedAt)}
            </time>
            <span aria-hidden className="text-text-subtle">·</span>
            <span title={formatDate(approval.expiresAt)}>{untilText(approval.expiresAt, now)}</span>
          </div>
          <Note note={approval.note} />
        </div>
        <div className="flex shrink-0 gap-2">
          <Button variant="secondary" size="sm" onClick={onDeny} disabled={expired || busy === "approve"} loading={busy === "deny"}>
            <X aria-hidden /> Deny
          </Button>
          <Button size="sm" onClick={onApprove} disabled={expired || busy === "deny"} loading={busy === "approve"}>
            <Check aria-hidden /> Approve
          </Button>
        </div>
      </div>
      {expired && <p className="text-label text-text-muted">This request expired before anyone decided. The agent has to ask again.</p>}
      <Detail id={approval.id} detail={approval.detail} />
    </Card>
  );
}

export function decidedText(approval: Approval): string {
  const by = approval.decidedByDisplayName ? ` by ${approval.decidedByDisplayName}` : "";
  switch (approval.status) {
    case "approved":
      return approval.approvedUntil
        ? `Approved${by} ${formatRelativeTime(approval.decidedAt)}; the agent may carry it out until ${new Date(approval.approvedUntil).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}`
        : `Approved${by} ${formatRelativeTime(approval.decidedAt)}; not carried out yet`;
    case "used":
      return `Approved${by}, carried out ${formatRelativeTime(approval.usedAt ?? approval.decidedAt)}`;
    case "denied":
      return `Denied${by} ${formatRelativeTime(approval.decidedAt)}`;
    case "cancelled":
      return "Cancelled by the agent";
    case "expired":
      return approval.decidedAt ? `Approved${by} but not carried out in time` : "Nobody decided in time";
    default:
      return `Waiting since ${formatRelativeTime(approval.requestedAt)}`;
  }
}

export function DecidedApprovalList({ approvals, now }: { approvals: Approval[]; now: number }) {
  if (approvals.length === 0) return <p className="px-5 py-6 text-center text-body text-text-muted">No decisions yet.</p>;
  return (
    <ul aria-label="Recent decisions">
      {approvals.map((a) => {
        const status = effectiveApprovalStatus(a, now);
        const view = approvalStatusView(status);
        return (
          <li key={a.id} className="space-y-1 border-b border-border px-4 py-3 last:border-b-0 sm:px-5" data-approval={a.id} data-approval-state={status}>
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <span className="min-w-0 text-body text-text [overflow-wrap:anywhere]">{a.summary}</span>
              <Badge variant={view.variant} size="sm">
                {view.label}
              </Badge>
            </div>
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-label text-text-muted">
              <Meta approval={a} />
              <span aria-hidden className="text-text-subtle">·</span>
              <span>{decidedText({ ...a, status })}</span>
            </div>
            <Note note={a.note} />
          </li>
        );
      })}
    </ul>
  );
}
