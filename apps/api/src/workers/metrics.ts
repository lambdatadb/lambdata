import { databases, metrics } from "../db/queries";
import { getDatabaseMetrics } from "../mariadb/manager";

let timer: ReturnType<typeof setInterval> | null = null;

export async function collectMetricsFor(databaseId: string): Promise<void> {
  const d = databases.byId(databaseId);
  if (!d) return;
  try {
    const m = await getDatabaseMetrics(d.name);
    metrics.insert(d.id, m);
  } catch (err) {
    console.error("[metrics] failed for", d.name, err);
  }
}

async function collectOnce(): Promise<void> {
  for (const d of databases.list()) {
    try {
      const m = await getDatabaseMetrics(d.name);
      metrics.insert(d.id, m);
    } catch (err) {
      console.error("[metrics] failed for", d.name, err);
    }
  }
}

let lastKick = 0;

export function requestFreshMetrics(maxAgeMs = 15_000): void {
  const now = Date.now();
  if (now - lastKick < maxAgeMs) return;
  lastKick = now;
  collectOnce().catch(() => {});
}

export function startMetricsLoop(intervalMs = 60_000): void {
  if (timer) return;
  // first pass immediately, but unhandled errors swallowed
  collectOnce().catch(() => {});
  timer = setInterval(() => {
    collectOnce()
      .catch(() => {})
      .finally(() => {
        // keep ~30 days of samples
        metrics.prune(Date.now() - 30 * 24 * 60 * 60 * 1000);
      });
  }, intervalMs);
}

export function stopMetricsLoop(): void {
  if (timer) clearInterval(timer);
  timer = null;
}

export function metricsLoopRunning(): boolean {
  return timer !== null;
}
