import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "react-router-dom";
import type { DashboardSummary, DashboardVitals, TailscaleStatus } from "@kilndb/shared";
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

export function Dashboard() {
  const nav = useNavigate();
  const connection = useConnectionInfo();
  const summary = useQuery({
    queryKey: ["dashboard", "summary"],
    queryFn: () => api.get<DashboardSummary>("/dashboard/summary"),
    refetchInterval: 10_000,
  });
  const vitals = useQuery({
    queryKey: ["dashboard", "vitals"],
    queryFn: () => api.get<DashboardVitals>("/dashboard/vitals?range=30d&maxPoints=120"),
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
          <ClusterVitals data={vitals.data} isLoading={vitals.isLoading} />
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

function ClusterVitals({ data, isLoading }: { data?: DashboardVitals; isLoading: boolean }) {
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

  const series = data?.series ?? [];
  const header = (
    <div className="mb-3 flex items-baseline justify-between">
      <CardTitle>Cluster vitals</CardTitle>
      <span className="text-micro text-text-subtle">storage · 30 days</span>
    </div>
  );

  if (isLoading) {
    return (
      <div className="flex h-full flex-col justify-between">
        {header}
        <Skeleton className="h-40 w-full" />
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

  const BUCKETS = 60;
  const H = 160;
  const PADDING = 8;
  const rangeMs = data?.rangeMs ?? 30 * 24 * 60 * 60 * 1000;
  const now = data?.collectedAt ?? Date.now();
  const rangeStart = now - rangeMs;
  const bucketMs = rangeMs / BUCKETS;

  // Per-series step-wise sizeBytes at each bucket boundary. "last known value"
  // carries forward across empty buckets so the area stays solid even when
  // metric collection is sparse.
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

  // Series beyond the palette fold into one gray "Other" band — hue cycling
  // would make distinct databases indistinguishable.
  const bands: { key: string; label: string; link?: string; color: string; vals: number[] }[] =
    series.slice(0, MAX_SERIES).map((sr, i) => ({
      key: sr.databaseId,
      label: sr.name,
      link: `/databases/${sr.databaseId}`,
      color: CHART_COLORS[i]!,
      vals: rawValues[i]!,
    }));
  if (series.length > MAX_SERIES) {
    const rest = rawValues.slice(MAX_SERIES);
    const summed = new Array<number>(BUCKETS).fill(0);
    for (const vals of rest) for (let b = 0; b < BUCKETS; b++) summed[b]! += vals[b]!;
    bands.push({
      key: "__other",
      label: `other (${series.length - MAX_SERIES})`,
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

  const innerW = Math.max(400, containerW || 800);
  const xFor = (b: number) => (b / (BUCKETS - 1)) * innerW;
  const yFor = (v: number) => H - PADDING - (v / maxStack) * (H - PADDING * 2);

  const polygons = bands.map((_, i) => {
    const pointsList: string[] = [];
    for (let b = 0; b < BUCKETS; b++) {
      pointsList.push(`${xFor(b).toFixed(1)},${yFor(stacked[b]![i]!).toFixed(1)}`);
    }
    for (let b = BUCKETS - 1; b >= 0; b--) {
      const baseline = i > 0 ? stacked[b]![i - 1]! : 0;
      pointsList.push(`${xFor(b).toFixed(1)},${yFor(baseline).toFixed(1)}`);
    }
    return pointsList.join(" ");
  });

  const topEdges = bands.map((_, i) => {
    const pts: string[] = [];
    for (let b = 0; b < BUCKETS; b++) {
      pts.push(`${xFor(b).toFixed(1)},${yFor(stacked[b]![i]!).toFixed(1)}`);
    }
    return pts.join(" ");
  });

  const totalNow = stacked[BUCKETS - 1]?.[bands.length - 1] ?? 0;
  const totalsAtHover =
    hoverBucket != null
      ? bands.map((band) => band.vals[hoverBucket]!)
      : bands.map((band) => band.vals[BUCKETS - 1]!);
  const stackTotalAtHover =
    hoverBucket != null ? stacked[hoverBucket]?.[bands.length - 1] ?? 0 : totalNow;

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
      <div ref={containerRef} className="mt-2 w-full flex-1 min-h-[140px]">
        <svg
          width="100%"
          height={H}
          viewBox={`0 0 ${innerW} ${H}`}
          preserveAspectRatio="none"
          onMouseMove={onMove}
          onMouseLeave={() => setHoverBucket(null)}
          style={{ display: "block", cursor: "crosshair" }}
        >
          {polygons.map((points, i) => (
            <polygon key={bands[i]!.key} points={points} fill={bands[i]!.color} fillOpacity="0.32" />
          ))}
          {topEdges.map((points, i) => (
            <polyline
              key={`edge-${bands[i]!.key}`}
              points={points}
              fill="none"
              stroke="rgb(var(--surface-panel))"
              strokeWidth="2"
              vectorEffect="non-scaling-stroke"
            />
          ))}
          {topEdges.map((points, i) => (
            <polyline
              key={`line-${bands[i]!.key}`}
              points={points}
              fill="none"
              stroke={bands[i]!.color}
              strokeWidth="1"
              vectorEffect="non-scaling-stroke"
            />
          ))}
          {hoverBucket != null && (
            <line
              x1={xFor(hoverBucket)}
              y1={PADDING}
              x2={xFor(hoverBucket)}
              y2={H - PADDING}
              stroke="rgb(var(--edge-strong))"
              strokeWidth="1"
              strokeDasharray="2 3"
              vectorEffect="non-scaling-stroke"
              pointerEvents="none"
            />
          )}
        </svg>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-border pt-3 text-xs">
        <span className="font-mono text-text-muted">
          <span className="text-text">{formatBytes(stackTotalAtHover)}</span>
          {hoverBucket != null && (
            <span className="ml-2 text-text-subtle">
              {bucketTimeLabel(hoverBucket, BUCKETS, bucketMs)}
            </span>
          )}
        </span>
        <span className="text-text-subtle">·</span>
        {bands.map((band, i) => (
          <span key={band.key} className="inline-flex items-center gap-1.5">
            <span
              aria-hidden
              className="inline-block size-2.5 rounded-sm"
              style={{ background: band.color }}
            />
            {band.link ? (
              <Link to={band.link} className="font-mono transition-colors hover:text-accent">
                {band.label}
              </Link>
            ) : (
              <span className="font-mono text-text-muted">{band.label}</span>
            )}
            <span className="tabular-nums text-text-muted">{formatBytes(totalsAtHover[i] ?? 0)}</span>
          </span>
        ))}
      </div>
    </div>
  );
}

function bucketTimeLabel(idx: number, total: number, bucketMs: number): string {
  const msAgo = (total - idx - 1) * bucketMs;
  if (msAgo < 60 * 60_000) return `${Math.round(msAgo / 60_000)}m ago`;
  if (msAgo < 24 * 60 * 60_000) return `${Math.round(msAgo / (60 * 60_000))}h ago`;
  return `${Math.round(msAgo / (24 * 60 * 60_000))}d ago`;
}
