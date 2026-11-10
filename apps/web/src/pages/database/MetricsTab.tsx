import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Cable, HardDrive, Rows3, Table2 } from "lucide-react";
import type { MetricSample } from "@lambdata/shared";
import { QueryError } from "../../components/layout/QueryError";
import { Card, CardContent, CardHeader } from "../../components/ui/Card";
import { SegmentedControl } from "../../components/ui/RadioGroup";
import { Skeleton } from "../../components/ui/Skeleton";
import { StatTile } from "../../components/ui/StatTile";
import { api } from "../../lib/api";
import { formatBytes, formatCount } from "../../lib/format";
import { queryKeys } from "../../lib/queries";
import { METRICS_RANGES, METRICS_RANGE_MS, metricsRangeLabel, type MetricsRange } from "../../lib/timeRange";
import { RowGrowthHeatmap } from "./RowGrowthHeatmap";
import { SizeSparkline } from "./SizeSparkline";
import type { DatabaseTabProps } from "./types";

export function MetricsTab({ db }: DatabaseTabProps) {
  const [range, setRange] = useState<MetricsRange>("7d");
  const query = useQuery({
    queryKey: queryKeys.metrics(db.id, range),
    queryFn: () => api.get<{ samples: MetricSample[] }>(`/databases/${db.id}/metrics?range=${range}`),
    placeholderData: (previous) => previous,
    refetchInterval: (q) => (q.state.error ? false : 30_000),
  });
  const samples = query.data?.samples ?? [];
  const latest = samples[samples.length - 1];
  const loading = query.isPending;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-body text-text-muted">Sampled every minute, averaged into buckets for longer ranges.</p>
        <SegmentedControl
          aria-label="Range"
          value={range}
          onValueChange={(v) => setRange(v as MetricsRange)}
          options={METRICS_RANGES}
        />
      </div>

      {query.isError && !query.data ? (
        <QueryError error={query.error} title="Could not load metrics" onRetry={query.refetch} retrying={query.isFetching} />
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <StatTile label="Size" icon={HardDrive} value={latest?.sizeBytes ?? null} format={formatBytes} loading={loading} />
            <StatTile label="Tables" icon={Table2} value={latest?.tableCount ?? null} loading={loading} />
            <StatTile label="Rows" icon={Rows3} value={latest?.rowCount ?? null} format={formatCount} loading={loading} />
            <StatTile label="Connections" icon={Cable} value={latest?.connectionCount ?? null} loading={loading} />
          </div>
          <Card flush>
            <CardHeader divided title="Size over time" description={`Total on-disk size over the last ${metricsRangeLabel(range)}.`} />
            <CardContent>
              {loading ? <Skeleton className="h-[160px] w-full" /> : <SizeSparkline samples={samples} rangeMs={METRICS_RANGE_MS[range]} />}
            </CardContent>
          </Card>
          <Card flush>
            <CardHeader
              divided
              title="Row growth"
              description="Net increase in row count per time bucket. Updates, and inserts balanced by deletes, do not show here."
            />
            <CardContent>
              {loading ? (
                <Skeleton className="h-[110px] w-full" />
              ) : (
                <RowGrowthHeatmap samples={samples} rangeMs={METRICS_RANGE_MS[range]} rangeLabel={metricsRangeLabel(range)} />
              )}
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
