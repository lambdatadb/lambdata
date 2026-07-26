import { Hono } from "hono";
import type {
  DashboardSummary,
  DashboardSummaryDbMetrics,
  DashboardVitals,
  DashboardVitalsSeries,
} from "@kilndb/shared";
import { databases, functionInvocations, metrics, settings, snapshots, storageBuckets, syncJobs } from "../db/queries";
import { requireAuth, type AuthVariables } from "../auth/middleware";
import { bucketMsFor } from "./metrics";
import { realtimeStatus } from "../realtime/hub";
import { listFunctionDefinitions } from "../functions/service";
import { healthCheck } from "../mariadb/controller";
import { requestFreshMetrics } from "../workers/metrics";
import { dataDirFreeBytes } from "../util/disk";
import { env } from "../env";

const RANGE_MS: Record<string, number> = {
  "1d": 24 * 60 * 60 * 1000,
  "5d": 5 * 24 * 60 * 60 * 1000,
  "15d": 15 * 24 * 60 * 60 * 1000,
  "24h": 24 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
  "30d": 30 * 24 * 60 * 60 * 1000,
};

export const dashboardRoute = new Hono<{ Variables: AuthVariables }>();

dashboardRoute.use("*", requireAuth);

dashboardRoute.get("/vitals", (c) => {
  requestFreshMetrics();
  const user = c.get("user");
  const range = c.req.query("range") ?? "30d";
  const rangeMs = RANGE_MS[range] ?? RANGE_MS["30d"]!;
  const since = Date.now() - rangeMs;
  const bucketMs = bucketMsFor(rangeMs, c.req.query("maxPoints"));
  const dbs = (user.role === "db_owner" ? databases.listForUser(user.id) : databases.list())
    .filter((database) => database.name !== "scpticket_mirror");
  const series: DashboardVitalsSeries[] = dbs.map((d) => {
    const samples = metrics.range(d.id, since, bucketMs);
    const baseline = metrics.latestBefore(d.id, since) ?? samples[0];
    if (baseline && (samples[0]?.collectedAt ?? Infinity) > since) {
      samples.unshift({ ...baseline, collectedAt: since });
    }
    return {
      databaseId: d.id,
      name: d.name,
      displayName: d.displayName,
      kind: d.kind,
      samples,
    };
  });
  const res: DashboardVitals = {
    rangeMs,
    collectedAt: Date.now(),
    series,
  };
  return c.json(res);
});

dashboardRoute.get("/summary", async (c) => {
  requestFreshMetrics();
  const user = c.get("user");
  const dbs = user.role === "db_owner" ? databases.listForUser(user.id) : databases.list();
  const dbIds = new Set(dbs.map((d) => d.id));

  const latestMetrics: DashboardSummaryDbMetrics[] = dbs.map((d) => {
    const m = metrics.latestFor(d.id);
    return {
      databaseId: d.id,
      name: d.name,
      displayName: d.displayName,
      kind: d.kind,
      sizeBytes: m?.sizeBytes ?? null,
      tableCount: m?.tableCount ?? null,
      connectionCount: m?.connectionCount ?? null,
      rowCount: m?.rowCount ?? null,
      collectedAt: m?.collectedAt ?? null,
    };
  });

  const buckets = user.role === "db_owner" ? storageBuckets.listForUser(user.id) : storageBuckets.list();
  const jobs = syncJobs.listAll().filter((j) => dbIds.has(j.databaseId));
  const failingJobs = jobs
    .filter((j) => j.lastStatus === "error")
    .sort((a, b) => (b.lastRunAt ?? 0) - (a.lastRunAt ?? 0));
  const rt = realtimeStatus();
  const fns = await listFunctionDefinitions();
  const dayAgo = Date.now() - 24 * 60 * 60 * 1000;

  const res: DashboardSummary = {
    databases: {
      total: dbs.length,
      active: dbs.filter((d) => d.status === "active").length,
      mirrors: dbs.filter((d) => d.kind === "mirror").length,
    },
    latestMetrics,
    storage: {
      buckets: buckets.length,
      objects: buckets.reduce((n, b) => n + b.objectCount, 0),
      totalSizeBytes: buckets.reduce((n, b) => n + b.totalSizeBytes, 0),
    },
    snapshots: snapshots.stats(dayAgo, user.role === "db_owner" ? [...dbIds] : undefined),
    sync: {
      mirrors: dbs.filter((d) => d.kind === "mirror").length,
      ok: jobs.filter((j) => j.lastStatus === "ok").length,
      failing: failingJobs.length,
      lastError: failingJobs[0]?.lastError ?? null,
    },
    realtime: {
      connections: rt.connections,
      channels: rt.channels.length,
      messagesSent: rt.messagesSent,
    },
    functions: {
      total: fns.length,
      invocations24h: functionInvocations.countSince(dayAgo),
    },
    system: {
      dataDirFreeBytes: await dataDirFreeBytes(),
      mariadbOk: (await healthCheck()).ok,
      host: env.mariadbBind,
      port: env.mariadbPort,
      dashboardShowAddresses: settings.get("dashboard_show_addresses") !== "0",
    },
  };
  return c.json(res);
});
