import { useId, useMemo, useState, type KeyboardEvent, type MouseEvent } from "react";
import type { MetricSample } from "@lambdata/shared";
import { formatBytes } from "../../lib/format";
import { smoothPath } from "../../lib/charts";
import { pointTimeLabel } from "../../lib/timeRange";
import { useElementWidth } from "../../lib/useElementWidth";

const HEIGHT = 140;
const TOP = 10;
const BOTTOM = 130;

export function SizeSparkline({ samples, rangeMs }: { samples: MetricSample[]; rangeMs: number }) {
  const gradientId = useId().replace(/:/g, "");
  const [ref, width] = useElementWidth<HTMLDivElement>();
  const [active, setActive] = useState<number | null>(null);
  const points = useMemo(() => samples.filter((s) => s.sizeBytes != null), [samples]);

  const end = points[points.length - 1]?.collectedAt ?? Date.now();
  const start = end - rangeMs;
  const values = points.map((p) => p.sizeBytes ?? 0);
  const max = Math.max(1, ...values);
  const min = Math.min(...values, max);
  const pad = Math.max((max - min) * 0.15, max * 0.02);
  const lo = Math.max(0, min - pad);
  const hi = max + pad;
  const xFor = (t: number) => ((t - start) / Math.max(1, end - start)) * width;
  const yFor = (v: number) => BOTTOM - ((v - lo) / Math.max(1, hi - lo)) * (BOTTOM - TOP);
  const coords = points.map((p) => ({ x: Math.max(0, xFor(p.collectedAt)), y: yFor(p.sizeBytes ?? 0) }));
  const line = smoothPath(coords);
  const area = coords.length > 1 ? `${line} L ${coords[coords.length - 1]!.x.toFixed(1)} ${BOTTOM} L ${coords[0]!.x.toFixed(1)} ${BOTTOM} Z` : "";

  const index = active ?? points.length - 1;
  const current = points[index];
  const marker = coords[index];

  const pick = (event: MouseEvent<HTMLDivElement>) => {
    if (coords.length === 0) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const x = event.clientX - rect.left;
    let best = 0;
    for (let i = 1; i < coords.length; i++) {
      if (Math.abs(coords[i]!.x - x) < Math.abs(coords[best]!.x - x)) best = i;
    }
    setActive(best);
  };

  const onKey = (event: KeyboardEvent<HTMLDivElement>) => {
    if (points.length === 0) return;
    const cur = active ?? points.length - 1;
    if (event.key === "ArrowLeft") setActive(Math.max(0, cur - 1));
    else if (event.key === "ArrowRight") setActive(Math.min(points.length - 1, cur + 1));
    else if (event.key === "Home") setActive(0);
    else if (event.key === "End") setActive(points.length - 1);
    else if (event.key === "Escape") setActive(null);
    else return;
    event.preventDefault();
  };

  if (points.length < 2) {
    return (
      <div className="grid h-[140px] place-items-center rounded-md border border-dashed border-border-strong text-label text-text-muted">
        {points.length === 0 ? "No size samples in this range yet. The collector runs every minute." : "Waiting for a second sample to draw a trend."}
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-baseline gap-x-2 text-label" aria-live="polite">
        <span className="font-mono text-code text-text">{formatBytes(current?.sizeBytes ?? null)}</span>
        <span className="text-text-muted">{current ? pointTimeLabel(current.collectedAt, rangeMs) : ""}</span>
      </div>
      <div
        ref={ref}
        tabIndex={0}
        role="group"
        aria-label="Size over time. Use the arrow keys to step through samples."
        onMouseMove={pick}
        onMouseLeave={() => setActive(null)}
        onKeyDown={onKey}
        onBlur={() => setActive(null)}
        className="relative h-[140px] w-full rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring/70"
      >
        {width > 0 && (
          <svg width={width} height={HEIGHT} viewBox={`0 0 ${width} ${HEIGHT}`} className="block" aria-hidden>
            <defs>
              <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="rgb(var(--chart-2))" stopOpacity="0.28" />
                <stop offset="100%" stopColor="rgb(var(--chart-2))" stopOpacity="0" />
              </linearGradient>
            </defs>
            {[TOP, (TOP + BOTTOM) / 2, BOTTOM].map((y) => (
              <line key={y} x1={0} x2={width} y1={y} y2={y} stroke="rgb(var(--edge))" strokeDasharray={y === BOTTOM ? undefined : "2 4"} />
            ))}
            <path d={area} fill={`url(#${gradientId})`} />
            <path d={line} fill="none" stroke="rgb(var(--chart-2))" strokeWidth={1.75} strokeLinejoin="round" strokeLinecap="round" />
            {marker && (
              <>
                {active !== null && <line x1={marker.x} x2={marker.x} y1={TOP} y2={BOTTOM} stroke="rgb(var(--content-3))" strokeWidth={1} />}
                <circle cx={marker.x} cy={marker.y} r={3.5} fill="rgb(var(--chart-2))" stroke="rgb(var(--surface-panel))" strokeWidth={2} />
              </>
            )}
          </svg>
        )}
        <span className="pointer-events-none absolute right-0 top-0 -translate-y-1/2 bg-bg-panel pl-1.5 font-mono text-micro text-text-subtle">
          {formatBytes(hi)}
        </span>
        <span className="pointer-events-none absolute bottom-0 right-0 translate-y-1/2 bg-bg-panel pl-1.5 font-mono text-micro text-text-subtle">
          {formatBytes(lo)}
        </span>
      </div>
    </div>
  );
}
