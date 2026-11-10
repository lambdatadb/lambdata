import { databases, metrics } from "../db/queries";
import { getDatabaseMetrics } from "../mariadb/manager";
import { intervalService, registerService } from "../lifecycle";

const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
export const MIN_REFRESH_INTERVAL_MS = 30_000;

type Sample = {
  sizeBytes: number | null;
  tableCount: number | null;
  connectionCount: number | null;
  rowCount: number | null;
};

let inFlight: Promise<void> | null = null;
let lastFinishedAt = 0;

export function exactCount(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function exactSample(m: Sample): Sample {
  return {
    sizeBytes: exactCount(m.sizeBytes),
    tableCount: exactCount(m.tableCount),
    connectionCount: exactCount(m.connectionCount),
    rowCount: exactCount(m.rowCount),
  };
}

async function collectFor(id: string, name: string): Promise<void> {
  try {
    metrics.insert(id, exactSample(await getDatabaseMetrics(name)));
  } catch (err) {
    console.error("[metrics] failed for", name, err);
  }
}

export async function collectMetricsFor(databaseId: string): Promise<void> {
  const d = databases.byId(databaseId);
  if (d) await collectFor(d.id, d.name);
}

async function collectOlderThan(maxAgeMs: number): Promise<void> {
  const cutoff = Date.now() - maxAgeMs;
  for (const d of databases.list()) {
    const latest = maxAgeMs > 0 ? metrics.latestFor(d.id) : null;
    if (latest && latest.collectedAt > cutoff) continue;
    await collectFor(d.id, d.name);
  }
}

export function refreshStaleMetrics(maxAgeMs: number): Promise<void> {
  if (!inFlight) {
    inFlight = collectOlderThan(maxAgeMs).finally(() => {
      lastFinishedAt = Date.now();
      inFlight = null;
    });
  }
  return inFlight;
}

export function collectAllMetrics(): Promise<void> {
  return refreshStaleMetrics(0);
}

export function requestFreshMetrics(maxAgeMs = MIN_REFRESH_INTERVAL_MS): Promise<void> {
  const window = Math.max(maxAgeMs, MIN_REFRESH_INTERVAL_MS);
  if (!inFlight && Date.now() - lastFinishedAt < window) return Promise.resolve();
  return refreshStaleMetrics(window).catch(() => {});
}

export const metricsService = registerService(
  intervalService({
    name: "metrics",
    intervalMs: 60_000,
    runOnStart: true,
    async tick() {
      try {
        await collectAllMetrics();
      } finally {
        metrics.prune(Date.now() - RETENTION_MS);
      }
    },
  }),
);
