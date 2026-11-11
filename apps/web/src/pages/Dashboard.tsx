import { Plus } from "lucide-react";
import { PageHeader } from "../components/layout/PageShell";
import { QueryError } from "../components/layout/QueryError";
import { Button } from "../components/ui/Button";
import { useAuth, useCanWrite } from "../lib/auth";
import { useCreateDatabaseDialog } from "../lib/createDatabase";
import { useDashboardSummary } from "../lib/queries";
import { AddressSubtitle } from "./dashboard/AddressSubtitle";
import { ApprovalsBanner } from "./dashboard/ApprovalsBanner";
import { ClusterVitalsCard } from "./dashboard/ClusterVitalsCard";
import { DatabaseMetricsTable } from "./dashboard/DatabaseMetricsTable";
import { NotificationsBanner } from "./dashboard/NotificationsBanner";
import { SummaryStats } from "./dashboard/SummaryStats";
import { SyncFailureBanner } from "./dashboard/SyncFailureBanner";
import { SystemFacts } from "./dashboard/SystemFacts";
import { UnconvertedBanner } from "./dashboard/UnconvertedBanner";

export function Dashboard() {
  const { user } = useAuth();
  const canWrite = useCanWrite();
  const createDialog = useCreateDatabaseDialog();
  const summary = useDashboardSummary({ poll: true });
  const s = summary.data;
  const loading = summary.isPending;
  const create = canWrite ? () => createDialog.open("standard") : undefined;

  return (
    <>
      <PageHeader
        title="Dashboard"
        subtitle={<AddressSubtitle summary={s} />}
        actions={
          create ? (
            <Button onClick={create}>
              <Plus /> New database
            </Button>
          ) : undefined
        }
      />
      <div className="space-y-4">
        {summary.isError && !s && (
          <QueryError error={summary.error} title="Could not load the dashboard" onRetry={summary.refetch} retrying={summary.isFetching} />
        )}
        <ApprovalsBanner />
        <SyncFailureBanner summary={s} />
        <UnconvertedBanner />
        <NotificationsBanner />
        <SummaryStats summary={s} loading={loading} />
        <SystemFacts summary={s} />
        <ClusterVitalsCard chartStyle={user?.vitalsChartStyle ?? "area"} />
        <DatabaseMetricsTable summary={s} loading={loading} onCreate={create} />
      </div>
    </>
  );
}
