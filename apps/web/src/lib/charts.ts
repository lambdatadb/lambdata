export const CHART_COLORS = [
  "rgb(var(--chart-1))",
  "rgb(var(--chart-2))",
  "rgb(var(--chart-3))",
  "rgb(var(--chart-4))",
  "rgb(var(--chart-5))",
  "rgb(var(--chart-6))",
];

export const CHART_OTHER = "rgb(var(--chart-other))";

export const MAX_SERIES = CHART_COLORS.length;

export interface Point {
  x: number;
  y: number;
}

export function smoothPath(points: Point[]): string {
  if (points.length === 0) return "";
  let path = `M ${points[0]!.x.toFixed(1)} ${points[0]!.y.toFixed(1)}`;
  for (let i = 1; i < points.length; i++) {
    const prev = points[i - 1]!;
    const cur = points[i]!;
    const mid = (prev.x + cur.x) / 2;
    path += ` C ${mid.toFixed(1)} ${prev.y.toFixed(1)}, ${mid.toFixed(1)} ${cur.y.toFixed(1)}, ${cur.x.toFixed(1)} ${cur.y.toFixed(1)}`;
  }
  return path;
}

export function smoothLinePath(values: number[], xFor: (i: number) => number, yFor: (v: number) => number): string {
  return smoothPath(values.map((v, i) => ({ x: xFor(i), y: yFor(v) })));
}

export function stackedAreaPath(
  top: number[],
  bottom: number[],
  xFor: (i: number) => number,
  yFor: (v: number) => number,
): string {
  const upper = smoothLinePath(top, xFor, yFor);
  const lower = bottom.map((v, i) => ({ x: xFor(i), y: yFor(v) })).reverse();
  if (lower.length === 0) return upper;
  const back = smoothPath(lower).replace(/^M/, "L");
  return `${upper} ${back} Z`;
}

export function heatLevel(value: number, max: number, levels = 4): number {
  if (value <= 0 || max <= 0) return 0;
  const t = Math.log10(1 + value) / Math.log10(1 + max);
  return Math.max(1, Math.min(levels, Math.ceil(t * levels)));
}

export const HEAT_OPACITY = [0.07, 0.25, 0.45, 0.68, 0.92];

export function heatFill(level: number): string {
  return `rgb(var(--chart-2) / ${HEAT_OPACITY[level] ?? HEAT_OPACITY[0]})`;
}
