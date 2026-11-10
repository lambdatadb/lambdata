import { Database, FolderOpen, RadioTower } from "lucide-react";
import type { DashboardSummary } from "@lambdata/shared";
import { StatTile } from "../../components/ui/StatTile";
import { formatBytes, formatNumber, pluralize } from "../../lib/format";
import { CheckpointTiles } from "./CheckpointTiles";

export function SummaryStats({ summary, loading }: { summary: DashboardSummary | undefined; loading: boolean }) {
  const dbs = summary?.databases;
  const standard = dbs ? dbs.total - dbs.mirrors : 0;
  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
      <StatTile
        label="Databases"
        icon={Database}
        value={dbs?.total ?? null}
        loading={loading}
        hint={dbs ? `${standard} standard · ${dbs.mirrors} ${dbs.mirrors === 1 ? "mirror" : "mirrors"}` : "—"}
      />
      <StatTile
        label="Object storage"
        icon={FolderOpen}
        value={summary?.storage.totalSizeBytes ?? null}
        format={formatBytes}
        loading={loading}
        hint={summary ? `${pluralize(summary.storage.buckets, "bucket")} · ${pluralize(summary.storage.objects, "object")}` : "—"}
      />
      <CheckpointTiles summary={summary} loading={loading} />
      <StatTile
        label="Realtime"
        icon={RadioTower}
        value={summary?.realtime.connections ?? null}
        loading={loading}
        hint={summary ? `${pluralize(summary.realtime.channels, "channel")} · ${formatNumber(summary.realtime.messagesSent)} sent` : "—"}
        className="col-span-2 md:col-span-1"
      />
    </div>
  );
}
