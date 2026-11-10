import { useId } from "react";
import { useQuery } from "@tanstack/react-query";
import type { MetricSample } from "@lambdata/shared";
import { api } from "../../lib/api";
import { smoothPath } from "../../lib/charts";
import { formatBytes, formatCount, formatSignedBytes } from "../../lib/format";
import { queryKeys } from "../../lib/queries";
import { useElementWidth } from "../../lib/useElementWidth";
import { Card } from "../ui/Card";
import { Skeleton } from "../ui/Skeleton";

interface Props {
  databaseId: string;
}

function signedCount(n: number): string {
  if (n === 0) return "no change";
  return `${n > 0 ? "+" : "−"}${formatCount(Math.abs(n))}`;
}

export function VitalsStrip({ databaseId }: Props) {
  const query = useQuery({
    queryKey: queryKeys.metrics(databaseId, "24h"),
    queryFn: () => api.get<{ samples: MetricSample[] }>(`/databases/${databaseId}/metrics?range=24h`),
    refetchInterval: (q) => (q.state.error ? false : 30_000),
  });
  const samples = query.data?.samples ?? [];
  const sized = samples.filter((s) => s.sizeBytes != null);
  const first = sized[0];
  const last = sized[sized.length - 1];
  const latest = samples[samples.length - 1];
  const rowSamples = samples.filter((s) => s.rowCount != null);
  const rowDelta =
    rowSamples.length > 1 ? (rowSamples[rowSamples.length - 1]!.rowCount ?? 0) - (rowSamples[0]!.rowCount ?? 0) : null;
  const sizeDelta = first && last && sized.length > 1 ? (last.sizeBytes ?? 0) - (first.sizeBytes ?? 0) : null;

  if (query.isError) return null;

  return (
    <Card flush>
      <div className="grid grid-cols-2 divide-border sm:grid-cols-4 sm:divide-x">
        <Vital
          label="Size"
          value={latest?.sizeBytes != null ? formatBytes(latest.sizeBytes) : "—"}
          hint={sizeDelta != null ? `${formatSignedBytes(sizeDelta)} in 24h` : "24h change pending"}
          loading={query.isPending}
        />
        <Vital
          label="Rows"
          value={latest?.rowCount != null ? formatCount(latest.rowCount) : "—"}
          hint={rowDelta != null ? `${signedCount(rowDelta)} net in 24h` : "24h change pending"}
          loading={query.isPending}
        />
        <Vital label="Tables" value={latest?.tableCount != null ? String(latest.tableCount) : "—"} loading={query.isPending} />
        <Vital
          label="Connections"
          value={latest?.connectionCount != null ? String(latest.connectionCount) : "—"}
          hint="open right now"
          loading={query.isPending}
        />
      </div>
      <div className="border-t border-border px-4 pb-3 pt-2">
        <Ribbon values={sized.map((s) => s.sizeBytes ?? 0)} loading={query.isPending} />
        <div className="mt-1 flex justify-between text-micro text-text-subtle">
          <span>24h ago</span>
          <span>size · {samples.length} samples</span>
          <span>now</span>
        </div>
      </div>
    </Card>
  );
}

function Vital({ label, value, hint, loading }: { label: string; value: string; hint?: string; loading: boolean }) {
  return (
    <div className="min-w-0 px-4 py-3">
      <div className="text-label text-text-muted">{label}</div>
      {loading ? (
        <Skeleton className="mt-1.5 h-5 w-16" />
      ) : (
        <div className="mt-0.5 truncate font-mono text-heading font-medium text-text">{value}</div>
      )}
      {hint && <div className="truncate text-micro text-text-subtle">{loading ? " " : hint}</div>}
    </div>
  );
}

function Ribbon({ values, loading }: { values: number[]; loading: boolean }) {
  const gradientId = useId().replace(/:/g, "");
  const [ref, width] = useElementWidth<HTMLDivElement>();
  const H = 36;
  if (loading) return <Skeleton className="h-9 w-full" />;
  if (values.length < 2) {
    return (
      <div className="grid h-9 place-items-center rounded-md border border-dashed border-border text-micro text-text-subtle">
        The size trend appears after a few samples.
      </div>
    );
  }
  const max = Math.max(...values);
  const min = Math.min(...values);
  const span = Math.max(1, max - min);
  const points = values.map((v, i) => ({
    x: (i / (values.length - 1)) * width,
    y: H - 3 - ((v - min) / span) * (H - 6),
  }));
  const line = smoothPath(points);
  const area = `${line} L ${width.toFixed(1)} ${H} L 0 ${H} Z`;
  return (
    <div ref={ref} className="h-9 w-full" aria-hidden>
      {width > 0 && (
        <svg width={width} height={H} viewBox={`0 0 ${width} ${H}`} className="block">
          <defs>
            <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="rgb(var(--chart-2))" stopOpacity="0.25" />
              <stop offset="100%" stopColor="rgb(var(--chart-2))" stopOpacity="0" />
            </linearGradient>
          </defs>
          <path d={area} fill={`url(#${gradientId})`} />
          <path d={line} fill="none" stroke="rgb(var(--chart-2))" strokeWidth={1.5} strokeLinejoin="round" />
        </svg>
      )}
    </div>
  );
}
