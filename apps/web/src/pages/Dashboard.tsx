import { useEffect, useId, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "react-router-dom";
import { motion } from "framer-motion";
import type {
  DashboardSummary,
  DashboardVitals,
  TailscaleStatus,
  VitalsChartStyle,
} from "@kilndb/shared";
import { api } from "../lib/api";
import { PageHeader } from "../components/layout/PageShell";
import { Card, CardTitle } from "../components/ui/Card";
import { Badge } from "../components/ui/Badge";
import { Button } from "../components/ui/Button";
import { EmptyState } from "../components/ui/EmptyState";
import { Icon } from "../components/ui/Icon";
import { RollingNumber } from "../components/ui/RollingNumber";
import { Skeleton } from "../components/ui/Skeleton";
import { StatTile } from "../components/ui/StatTile";
import { Table, TBody, TD, TH, THead, TR, TableSkeleton } from "../components/ui/Table";
import { formatBytes, formatRelativeTime } from "../lib/format";
import { formatConnectionAddress, useConnectionInfo } from "../lib/useConnectionInfo";
import { useAuth } from "../lib/auth";

type VitalsRange = "1d" | "5d" | "15d" | "30d";

const VITALS_RANGES: { value: VitalsRange; label: string }[] = [
  { value: "1d", label: "1D" },
  { value: "5d", label: "5D" },
  { value: "15d", label: "15D" },
  { value: "30d", label: "30D" },
];

export function Dashboard() {
  const nav = useNavigate();
  const { user } = useAuth();
  const connection = useConnectionInfo();
  const [vitalsRange, setVitalsRange] = useState<VitalsRange>("30d");
  const summary = useQuery({
    queryKey: ["dashboard", "summary"],
    queryFn: () => api.get<DashboardSummary>("/dashboard/summary"),
    refetchInterval: 10_000,
  });
  const vitals = useQuery({
    queryKey: ["dashboard", "vitals", vitalsRange],
    queryFn: () => api.get<DashboardVitals>(`/dashboard/vitals?range=${vitalsRange}&maxPoints=96`),
    placeholderData: (previous) => previous,
    refetchInterval: 60_000,
  });
  const tailscale = useQuery({
    queryKey: ["tailscale", "status"],
    queryFn: () => api.get<TailscaleStatus>("/tailscale/status"),
    refetchInterval: 30_000,
    enabled: summary.data?.system.dashboardShowAddresses !== false,
  });

  const s = summary.data;
  const publicAddress = formatConnectionAddress(connection.host, connection.port);
  const tailnetAddress =
    tailscale.data?.running && tailscale.data.tailnetIp
      ? formatConnectionAddress(tailscale.data.tailnetIp, connection.port)
      : null;

  return (
    <>
      <PageHeader
        title="Overview"
        subtitle={
          s?.system.dashboardShowAddresses ? (
            <span className="flex flex-wrap items-center gap-x-3 gap-y-1 font-mono">
              <span className="inline-flex items-center gap-1.5">
                <span className="text-micro uppercase tracking-wide text-text-subtle">Public</span>
                <span>{publicAddress}</span>
              </span>
              {tailnetAddress && (
                <>
                  <span className="text-text-subtle">·</span>
                  <span className="inline-flex items-center gap-1.5">
                    <span className="text-micro uppercase tracking-wide text-text-subtle">Tailnet</span>
                    <span>{tailnetAddress}</span>
                  </span>
                </>
              )}
            </span>
          ) : undefined
        }
        actions={
          <>
            {s && (
              <Badge tone={s.system.mariadbOk ? "success" : "danger"}>
                {s.system.mariadbOk ? "MariaDB up" : "MariaDB down"}
              </Badge>
            )}
            <Link to="/databases">
              <Button size="sm">
                <Icon name="add" size={14} />
                New database
              </Button>
            </Link>
          </>
        }
      />

      {s && s.sync.failing > 0 && (
        <Card className="mb-5 border-warn/40 bg-warn/10 p-4">
          <div className="flex items-start gap-3">
            <Icon name="warning" size={16} className="mt-0.5 text-warn" />
            <div className="min-w-0 flex-1 text-body">
              <span className="font-medium text-warn">
                {s.sync.failing} mirror {s.sync.failing === 1 ? "sync is" : "syncs are"} failing.
              </span>{" "}
              {s.sync.lastError && (
                <span className="break-words text-text-muted">{s.sync.lastError}</span>
              )}
            </div>
            <Link to="/databases" className="shrink-0 text-label font-medium text-warn hover:underline">
              Review
            </Link>
          </div>
        </Card>
      )}

      {s ? (
        <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-4">
          <StatTile
            label="Databases"
            icon="database"
            value={s.databases.total}
            hint={`${s.databases.active} active · ${s.databases.mirrors} mirrors`}
          />
          <StatTile
            label="Storage"
            icon="hard_drive"
            value={s.storage.totalSizeBytes}
            format={formatBytes}
            hint={`${s.storage.buckets} buckets · ${s.storage.objects} objects`}
          />
          <StatTile
            label="Snapshots (24h)"
            icon="history"
            value={s.snapshots.last24hCount}
            hint={s.snapshots.lastAt ? `last ${formatRelativeTime(s.snapshots.lastAt)}` : "none yet"}
          />
          <StatTile
            label="Realtime"
            icon="sensors"
            value={s.realtime.connections}
            hint={`${s.realtime.channels} channels · ${s.realtime.messagesSent} messages sent`}
          />
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-4">
          {Array.from({ length: 4 }, (_, i) => (
            <Card key={i} className="p-4">
              <Skeleton className="h-3 w-20" />
              <Skeleton className="mt-3 h-6 w-24" />
              <Skeleton className="mt-2 h-2.5 w-28" />
            </Card>
          ))}
        </div>
      )}

      {s && (
        <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-micro text-text-subtle">
          <span className="inline-flex items-center gap-1.5">
            disk free
            <span className="font-mono text-text-muted">
              <RollingNumber value={s.system.dataDirFreeBytes} format={formatBytes} />
            </span>
          </span>
          <span>·</span>
          <span>
            {s.functions.total} functions · {s.functions.invocations24h} invocations (24h)
          </span>
        </div>
      )}

      <div className="mt-5 grid grid-cols-1 gap-5 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <ClusterVitals
            data={vitals.data}
            isLoading={vitals.isLoading}
            isFetching={vitals.isFetching}
            range={vitalsRange}
            onRangeChange={setVitalsRange}
            style={user?.vitalsChartStyle ?? "area"}
          />
        </Card>
        <div className="flex flex-col gap-5">
          <Card>
            <CardTitle>Mirrors</CardTitle>
            {s ? (
              s.sync.mirrors === 0 ? (
                <p className="mt-3 text-body text-text-muted">No mirror databases.</p>
              ) : (
                <div className="mt-3 space-y-2 text-body">
                  <div className="flex items-center justify-between">
                    <span className="text-text-muted">Syncing</span>
                    <span className="font-mono tabular-nums text-success">{s.sync.ok}</span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-text-muted">Failing</span>
                    <span className={`font-mono tabular-nums ${s.sync.failing > 0 ? "text-danger" : "text-text-subtle"}`}>
                      {s.sync.failing}
                    </span>
                  </div>
                </div>
              )
            ) : (
              <Skeleton className="mt-3 h-12 w-full" />
            )}
          </Card>
          <Card>
            <CardTitle>Snapshots</CardTitle>
            {s ? (
              <div className="mt-3 space-y-2 text-body">
                <div className="flex items-center justify-between">
                  <span className="text-text-muted">Retained</span>
                  <span className="font-mono tabular-nums">{s.snapshots.total}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-text-muted">Last taken</span>
                  <span className="text-text-muted">
                    {s.snapshots.lastAt ? formatRelativeTime(s.snapshots.lastAt) : "—"}
                  </span>
                </div>
              </div>
            ) : (
              <Skeleton className="mt-3 h-12 w-full" />
            )}
          </Card>
        </div>
      </div>

      <div className="mt-5">
        {s && s.latestMetrics.length === 0 ? (
          <EmptyState
            icon="database"
            title="No databases yet"
            description="Provision your first database to start tracking size, tables, and connections."
            action={
              <Link to="/databases">
                <Button size="sm">
                  <Icon name="add" size={14} />
                  New database
                </Button>
              </Link>
            }
          />
        ) : (
          <Table>
            <THead>
              <tr>
                <TH>Name</TH>
                <TH>Kind</TH>
                <TH className="text-right">Size</TH>
                <TH className="text-right">Tables</TH>
                <TH className="text-right">Connections</TH>
                <TH>Sampled</TH>
              </tr>
            </THead>
            <TBody>
              {!s ? (
                <TableSkeleton rows={3} cols={6} />
              ) : (
                s.latestMetrics.map((m) => (
                  <TR
                    key={m.databaseId}
                    className="cursor-pointer"
                    onClick={() => nav(`/databases/${m.databaseId}`)}
                  >
                    <TD>
                      <div className="font-medium">{m.displayName}</div>
                      <div className="font-mono text-micro text-text-subtle">{m.name}</div>
                    </TD>
                    <TD>
                      <Badge tone={m.kind === "mirror" ? "accent" : "muted"}>{m.kind}</Badge>
                    </TD>
                    <TD numeric>{m.sizeBytes !== null ? formatBytes(m.sizeBytes) : "—"}</TD>
                    <TD numeric>{m.tableCount ?? "—"}</TD>
                    <TD numeric>{m.connectionCount ?? "—"}</TD>
                    <TD className="text-text-muted">
                      {m.collectedAt ? formatRelativeTime(m.collectedAt) : "—"}
                    </TD>
                  </TR>
                ))
              )}
            </TBody>
          </Table>
        )}
      </div>
    </>
  );
}

const CHART_COLORS = [
  "rgb(var(--chart-1))",
  "rgb(var(--chart-2))",
  "rgb(var(--chart-3))",
  "rgb(var(--chart-4))",
  "rgb(var(--chart-5))",
  "rgb(var(--chart-6))",
];
const CHART_OTHER = "rgb(var(--chart-other))";
const MAX_SERIES = 6;

function ClusterVitals({
  data,
  isLoading,
  isFetching,
  range,
  onRangeChange,
  style,
}: {
  data?: DashboardVitals;
  isLoading: boolean;
  isFetching: boolean;
  range: VitalsRange;
  onRangeChange: (range: VitalsRange) => void;
  style: VitalsChartStyle;
}) {
  const chartId = useId().replace(/:/g, "");
  const containerRef = useRef<HTMLDivElement>(null);
  const [containerW, setContainerW] = useState(0);
  const [hoverBucket, setHoverBucket] = useState<number | null>(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setContainerW(el.clientWidth));
    ro.observe(el);
    setContainerW(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  useEffect(() => setHoverBucket(null), [data?.rangeMs, style]);

  const series = data?.series ?? [];
  const header = (
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div>
        <CardTitle>Cluster vitals</CardTitle>
        <div className="mt-0.5 flex items-center gap-1.5 text-micro text-text-subtle">
          <span>Storage footprint</span>
          <span>·</span>
          <span>{series.length} {series.length === 1 ? "database" : "databases"}</span>
          {isFetching && <span className="size-1.5 animate-pulse rounded-full bg-accent" aria-label="Refreshing" />}
        </div>
      </div>
      <div className="relative flex rounded-md border border-border bg-bg p-0.5" role="group" aria-label="Cluster vitals range">
        {VITALS_RANGES.map((option) => {
          const active = option.value === range;
          return (
            <button
              key={option.value}
              type="button"
              aria-pressed={active}
              onClick={() => onRangeChange(option.value)}
              className={`cluster-vitals-range-button relative z-0 min-h-11 min-w-11 rounded px-2 text-micro font-medium ${
                active ? "text-text" : "text-text-subtle hover:text-text"
              }`}
            >
              {active && (
                <motion.span
                  layoutId="cluster-vitals-range"
                  className="absolute inset-0 -z-10 rounded bg-bg-subtle shadow-card"
                  transition={{ duration: 0.22, ease: [0.16, 1, 0.3, 1] }}
                />
              )}
              {option.label}
            </button>
          );
        })}
      </div>
    </div>
  );

  if (isLoading) {
    return (
      <div className="flex h-full flex-col justify-between">
        {header}
        <Skeleton className="mt-5 h-56 w-full" />
      </div>
    );
  }

  if (series.length === 0) {
    return (
      <div className="flex h-full flex-col justify-between">
        {header}
        <p className="py-6 text-body text-text-muted">
          No databases yet — create one to start tracking cluster trends.
        </p>
      </div>
    );
  }

  const BUCKETS = 48;
  const H = 236;
  const PLOT_TOP = 24;
  const PLOT_BOTTOM = 202;
  const rangeMs = data?.rangeMs ?? 30 * 24 * 60 * 60 * 1000;
  const now = data?.collectedAt ?? Date.now();
  const rangeStart = now - rangeMs;
  const bucketMs = rangeMs / BUCKETS;

  const rawValues = series.map((sr) => {
    const vals = new Array<number>(BUCKETS).fill(0);
    let last = 0;
    let i = 0;
    for (let b = 0; b < BUCKETS; b++) {
      const bucketEnd = rangeStart + (b + 1) * bucketMs;
      while (i < sr.samples.length && sr.samples[i]!.collectedAt <= bucketEnd) {
        last = sr.samples[i]!.sizeBytes ?? last;
        i++;
      }
      vals[b] = last;
    }
    return vals;
  });

  const valuedSeries = series
    .map((item, index) => ({
      item,
      vals: rawValues[index]!,
      current: rawValues[index]![BUCKETS - 1] ?? 0,
    }))
    .sort((a, b) => b.current - a.current);
  const visibleSeries = valuedSeries.filter((item) => item.vals.some((value) => value > 0));
  const chartSeries = visibleSeries.length > 0 ? visibleSeries : valuedSeries;
  const idleCount = valuedSeries.length - visibleSeries.length;
  const bands: { key: string; label: string; link?: string; color: string; vals: number[] }[] =
    chartSeries.slice(0, MAX_SERIES).map(({ item, vals }, index) => ({
      key: item.databaseId,
      label: item.name,
      link: `/databases/${item.databaseId}`,
      color: CHART_COLORS[index]!,
      vals,
    }));
  if (chartSeries.length > MAX_SERIES) {
    const rest = chartSeries.slice(MAX_SERIES).map((item) => item.vals);
    const summed = new Array<number>(BUCKETS).fill(0);
    for (const vals of rest) for (let b = 0; b < BUCKETS; b++) summed[b]! += vals[b]!;
    bands.push({
      key: "__other",
      label: `other (${chartSeries.length - MAX_SERIES})`,
      color: CHART_OTHER,
      vals: summed,
    });
  }

  const stacked: number[][] = [];
  for (let b = 0; b < BUCKETS; b++) {
    let cum = 0;
    const col: number[] = [];
    for (const band of bands) {
      cum += band.vals[b]!;
      col.push(cum);
    }
    stacked.push(col);
  }
  const maxStack = Math.max(1, ...stacked.map((col) => col[col.length - 1] ?? 0));
  const chartMax = maxStack * 1.12;

  const innerW = Math.max(1, containerW || 800);
  const xFor = (b: number) => (b / (BUCKETS - 1)) * innerW;
  const yFor = (v: number) =>
    PLOT_BOTTOM - (v / chartMax) * (PLOT_BOTTOM - PLOT_TOP);
  const areaPaths = bands.map((_, index) => {
    const top = stacked.map((column) => column[index] ?? 0);
    const bottom = stacked.map((column) => index > 0 ? column[index - 1] ?? 0 : 0);
    return stackedAreaPath(top, bottom, xFor, yFor);
  });
  const linePaths = bands.map((_, index) =>
    smoothLinePath(stacked.map((column) => column[index] ?? 0), xFor, yFor),
  );
  const capsuleWidth = Math.max(3, Math.min(10, innerW / BUCKETS - 3));

  const totalNow = stacked[BUCKETS - 1]?.[bands.length - 1] ?? 0;
  const totalThen = stacked[0]?.[bands.length - 1] ?? 0;
  const totalDelta = totalNow - totalThen;
  const totalsAtHover =
    hoverBucket != null
      ? bands.map((band) => band.vals[hoverBucket]!)
      : bands.map((band) => band.vals[BUCKETS - 1]!);
  const stackTotalAtHover =
    hoverBucket != null ? stacked[hoverBucket]?.[bands.length - 1] ?? 0 : totalNow;
  const hoverTime = hoverBucket != null
    ? rangeStart + (hoverBucket + 1) * bucketMs
    : now;
  const hoverX = hoverBucket != null ? xFor(hoverBucket) : innerW;
  const hoverY = yFor(stackTotalAtHover);
  const tooltipLeft = Math.max(76, Math.min(innerW - 76, hoverX));
  const capsules = stacked.flatMap((column, bucketIndex) =>
    bands.flatMap((band, bandIndex) => {
      const topValue = column[bandIndex] ?? 0;
      const bottomValue = bandIndex > 0 ? column[bandIndex - 1] ?? 0 : 0;
      const topY = yFor(topValue);
      const bottomY = yFor(bottomValue);
      const height = bottomY - topY;
      return height > 0
        ? [{
            key: `${band.key}-${bucketIndex}`,
            x: xFor(bucketIndex) - capsuleWidth / 2,
            y: topY,
            height,
            color: band.color,
            delay: bucketIndex / BUCKETS * 0.22,
          }]
        : [];
    }),
  );

  const onMove = (e: React.MouseEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    if (rect.width === 0) return;
    const px = e.clientX - rect.left;
    const ratio = Math.max(0, Math.min(1, px / rect.width));
    setHoverBucket(Math.round(ratio * (BUCKETS - 1)));
  };

  return (
    <div className="flex h-full flex-col justify-between">
      {header}
      <div className="mt-4 flex flex-wrap items-end gap-x-3 gap-y-1">
        <span className="font-mono text-2xl font-semibold tracking-tight tabular-nums text-text">
          {formatBytes(totalNow)}
        </span>
        <span className={`mb-0.5 text-label font-medium ${
          totalDelta > 0 ? "text-success" : totalDelta < 0 ? "text-warn" : "text-text-subtle"
        }`}>
          {formatStorageDelta(totalDelta)} over {rangeLabel(range)}
        </span>
      </div>

      <div ref={containerRef} className="relative mt-3 w-full flex-1">
        <svg
          width="100%"
          height={H}
          viewBox={`0 0 ${innerW} ${H}`}
          preserveAspectRatio="none"
          onMouseMove={onMove}
          onMouseLeave={() => setHoverBucket(null)}
          className="block cursor-crosshair"
          role="img"
          aria-label={`Cluster storage history, ${formatBytes(totalNow)} currently used`}
        >
          <defs>
            {bands.map((band, index) => (
              <linearGradient key={band.key} id={`${chartId}-gradient-${index}`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={band.color} stopOpacity="0.42" />
                <stop offset="100%" stopColor={band.color} stopOpacity="0.04" />
              </linearGradient>
            ))}
            <clipPath id={`${chartId}-reveal`}>
              <motion.rect
                key={`${style}-${rangeMs}`}
                x="0"
                y="0"
                height={H}
                initial={{ width: 0 }}
                animate={{ width: innerW }}
                transition={{ duration: 0.65, ease: [0.22, 1, 0.36, 1] }}
              />
            </clipPath>
          </defs>

          {[0, 0.5, 1].map((ratio) => {
            const y = PLOT_BOTTOM - ratio * (PLOT_BOTTOM - PLOT_TOP);
            return (
              <g key={ratio}>
                <line
                  x1="0"
                  x2={innerW}
                  y1={y}
                  y2={y}
                  stroke="rgb(var(--edge))"
                  strokeWidth="1"
                  vectorEffect="non-scaling-stroke"
                />
                {ratio > 0 && (
                  <text x="0" y={y - 7} fill="rgb(var(--content-3))" fontSize="11">
                    {formatBytes(chartMax * ratio)}
                  </text>
                )}
              </g>
            );
          })}

          {[0, Math.floor((BUCKETS - 1) / 2), BUCKETS - 1].map((bucketIndex) => (
            <text
              key={bucketIndex}
              x={xFor(bucketIndex)}
              y={H - 4}
              textAnchor={bucketIndex === 0 ? "start" : bucketIndex === BUCKETS - 1 ? "end" : "middle"}
              fill="rgb(var(--content-3))"
              fontSize="11"
            >
              {axisTimeLabel(
                rangeStart + (bucketIndex + 1) * bucketMs,
                rangeMs,
                bucketIndex === BUCKETS - 1,
              )}
            </text>
          ))}

          <g clipPath={`url(#${chartId}-reveal)`}>
            {style === "area" ? (
              <>
                {areaPaths.map((path, index) => (
                  <motion.path
                    key={`area-${bands[index]!.key}`}
                    d={path}
                    fill={`url(#${chartId}-gradient-${index})`}
                    initial={{ opacity: 0.25 }}
                    animate={{ opacity: 1 }}
                    transition={{ duration: 0.48, ease: [0.16, 1, 0.3, 1] }}
                  />
                ))}
                {linePaths.map((path, index) => (
                  <motion.path
                    key={`line-${bands[index]!.key}`}
                    d={path}
                    fill="none"
                    stroke={bands[index]!.color}
                    strokeWidth="1.6"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    vectorEffect="non-scaling-stroke"
                    initial={{ pathLength: 0 }}
                    animate={{ pathLength: 1 }}
                    transition={{ duration: 0.68, ease: [0.16, 1, 0.3, 1] }}
                  />
                ))}
              </>
            ) : (
              capsules.map((capsule) => (
                <motion.rect
                  key={capsule.key}
                  x={capsule.x}
                  width={capsuleWidth}
                  rx={Math.min(4, capsuleWidth / 2)}
                  fill={capsule.color}
                  initial={{ y: PLOT_BOTTOM, height: 0, opacity: 0.3 }}
                  animate={{ y: capsule.y, height: capsule.height, opacity: 0.86 }}
                  transition={{
                    delay: capsule.delay,
                    duration: 0.46,
                    ease: [0.22, 1, 0.36, 1],
                  }}
                />
              ))
            )}
          </g>

          {hoverBucket != null && (
            <g pointerEvents="none">
              <motion.line
                x1={hoverX}
                y1={PLOT_TOP}
                x2={hoverX}
                y2={PLOT_BOTTOM}
                stroke="rgb(var(--content-3))"
                strokeWidth="1"
                vectorEffect="non-scaling-stroke"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
              />
              <motion.circle
                cx={hoverX}
                cy={hoverY}
                r="4"
                fill="rgb(var(--chart-1))"
                stroke="rgb(var(--surface-panel))"
                strokeWidth="2"
                vectorEffect="non-scaling-stroke"
                initial={{ scale: 0 }}
                animate={{ scale: 1 }}
              />
            </g>
          )}
        </svg>

        {hoverBucket != null && (
          <div
            className="pointer-events-none absolute z-10 min-w-36 -translate-x-1/2 rounded-md border border-border bg-bg-overlay px-3 py-2 shadow-raised"
            style={{ left: tooltipLeft, top: Math.max(4, hoverY - 58) }}
          >
            <div className="text-micro text-text-subtle">{hoverTimeLabel(hoverTime, rangeMs)}</div>
            <div className="mt-0.5 font-mono text-body font-medium tabular-nums text-text">
              {formatBytes(stackTotalAtHover)}
            </div>
          </div>
        )}
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-border pt-3 text-label">
        {bands.map((band, i) => (
          <span key={band.key} className="inline-flex items-center gap-1.5">
            <span
              aria-hidden
              className="inline-block size-2 rounded-full"
              style={{ background: band.color }}
            />
            {band.link ? (
              <Link to={band.link} className="font-mono text-text-muted transition-colors hover:text-accent">
                {band.label}
              </Link>
            ) : (
              <span className="font-mono text-text-muted">{band.label}</span>
            )}
            <span className="tabular-nums text-text-muted">{formatBytes(totalsAtHover[i] ?? 0)}</span>
          </span>
        ))}
        {idleCount > 0 && (
          <span className="text-micro text-text-subtle">
            {idleCount} idle {idleCount === 1 ? "database" : "databases"} hidden
          </span>
        )}
      </div>
    </div>
  );
}

function smoothLinePath(
  values: number[],
  xFor: (index: number) => number,
  yFor: (value: number) => number,
): string {
  const points = values.map((value, index) => ({ x: xFor(index), y: yFor(value) }));
  if (points.length === 0) return "";
  let path = `M ${points[0]!.x.toFixed(1)} ${points[0]!.y.toFixed(1)}`;
  for (let index = 1; index < points.length; index++) {
    const previous = points[index - 1]!;
    const current = points[index]!;
    const midpoint = (previous.x + current.x) / 2;
    path += ` C ${midpoint.toFixed(1)} ${previous.y.toFixed(1)}, ${midpoint.toFixed(1)} ${current.y.toFixed(1)}, ${current.x.toFixed(1)} ${current.y.toFixed(1)}`;
  }
  return path;
}

function stackedAreaPath(
  top: number[],
  bottom: number[],
  xFor: (index: number) => number,
  yFor: (value: number) => number,
): string {
  const topPath = smoothLinePath(top, xFor, yFor);
  const reversedBottom = bottom.map((value, index) => ({
    x: xFor(index),
    y: yFor(value),
  })).reverse();
  if (reversedBottom.length === 0) return topPath;
  let path = `${topPath} L ${reversedBottom[0]!.x.toFixed(1)} ${reversedBottom[0]!.y.toFixed(1)}`;
  for (let index = 1; index < reversedBottom.length; index++) {
    const previous = reversedBottom[index - 1]!;
    const current = reversedBottom[index]!;
    const midpoint = (previous.x + current.x) / 2;
    path += ` C ${midpoint.toFixed(1)} ${previous.y.toFixed(1)}, ${midpoint.toFixed(1)} ${current.y.toFixed(1)}, ${current.x.toFixed(1)} ${current.y.toFixed(1)}`;
  }
  return `${path} Z`;
}

function rangeLabel(range: VitalsRange): string {
  return range === "1d" ? "24 hours" : `${range.slice(0, -1)} days`;
}

function formatStorageDelta(value: number): string {
  if (value === 0) return "No change";
  return `${value > 0 ? "+" : "−"}${formatBytes(Math.abs(value))}`;
}

function axisTimeLabel(timestamp: number, rangeMs: number, isNow: boolean): string {
  if (isNow) return "Now";
  return new Intl.DateTimeFormat(undefined, rangeMs <= 24 * 60 * 60_000
    ? { hour: "numeric" }
    : { month: "short", day: "numeric" }).format(timestamp);
}

function hoverTimeLabel(timestamp: number, rangeMs: number): string {
  return new Intl.DateTimeFormat(undefined, rangeMs <= 24 * 60 * 60_000
    ? { hour: "numeric", minute: "2-digit" }
    : { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(timestamp);
}
