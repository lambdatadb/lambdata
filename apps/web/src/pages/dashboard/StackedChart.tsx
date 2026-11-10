import { useId, type KeyboardEvent, type MouseEvent } from "react";
import type { VitalsChartStyle } from "@lambdata/shared";
import { formatBytes } from "../../lib/format";
import { smoothLinePath, stackedAreaPath } from "../../lib/charts";
import { axisTimeLabel, pointTimeLabel } from "../../lib/timeRange";
import { useElementWidth } from "../../lib/useElementWidth";
import type { StackModel } from "./stack";

const HEIGHT = 248;
const PLOT_TOP = 12;
const PLOT_BOTTOM = 222;

interface Props {
  model: StackModel;
  rangeMs: number;
  style: VitalsChartStyle;
  hover: number | null;
  onHover: (bucket: number | null) => void;
}

export function StackedChart({ model, rangeMs, style, hover, onHover }: Props) {
  const gradientBase = useId().replace(/:/g, "");
  const [ref, width] = useElementWidth<HTMLDivElement>();
  const { bands, stacked, bucketCount, rangeStart, bucketMs } = model;
  const chartMax = model.max * 1.12;
  const xFor = (b: number) => (b / (bucketCount - 1)) * width;
  const yFor = (v: number) => PLOT_BOTTOM - (v / chartMax) * (PLOT_BOTTOM - PLOT_TOP);
  const topAt = (b: number) => stacked[b]?.[bands.length - 1] ?? 0;

  const pick = (event: MouseEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    if (rect.width === 0) return;
    const ratio = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
    onHover(Math.round(ratio * (bucketCount - 1)));
  };

  const onKey = (event: KeyboardEvent<HTMLDivElement>) => {
    const cur = hover ?? bucketCount - 1;
    if (event.key === "ArrowLeft") onHover(Math.max(0, cur - 1));
    else if (event.key === "ArrowRight") onHover(Math.min(bucketCount - 1, cur + 1));
    else if (event.key === "Home") onHover(0);
    else if (event.key === "End") onHover(bucketCount - 1);
    else if (event.key === "Escape") onHover(null);
    else return;
    event.preventDefault();
  };

  const capsuleWidth = Math.max(3, Math.min(10, width / bucketCount - 3));
  const gridLines = [0, 0.5, 1];
  const ticks = [0, Math.floor((bucketCount - 1) / 2), bucketCount - 1];
  const hoverX = hover !== null ? xFor(hover) : null;
  const tooltipLeft = hoverX !== null ? Math.max(72, Math.min(width - 72, hoverX)) : 0;

  return (
    <div
      ref={ref}
      tabIndex={0}
      role="group"
      aria-label="Cluster storage over time. Use the left and right arrow keys to read values."
      onMouseMove={pick}
      onMouseLeave={() => onHover(null)}
      onKeyDown={onKey}
      onBlur={() => onHover(null)}
      className="relative w-full cursor-crosshair rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring/70"
      style={{ height: HEIGHT }}
    >
      {width > 0 && (
        <svg width={width} height={HEIGHT} viewBox={`0 0 ${width} ${HEIGHT}`} className="block" aria-hidden>
          <defs>
            {bands.map((band, index) => (
              <linearGradient key={band.key} id={`${gradientBase}-${index}`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={band.color} stopOpacity="0.38" />
                <stop offset="100%" stopColor={band.color} stopOpacity="0.05" />
              </linearGradient>
            ))}
          </defs>
          {gridLines.map((ratio) => {
            const y = PLOT_BOTTOM - ratio * (PLOT_BOTTOM - PLOT_TOP);
            return (
              <line
                key={ratio}
                x1={0}
                x2={width}
                y1={y}
                y2={y}
                stroke="rgb(var(--edge))"
                strokeDasharray={ratio === 0 ? undefined : "2 4"}
              />
            );
          })}
          {style === "area" ? (
            <>
              {bands.map((band, index) => (
                <path
                  key={`area-${band.key}`}
                  d={stackedAreaPath(
                    stacked.map((column) => column[index] ?? 0),
                    stacked.map((column) => (index > 0 ? column[index - 1] ?? 0 : 0)),
                    xFor,
                    yFor,
                  )}
                  fill={`url(#${gradientBase}-${index})`}
                />
              ))}
              {bands.map((band, index) => (
                <path
                  key={`line-${band.key}`}
                  d={smoothLinePath(stacked.map((column) => column[index] ?? 0), xFor, yFor)}
                  fill="none"
                  stroke={band.color}
                  strokeWidth={1.5}
                  strokeLinejoin="round"
                  strokeLinecap="round"
                />
              ))}
            </>
          ) : (
            stacked.map((column, b) =>
              bands.map((band, index) => {
                const topY = yFor(column[index] ?? 0);
                const bottomY = yFor(index > 0 ? column[index - 1] ?? 0 : 0);
                const h = bottomY - topY;
                if (h <= 0) return null;
                return (
                  <rect
                    key={`${band.key}-${b}`}
                    x={xFor(b) - capsuleWidth / 2}
                    y={topY}
                    width={capsuleWidth}
                    height={h}
                    rx={Math.min(3, capsuleWidth / 2)}
                    fill={band.color}
                    opacity={hover === null || hover === b ? 0.88 : 0.5}
                  />
                );
              }),
            )
          )}
          {hoverX !== null && hover !== null && (
            <g pointerEvents="none">
              <line x1={hoverX} x2={hoverX} y1={PLOT_TOP} y2={PLOT_BOTTOM} stroke="rgb(var(--content-3))" />
              <circle cx={hoverX} cy={yFor(topAt(hover))} r={3.5} fill="rgb(var(--content-1))" stroke="rgb(var(--surface-panel))" strokeWidth={2} />
            </g>
          )}
        </svg>
      )}
      {gridLines
        .filter((ratio) => ratio > 0)
        .map((ratio) => (
          <span
            key={ratio}
            className="pointer-events-none absolute left-0 -translate-y-full pb-0.5 font-mono text-micro text-text-subtle"
            style={{ top: PLOT_BOTTOM - ratio * (PLOT_BOTTOM - PLOT_TOP) }}
          >
            {formatBytes(chartMax * ratio)}
          </span>
        ))}
      {ticks.map((b, i) => (
        <span
          key={b}
          className="pointer-events-none absolute bottom-0 font-mono text-micro text-text-subtle"
          style={
            i === 0
              ? { left: 0 }
              : i === ticks.length - 1
                ? { right: 0 }
                : { left: width > 0 ? xFor(b) : "50%", transform: "translateX(-50%)" }
          }
        >
          {axisTimeLabel(rangeStart + (b + 1) * bucketMs, rangeMs, b === bucketCount - 1)}
        </span>
      ))}
      {hover !== null && width > 0 && (
        <div
          className="pointer-events-none absolute z-10 min-w-36 -translate-x-1/2 rounded-md border border-border-strong bg-bg-overlay px-3 py-2 shadow-raised"
          style={{ left: tooltipLeft, top: Math.max(0, yFor(topAt(hover)) - 64) }}
        >
          <div className="text-micro text-text-subtle">{pointTimeLabel(rangeStart + (hover + 1) * bucketMs, rangeMs)}</div>
          <div className="mt-0.5 font-mono text-code font-medium text-text">{formatBytes(topAt(hover))}</div>
        </div>
      )}
    </div>
  );
}
