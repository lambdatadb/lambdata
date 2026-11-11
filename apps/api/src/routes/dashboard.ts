import { Hono } from "hono";
import type {
  DashboardSummary,
  DashboardSummaryDbMetrics,
  DashboardVitals,
  DashboardVitalsSeries,
} from "@lambdata/shared";
import { checkpoints, databases, functionInvocations, metrics, settings, storageBuckets, syncJobs } from "../db/queries";
import { requireAuth, type AuthVariables } from "../auth/middleware";
import { bucketMsFor, rangeMsFor } from "./metrics";
import { realtimeStatus } from "../realtime/hub";
import { listFunctionDefinitions } from "../functions/service";
import { boundedHealthCheck } from "../util/mariadbHealth";
import { requestFreshMetrics } from "../workers/metrics";
import { dataDirFreeBytes } from "../util/disk";
import { env } from "../env";
import { isLoopbackBind } from "../connections/bind";

export const dashboardRoute = new Hono<{ Variables: AuthVariables }>();

dashboardRoute.use("*", requireAuth);

dashboardRoute.get("/vitals", (c) => {
  requestFreshMetrics();
  const user = c.get("user");
  const rangeMs = rangeMsFor(c.req.query("range"), "30d");
  const since = Date.now() - rangeMs;
  const bucketMs = bucketMsFor(rangeMs, c.req.query("maxPoints"));
  const dbs = (user.role === "db_owner" ? databases.listForUser(user.id) : databases.list())
    .filter((database) => database.showInVitals);
  const series: DashboardVitalsSeries[] = dbs.map((d) => {
    const samples = metrics.range(d.id, since, bucketMs);
    const baseline = metrics.latestBefore(d.id, since);
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
    checkpoints: {
      ...checkpoints.stats(dayAgo, user.role === "db_owner" ? [...dbIds] : undefined),
      versionedDatabases: dbs.filter((d) => d.versioned).length,
    },
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
      mariadbOk: (await boundedHealthCheck()).ok,
      host: env.mariadbBind,
      port: env.mariadbPort,
      dashboardShowAddresses: settings.getBool("dashboard_show_addresses", true),
      outsideConnections: !isLoopbackBind(env.mariadbBind),
      inContainer: env.inContainer,
    },
  };
  return c.json(res);
});
