import { Link } from "react-router-dom";
import type { ApprovalListResponse } from "@lambdata/shared";
import { Alert } from "../../components/ui/Alert";
import { Button } from "../../components/ui/Button";
import { useIsAdmin } from "../../lib/auth";
import { APPROVALS_PATH, effectiveApprovalStatus, pendingCount, usePendingApprovals } from "../../lib/accessTokens";

export function ApprovalsWaitingAlert({ data, now = Date.now() }: { data: ApprovalListResponse | undefined; now?: number }) {
  const count = pendingCount(data, now);
  if (count === 0) return null;
  const first = data?.approvals.find((a) => effectiveApprovalStatus(a, now) === "pending");
  return (
    <Alert
      variant="info"
      title={count === 1 ? "An agent is waiting for your approval" : `${count} agent requests are waiting for your approval`}
      data-approvals-waiting={count}
      action={
        <Button asChild size="xs" variant="secondary">
          <Link to={APPROVALS_PATH}>Review</Link>
        </Button>
      }
    >
      {count === 1 && first ? (
        <span className="[overflow-wrap:anywhere]">
          {first.tokenName}: {first.summary}
        </span>
      ) : (
        "Nothing happens until you approve or deny."
      )}
    </Alert>
  );
}

export function ApprovalsBanner() {
  const isAdmin = useIsAdmin();
  const query = usePendingApprovals({ enabled: isAdmin });
  if (!isAdmin) return null;
  return <ApprovalsWaitingAlert data={query.data} />;
}
