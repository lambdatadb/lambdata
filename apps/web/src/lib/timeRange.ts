export const HOUR_MS = 60 * 60 * 1000;
export const DAY_MS = 24 * HOUR_MS;

export type VitalsRange = "1d" | "5d" | "15d" | "30d";
export type MetricsRange = "24h" | "7d" | "30d";

export const VITALS_RANGES: { value: VitalsRange; label: string }[] = [
  { value: "1d", label: "1D" },
  { value: "5d", label: "5D" },
  { value: "15d", label: "15D" },
  { value: "30d", label: "30D" },
];

export const METRICS_RANGES: { value: MetricsRange; label: string }[] = [
  { value: "24h", label: "24h" },
  { value: "7d", label: "7d" },
  { value: "30d", label: "30d" },
];

export const METRICS_RANGE_MS: Record<MetricsRange, number> = {
  "24h": DAY_MS,
  "7d": 7 * DAY_MS,
  "30d": 30 * DAY_MS,
};

export function vitalsRangeLabel(range: VitalsRange): string {
  return range === "1d" ? "24 hours" : `${range.slice(0, -1)} days`;
}

export function metricsRangeLabel(range: MetricsRange): string {
  return range === "24h" ? "24 hours" : `${range.slice(0, -1)} days`;
}

export function axisTimeLabel(timestamp: number, rangeMs: number, isNow: boolean): string {
  if (isNow) return "Now";
  return new Intl.DateTimeFormat(undefined, rangeMs <= DAY_MS ? { hour: "numeric" } : { month: "short", day: "numeric" }).format(
    timestamp,
  );
}

export function pointTimeLabel(timestamp: number, rangeMs: number): string {
  return new Intl.DateTimeFormat(
    undefined,
    rangeMs <= DAY_MS
      ? { hour: "numeric", minute: "2-digit" }
      : { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" },
  ).format(timestamp);
}

function shortSpan(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  if (ms < HOUR_MS) return `${Math.round(ms / 60_000)}m`;
  if (ms < DAY_MS) return `${Math.round(ms / HOUR_MS)}h`;
  return `${Math.round(ms / DAY_MS)}d`;
}

export function bucketAgoLabel(index: number, bucketMs: number, total: number): string {
  const start = (total - index - 1) * bucketMs;
  const end = (total - index) * bucketMs;
  return `${shortSpan(end)} to ${shortSpan(start)} ago`;
}
