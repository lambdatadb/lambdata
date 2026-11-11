import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { ClipboardCheck } from "lucide-react";
import type { Approval } from "@lambdata/shared";
import { PageHeader } from "../../components/layout/PageShell";
import { QueryError } from "../../components/layout/QueryError";
import { DecidedApprovalList, PendingApprovalCard } from "../../components/accessTokens/ApprovalList";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
  Card,
  CardHeader,
  ConfirmDialog,
  EmptyState,
  SkeletonRows,
  toast,
} from "../../components/ui";
import { ApiError, errorMessage } from "../../lib/api";
import { useIsAdmin } from "../../lib/auth";
import {
  APPROVED_WINDOW_MINUTES,
  TOKENS_PATH,
  approvalActionLabel,
  isDestructiveApproval,
  splitApprovals,
  useApprovals,
  useDecideApproval,
} from "../../lib/accessTokens";
import { AdminsOnly } from "../AccessTokens";

export const APPROVALS_SUBTITLE = "Tokens with “ask me first” wait here before deleting or rolling back. Nothing happens until you decide.";

function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(timer);
  }, [intervalMs]);
  return now;
}

export function approvedMessage(approval: Pick<Approval, "tokenName" | "approvedUntil">, now = Date.now()): { title: string; description: string } {
  const until = approval.approvedUntil;
  const window =
    typeof until === "number" && until > now
      ? `until ${formatTime(until)} (${Math.max(1, Math.round((until - now) / 60_000))} minutes)`
      : `${APPROVED_WINDOW_MINUTES} minutes`;
  const lead = window.startsWith("until") ? `${approval.tokenName} may carry it out ${window}.` : `${approval.tokenName} has ${window} to carry it out.`;
  return { title: "Approved", description: `${lead} After that it has to ask again.` };
}

function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

export function decideFailure(error: unknown): string {
  if (error instanceof ApiError && (error.status === 409 || error.status === 410)) {
    return `${errorMessage(error)} The list has been refreshed.`;
  }
  return errorMessage(error);
}

export function ApprovalConfirmBody({ approval }: { approval: Approval }) {
  return (
    <div className="space-y-2 rounded-md border border-border bg-bg-inset p-3" data-approval-confirm={approval.id}>
      <p className="text-micro font-medium uppercase tracking-wide text-text-subtle">{approvalActionLabel(approval.action)}</p>
      <p className="text-body font-medium text-text [overflow-wrap:anywhere]">{approval.summary}</p>
      <p className="text-label text-text-muted">
        Asked by {approval.tokenName}
        {approval.databaseName ? ` on ${approval.databaseName}` : ""}.
      </p>
    </div>
  );
}

export function ApprovalsPage() {
  const isAdmin = useIsAdmin();
  if (!isAdmin) return <AdminsOnly title="Approvals" />;
  return <Approvals />;
}

function Approvals() {
  const query = useApprovals("all", { poll: 15_000 });
  const decide = useDecideApproval();
  const now = useNow(15_000);
  const [confirming, setConfirming] = useState<Approval | null>(null);
  const [shown, setShown] = useState<Approval | null>(null);
  const [busy, setBusy] = useState<{ id: string; decision: "approve" | "deny" } | null>(null);

  const run = (approval: Approval, decision: "approve" | "deny") => {
    setBusy({ id: approval.id, decision });
    decide.mutate(
      { id: approval.id, decision },
      {
        onSuccess: (res) => {
          setConfirming(null);
          if (decision === "approve") {
            const msg = approvedMessage({ ...approval, ...res.approval });
            toast.success(msg.title, { description: msg.description });
          } else {
            toast.success("Denied", { description: `${approval.tokenName} is told no. It can ask again later.` });
          }
        },
        onError: (error) => {
          setConfirming(null);
          toast.error(decision === "approve" ? "Could not approve" : "Could not deny", { description: decideFailure(error) });
        },
        onSettled: () => setBusy(null),
      },
    );
  };

  const approve = (approval: Approval) => {
    if (isDestructiveApproval(approval.action)) {
      setShown(approval);
      setConfirming(approval);
    }
    else run(approval, "approve");
  };

  const { pending, decided } = splitApprovals(query.data?.approvals ?? [], now);
  const stale = (query.data?.approvals ?? []).filter((a) => a.status === "pending" && a.expiresAt <= now);

  return (
    <>
      <PageHeader
        title="Approvals"
        subtitle={APPROVALS_SUBTITLE}
        breadcrumb={
          <Breadcrumb>
            <BreadcrumbList>
              <BreadcrumbItem>
                <BreadcrumbLink asChild>
                  <Link to={TOKENS_PATH}>Access tokens</Link>
                </BreadcrumbLink>
              </BreadcrumbItem>
              <BreadcrumbSeparator />
              <BreadcrumbItem>
                <BreadcrumbPage>Approvals</BreadcrumbPage>
              </BreadcrumbItem>
            </BreadcrumbList>
          </Breadcrumb>
        }
      />

      {query.isPending ? (
        <Card>
          <SkeletonRows rows={3} label="Loading approvals" />
        </Card>
      ) : query.isError && !query.data ? (
        <QueryError error={query.error} title="Could not load the approvals" onRetry={query.refetch} retrying={query.isFetching} />
      ) : (
        <div className="space-y-6">
          {query.isError && (
            <QueryError error={query.error} title="Could not refresh; showing what was last read" onRetry={query.refetch} retrying={query.isFetching} />
          )}
          <section aria-labelledby="pending-title" className="space-y-3">
            <h2 id="pending-title" className="text-heading font-semibold text-text">
              Waiting for you
            </h2>
            {pending.length === 0 && stale.length === 0 ? (
              <EmptyState
                icon={ClipboardCheck}
                size="sm"
                title="Nothing is waiting"
                description="When a token with “ask me first” wants to delete or roll back something, it appears here and on the dashboard."
              />
            ) : (
              <ul className="space-y-3">
                {[...pending, ...stale].map((a) => (
                  <li key={a.id}>
                    <PendingApprovalCard
                      approval={a}
                      now={now}
                      busy={busy?.id === a.id ? busy.decision : null}
                      onApprove={() => approve(a)}
                      onDeny={() => run(a, "deny")}
                    />
                  </li>
                ))}
              </ul>
            )}
          </section>

          <Card flush>
            <CardHeader divided title="Recent decisions" />
            <DecidedApprovalList approvals={decided.filter((a) => !stale.includes(a))} now={now} />
          </Card>
        </div>
      )}

      <ConfirmDialog
        open={!!confirming}
        onClose={() => !decide.isPending && setConfirming(null)}
        onConfirm={() => confirming && run(confirming, "approve")}
        tone="danger"
        loading={decide.isPending}
        title="Approve this request?"
        description={`The agent may then carry it out once, within ${APPROVED_WINDOW_MINUTES} minutes. Check that this is what you expect.`}
        confirmLabel="Approve"
      >
        {shown && <ApprovalConfirmBody approval={shown} />}
      </ConfirmDialog>
    </>
  );
}
