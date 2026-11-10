import { Link } from "react-router-dom";
import type { DashboardSummary } from "@lambdata/shared";
import { Alert } from "../../components/ui/Alert";
import { Button } from "../../components/ui/Button";

export function SyncFailureBanner({ summary }: { summary: DashboardSummary | undefined }) {
  const failing = summary?.sync.failing ?? 0;
  if (failing === 0) return null;
  return (
    <Alert
      variant="warning"
      title={`${failing} mirror ${failing === 1 ? "sync is" : "syncs are"} failing`}
      action={
        <Button asChild size="xs" variant="secondary">
          <Link to="/databases">Review</Link>
        </Button>
      }
    >
      {summary?.sync.lastError ? <span className="break-words font-mono text-code">{summary.sync.lastError}</span> : "Open the mirror's Sync tab for details."}
    </Alert>
  );
}
