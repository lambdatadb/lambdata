import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { motion } from "framer-motion";
import type { MetricSample } from "@kilndb/shared";
import { api } from "../../lib/api";
import { RollingNumber } from "../ui/RollingNumber";
import { formatBytes } from "../../lib/format";

interface Props {
  databaseId: string;
}

export function VitalsStrip({ databaseId }: Props) {
  const { data } = useQuery({
    queryKey: ["metrics", databaseId, "24h", "vitals"],
    queryFn: () =>
      api.get<{ samples: MetricSample[] }>(`/databases/${databaseId}/metrics?range=24h`),
    refetchInterval: 30_000,
  });
  const samples = data?.samples ?? [];

  return (
    <section className="relative card-surface overflow-hidden p-0">
      <div className="px-5 pt-4 pb-2 flex items-center justify-between">
        <h3 className="text-[15px] font-semibold tracking-tight">Vitals</h3>
        <span className="text-micro text-text-subtle">
          last 24h · {samples.length} sample{samples.length === 1 ? "" : "s"}
        </span>
      </div>

      <SizeRibbon samples={samples} />
      <WritesPulse samples={samples} />
      <FooterStats samples={samples} />
    </section>
  );
}

// ===== Size ribbon =====

function SizeRibbon({ samples }: { samples: MetricSample[] }) {
  const sizes = samples.map((s) => s.sizeBytes ?? 0);
  const latest = sizes[sizes.length - 1] ?? 0;
  const oldest = sizes[0] ?? 0;
  const delta = oldest === 0 ? 0 : ((latest - oldest) / oldest) * 100;

  return (
    <div className="px-5 pt-2 pb-4 border-b border-border">
      <div className="flex items-baseline justify-between mb-2">
        <div>
          <div className="text-label font-medium text-text-muted">Size</div>
          <div className="mt-0.5 text-2xl font-semibold tracking-tight">
            <RollingNumber value={latest || null} format={(n) => formatBytes(n)} />
          </div>
        </div>
        <div className="text-right">
          <div className="text-label font-medium text-text-muted">Δ 24h</div>
          <div
            className={`mt-0.5 font-mono text-sm ${
              delta > 0 ? "text-success" : delta < 0 ? "text-warn" : "text-text-muted"
            }`}
          >
            <RollingNumber
              value={delta}
              format={(n) => `${n > 0 ? "+" : n < 0 ? "−" : "±"}${Math.abs(n).toFixed(1)}%`}
            />
          </div>
        </div>
      </div>
      <Ribbon values={sizes} />
    </div>
  );
}

function Ribbon({ values }: { values: number[] }) {
  const W = 600;
  const H = 56;
  if (values.length === 0) {
    return <EmptyPanel label="size ribbon will appear once metrics samples accrue" h={H} />;
  }
  if (values.length === 1) {
    // Single sample: render a flat baseline so it doesn't look broken.
    return <EmptyPanel label="awaiting second sample to chart growth" h={H} />;
  }
  const max = Math.max(1, ...values);
  const min = Math.min(...values);
  const span = Math.max(1, max - min);
  const pts = values.map((v, i) => {
    const x = (i / (values.length - 1)) * W;
    const y = H - 4 - ((v - min) / span) * (H - 8);
    return [x, y] as const;
  });
  const linePts = pts.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
  const areaPts = `0,${H} ${linePts} ${W},${H}`;
  return (
    <div className="relative">
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-14" preserveAspectRatio="none">
        <defs>
          <linearGradient id="ribbon-grad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="rgb(var(--accent))" stopOpacity="0.45" />
            <stop offset="100%" stopColor="rgb(var(--accent))" stopOpacity="0" />
          </linearGradient>
          <linearGradient id="ribbon-line" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0%" stopColor="rgb(var(--accent-hover))" />
            <stop offset="100%" stopColor="rgb(var(--accent))" />
          </linearGradient>
        </defs>
        <motion.polygon
          points={areaPts}
          fill="url(#ribbon-grad)"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.4 }}
        />
        <motion.polyline
          points={linePts}
          fill="none"
          stroke="url(#ribbon-line)"
          strokeWidth="1.6"
          strokeLinejoin="round"
          strokeLinecap="round"
          initial={{ pathLength: 0 }}
          animate={{ pathLength: 1 }}
          transition={{ duration: 0.6, ease: "easeOut" }}
        />
        {pts.length > 0 && (() => {
          const [lx, ly] = pts[pts.length - 1]!;
          return (
            <g>
              <circle cx={lx} cy={ly} r="5" fill="rgb(var(--accent))" opacity="0.22" />
              <circle cx={lx} cy={ly} r="2.5" fill="rgb(var(--accent))" />
            </g>
          );
        })()}
      </svg>
    </div>
  );
}

// ===== Writes pulse =====

function WritesPulse({ samples }: { samples: MetricSample[] }) {
  // Compute |Δrow_count| between consecutive samples, normalize per minute.
  const pulses = useMemo(() => {
    const out: { perMin: number; ts: number }[] = [];
    for (let i = 1; i < samples.length; i++) {
      const a = samples[i - 1]!;
      const b = samples[i]!;
      if (a.rowCount == null || b.rowCount == null) continue;
      const dtMin = (b.collectedAt - a.collectedAt) / 60_000;
      if (dtMin <= 0) continue;
      const perMin = Math.abs(b.rowCount - a.rowCount) / dtMin;
      out.push({ perMin, ts: b.collectedAt });
    }
    return out;
  }, [samples]);

  const peak = Math.max(0, ...pulses.map((p) => p.perMin));
  const totalRows = samples[samples.length - 1]?.rowCount ?? null;

  return (
    <div className="px-5 pt-3 pb-4 border-b border-border">
      <div className="flex items-baseline justify-between mb-2">
        <div>
          <div className="text-label font-medium text-text-muted">Writes / min</div>
          <div className="mt-0.5 text-2xl font-semibold tracking-tight">
            <RollingNumber
              value={pulses.length === 0 ? null : pulses[pulses.length - 1]!.perMin}
              format={(n) => n.toFixed(n < 10 ? 1 : 0)}
            />
          </div>
        </div>
        <div className="text-right">
          <div className="text-label font-medium text-text-muted">Peak</div>
          <div className="mt-0.5 font-mono tabular-nums text-sm text-text-muted">
            {peak === 0 ? "—" : peak.toFixed(peak < 10 ? 1 : 0)}/m
          </div>
        </div>
      </div>
      <Bars values={pulses.map((p) => p.perMin)} totalRows={totalRows} />
    </div>
  );
}

function Bars({ values, totalRows }: { values: number[]; totalRows: number | null }) {
  const H = 40;
  if (values.length === 0) {
    return (
      <EmptyPanel
        label={totalRows == null ? "write rate appears after the second metrics poll" : "no writes detected in window"}
        h={H}
      />
    );
  }
  const max = Math.max(1, ...values);
  // Always render up to 48 slots for visual stability (~ last 48 minutes)
  const SLOTS = 48;
  const padded = Array.from({ length: SLOTS }, (_, i) => {
    const offset = SLOTS - values.length;
    const idx = i - offset;
    return idx >= 0 ? values[idx] ?? 0 : null;
  });
  return (
    <div className="flex items-end gap-[3px] h-10">
      {padded.map((v, i) => {
        if (v === null) {
          return (
            <span
              key={i}
              className="flex-1 h-px self-end rounded-sm bg-border/40"
              style={{ minHeight: 1 }}
            />
          );
        }
        const heightPct = Math.max(2, (v / max) * 100);
        const hot = v / max > 0.7;
        return (
          <motion.span
            key={i}
            initial={{ scaleY: 0, opacity: 0 }}
            animate={{ scaleY: 1, opacity: 1 }}
            transition={{ duration: 0.25 }}
            style={{
              height: `${heightPct}%`,
              transformOrigin: "bottom",
            }}
            className={`flex-1 rounded-sm ${
              hot ? "bg-accent" : "bg-accent/55"
            }`}
            title={`${v.toFixed(1)} / min`}
          />
        );
      })}
    </div>
  );
}

// ===== Footer stats =====

function FooterStats({ samples }: { samples: MetricSample[] }) {
  const latest = samples[samples.length - 1];
  return (
    <div className="px-5 py-3 grid grid-cols-3 divide-x divide-border text-center">
      <Stat label="Tables" value={latest?.tableCount ?? "—"} />
      <Stat label="Rows" value={latest?.rowCount ?? "—"} />
      <Stat label="Connections" value={latest?.connectionCount ?? 0} />
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <div>
      <div className="text-label font-medium text-text-muted">{label}</div>
      <div className="mt-0.5 font-mono text-sm tabular-nums text-text">{value}</div>
    </div>
  );
}

// ===== Misc =====

function EmptyPanel({ label, h }: { label: string; h: number }) {
  return (
    <div
      className="flex items-center justify-center text-micro text-text-subtle rounded-md bg-bg-subtle/40 border border-dashed border-border"
      style={{ height: h }}
    >
      {label}
    </div>
  );
}
