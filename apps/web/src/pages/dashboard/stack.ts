import type { DashboardVitalsSeries } from "@lambdata/shared";
import { CHART_COLORS, CHART_OTHER, MAX_SERIES } from "../../lib/charts";

export interface Band {
  key: string;
  label: string;
  databaseId: string | null;
  color: string;
  values: number[];
}

export interface StackModel {
  bands: Band[];
  stacked: number[][];
  bucketCount: number;
  rangeStart: number;
  bucketMs: number;
  max: number;
  totalNow: number;
  totalThen: number;
  idleCount: number;
  empty: boolean;
}

export function bucketSeries(series: DashboardVitalsSeries, rangeStart: number, bucketMs: number, count: number): number[] {
  const values = new Array<number>(count).fill(0);
  let last = 0;
  let i = 0;
  const samples = series.samples;
  for (let b = 0; b < count; b++) {
    const bucketEnd = rangeStart + (b + 1) * bucketMs;
    while (i < samples.length && samples[i]!.collectedAt <= bucketEnd) {
      last = samples[i]!.sizeBytes ?? last;
      i++;
    }
    values[b] = last;
  }
  return values;
}

export function buildStack(
  series: DashboardVitalsSeries[],
  rangeMs: number,
  collectedAt: number,
  bucketCount = 48,
): StackModel {
  const rangeStart = collectedAt - rangeMs;
  const bucketMs = rangeMs / bucketCount;
  const valued = series
    .map((item) => {
      const values = bucketSeries(item, rangeStart, bucketMs, bucketCount);
      return { item, values, current: values[bucketCount - 1] ?? 0 };
    })
    .sort((a, b) => b.current - a.current || a.item.name.localeCompare(b.item.name));
  const visible = valued.filter((v) => v.values.some((x) => x > 0));
  const chartable = visible.length > 0 ? visible : valued;
  const idleCount = valued.length - chartable.length;

  const bands: Band[] = chartable.slice(0, MAX_SERIES).map(({ item, values }, index) => ({
    key: item.databaseId,
    label: item.name,
    databaseId: item.databaseId,
    color: CHART_COLORS[index]!,
    values,
  }));
  if (chartable.length > MAX_SERIES) {
    const summed = new Array<number>(bucketCount).fill(0);
    for (const { values } of chartable.slice(MAX_SERIES)) {
      for (let b = 0; b < bucketCount; b++) summed[b]! += values[b]!;
    }
    bands.push({
      key: "__other",
      label: `${chartable.length - MAX_SERIES} more`,
      databaseId: null,
      color: CHART_OTHER,
      values: summed,
    });
  }

  const stacked: number[][] = [];
  for (let b = 0; b < bucketCount; b++) {
    let sum = 0;
    const column: number[] = [];
    for (const band of bands) {
      sum += band.values[b]!;
      column.push(sum);
    }
    stacked.push(column);
  }
  const top = (b: number) => stacked[b]?.[bands.length - 1] ?? 0;
  const max = Math.max(1, ...stacked.map((_, b) => top(b)));
  const empty = visible.length === 0;

  return {
    bands,
    stacked,
    bucketCount,
    rangeStart,
    bucketMs,
    max,
    totalNow: top(bucketCount - 1),
    totalThen: top(0),
    idleCount,
    empty,
  };
}
