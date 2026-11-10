import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { ChartArea } from "lucide-react";
import type { DashboardVitals, VitalsChartStyle } from "@lambdata/shared";
import { QueryError } from "../../components/layout/QueryError";
import { Card, CardContent, CardHeader } from "../../components/ui/Card";
import { EmptyState } from "../../components/ui/EmptyState";
import { SegmentedControl } from "../../components/ui/RadioGroup";
import { Skeleton } from "../../components/ui/Skeleton";
import { api } from "../../lib/api";
import { databasePath } from "../../lib/commands";
import { formatBytes, formatSignedBytes } from "../../lib/format";
import { queryKeys, useDatabases } from "../../lib/queries";
import { DAY_MS, VITALS_RANGES, vitalsRangeLabel, type VitalsRange } from "../../lib/timeRange";
import { buildStack } from "./stack";
import { StackedChart } from "./StackedChart";

const RANGE_DAYS: [VitalsRange, number][] = [
  ["1d", 1],
  ["5d", 5],
  ["15d", 15],
];

function fittingRange(oldest: number | null): VitalsRange {
  if (oldest === null) return "30d";
  const days = (Date.now() - oldest) / DAY_MS;
  return RANGE_DAYS.find(([, limit]) => days < limit)?.[0] ?? "30d";
}

export function ClusterVitalsCard({ chartStyle }: { chartStyle: VitalsChartStyle }) {
  const databases = useDatabases();
  const [picked, setPicked] = useState<VitalsRange | null>(null);
  const [hover, setHover] = useState<number | null>(null);
  const oldest = databases.data && databases.data.length > 0 ? Math.min(...databases.data.map((db) => db.createdAt)) : null;
  const range = picked ?? fittingRange(oldest);
  const query = useQuery({
    queryKey: queryKeys.dashboardVitals(range),
    queryFn: () => api.get<DashboardVitals>(`/dashboard/vitals?range=${range}&maxPoints=96`),
    enabled: picked !== null || !databases.isPending,
    placeholderData: (previous) => previous,
    refetchInterval: (q) => (q.state.error ? false : 60_000),
  });
  const data = useMemo(() => {
    const raw = query.data;
    if (!raw || !databases.data) return raw;
    const created = new Map(databases.data.map((db) => [db.id, db.createdAt]));
    return {
      ...raw,
      series: raw.series.map((series) => {
        const since = created.get(series.databaseId);
        return since ? { ...series, samples: series.samples.filter((sample) => sample.collectedAt >= since) } : series;
      }),
    };
  }, [query.data, databases.data]);
  const model = useMemo(
    () => (data && data.series.length > 0 ? buildStack(data.series, data.rangeMs, data.collectedAt) : null),
    [data],
  );

  const delta = model ? model.totalNow - model.totalThen : 0;
  const values = model
    ? model.bands.map((band) => band.values[hover ?? model.bucketCount - 1] ?? 0)
    : [];

  return (
    <Card flush>
      <CardHeader
        title="Cluster vitals"
        description="Storage footprint per database over time."
        action={
          <SegmentedControl
            aria-label="Vitals range"
            size="xs"
            value={range}
            onValueChange={(v) => {
              setHover(null);
              setPicked(v as VitalsRange);
            }}
            options={VITALS_RANGES}
          />
        }
      />
      <CardContent className="pt-0">
        {query.isPending ? (
          <Skeleton className="h-[248px] w-full" />
        ) : query.isError && !data ? (
          <QueryError error={query.error} title="Could not load cluster vitals" onRetry={query.refetch} retrying={query.isFetching} />
        ) : !model || model.empty ? (
          <EmptyState
            variant="dashed"
            size="sm"
            icon={ChartArea}
            title="Nothing to chart yet"
            description={
              model
                ? "Every database in vitals is still empty. Sizes appear once tables hold data."
                : "Databases shown in vitals appear here once the collector has taken a sample."
            }
          />
        ) : (
          <>
            <div className="mb-3 flex flex-wrap items-baseline gap-x-3 gap-y-1">
              <span className="font-mono text-metric font-medium tracking-[-0.04em] text-text">{formatBytes(model.totalNow)}</span>
              <span className="text-body text-text-muted">
                across {data!.series.length} {data!.series.length === 1 ? "database" : "databases"}
              </span>
              <span className="font-mono text-label text-text-subtle">
                {formatSignedBytes(delta)} over {vitalsRangeLabel(range)}
              </span>
              {query.isFetching && !query.isPending && (
                <span className="text-micro text-text-subtle" aria-live="polite">
                  updating…
                </span>
              )}
            </div>
            <StackedChart model={model} rangeMs={data!.rangeMs} style={chartStyle} hover={hover} onHover={setHover} />
            <ul className="mt-4 flex flex-wrap items-center gap-x-5 gap-y-2 border-t border-border pt-3 text-label">
              {model.bands.map((band, i) => (
                <li key={band.key} className="inline-flex min-w-0 items-center gap-1.5">
                  <span aria-hidden className="size-2 shrink-0 rounded-[2px]" style={{ background: band.color }} />
                  {band.databaseId ? (
                    <Link
                      to={databasePath(band.databaseId)}
                      className="truncate rounded-sm font-mono text-text-muted outline-none hover:text-text focus-visible:ring-2 focus-visible:ring-ring/70"
                    >
                      {band.label}
                    </Link>
                  ) : (
                    <span className="truncate font-mono text-text-muted">{band.label}</span>
                  )}
                  <span className="font-mono text-text-subtle">{formatBytes(values[i] ?? 0)}</span>
                </li>
              ))}
              {model.idleCount > 0 && (
                <li className="text-micro text-text-subtle">
                  {model.idleCount} empty {model.idleCount === 1 ? "database" : "databases"} not shown
                </li>
              )}
            </ul>
          </>
        )}
      </CardContent>
    </Card>
  );
}
