import { useMemo, useState, type KeyboardEvent } from "react";
import type { MetricSample } from "@lambdata/shared";
import { formatCount } from "../../lib/format";
import { heatFill, heatLevel } from "../../lib/charts";
import { bucketAgoLabel } from "../../lib/timeRange";
import { useElementWidth } from "../../lib/useElementWidth";

const ROWS = 7;
const CELL = 12;
const GAP = 3;

export function RowGrowthHeatmap({ samples, rangeMs, rangeLabel }: { samples: MetricSample[]; rangeMs: number; rangeLabel: string }) {
  const [ref, width] = useElementWidth<HTMLDivElement>();
  const [active, setActive] = useState<number | null>(null);
  const cols = Math.max(12, width > 0 ? Math.floor((width + GAP) / (CELL + GAP)) : 30);
  const total = ROWS * cols;
  const bucketMs = rangeMs / total;

  const { buckets, totalGrowth } = useMemo(() => {
    const now = Date.now();
    const rangeStart = now - rangeMs;
    const out = new Array<number>(total).fill(0);
    let sum = 0;
    for (let i = 1; i < samples.length; i++) {
      const prev = samples[i - 1]!;
      const cur = samples[i]!;
      if (prev.rowCount == null || cur.rowCount == null) continue;
      const delta = cur.rowCount - prev.rowCount;
      if (delta <= 0) continue;
      const idx = Math.floor((cur.collectedAt - rangeStart) / bucketMs);
      if (idx < 0 || idx >= total) continue;
      out[idx] = (out[idx] ?? 0) + delta;
      sum += delta;
    }
    return { buckets: out, totalGrowth: sum };
  }, [samples, rangeMs, total, bucketMs]);

  const max = Math.max(0, ...buckets);
  const w = cols * CELL + (cols - 1) * GAP;
  const h = ROWS * CELL + (ROWS - 1) * GAP;

  const onKey = (event: KeyboardEvent<HTMLDivElement>) => {
    const cur = active ?? total - 1;
    let next = cur;
    if (event.key === "ArrowLeft") next = cur - ROWS;
    else if (event.key === "ArrowRight") next = cur + ROWS;
    else if (event.key === "ArrowUp") next = cur - 1;
    else if (event.key === "ArrowDown") next = cur + 1;
    else if (event.key === "Escape") {
      setActive(null);
      return;
    } else return;
    event.preventDefault();
    setActive(Math.min(total - 1, Math.max(0, next)));
  };

  return (
    <div className="space-y-3">
      <div
        ref={ref}
        tabIndex={0}
        role="group"
        aria-label="Row growth by time bucket. Use the arrow keys to read each bucket."
        onKeyDown={onKey}
        onBlur={() => setActive(null)}
        className="w-full rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring/70"
      >
        {width > 0 && (
          <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} shapeRendering="crispEdges" className="block" aria-hidden>
            {buckets.map((count, i) => {
              const col = Math.floor(i / ROWS);
              const row = i % ROWS;
              return (
                <rect
                  key={i}
                  x={col * (CELL + GAP)}
                  y={row * (CELL + GAP)}
                  width={CELL}
                  height={CELL}
                  rx={2}
                  fill={heatFill(heatLevel(count, max))}
                  stroke={active === i ? "rgb(var(--content-1))" : "transparent"}
                  strokeWidth={1}
                  onMouseEnter={() => setActive(i)}
                  onMouseLeave={() => setActive((cur) => (cur === i ? null : cur))}
                />
              );
            })}
          </svg>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-label" aria-live="polite">
        {active !== null ? (
          <span className="text-text-muted">
            <span className="font-mono text-text">{bucketAgoLabel(active, bucketMs, total)}</span>
            {" · "}
            <span className="font-mono text-text">+{formatCount(buckets[active] ?? 0)}</span> rows
          </span>
        ) : (
          <span className="text-text-muted">
            <span className="font-mono text-text">+{formatCount(totalGrowth)}</span> rows of net growth in the last {rangeLabel}
          </span>
        )}
        <div className="ml-auto flex items-center gap-1.5 text-micro text-text-subtle">
          <span>less</span>
          {[0, 1, 2, 3, 4].map((level) => (
            <span key={level} aria-hidden className="inline-block size-2.5 rounded-[2px]" style={{ background: heatFill(level) }} />
          ))}
          <span>more</span>
        </div>
      </div>
    </div>
  );
}
