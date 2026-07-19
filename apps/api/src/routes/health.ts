import { Hono } from "hono";
import type { HealthDetail } from "@kilndb/shared";
import { requireAuth, type AuthVariables } from "../auth/middleware";
import { healthCheck } from "../mariadb/controller";
import { metricsLoopRunning } from "../workers/metrics";
import { syncSchedulerRunning } from "../workers/sync";
import { snapshotSchedulerRunning } from "../workers/snapshots";

export const healthRoute = new Hono<{ Variables: AuthVariables }>();

healthRoute.get("/", (c) => c.json({ ok: true }));

healthRoute.get("/detail", requireAuth, async (c) => {
  const mariadb = await healthCheck();
  const res: HealthDetail = {
    ok: mariadb.ok,
    mariadb,
    workers: {
      metrics: metricsLoopRunning(),
      sync: syncSchedulerRunning(),
      snapshots: snapshotSchedulerRunning(),
    },
    uptimeSec: Math.floor(process.uptime()),
  };
  return c.json(res);
});
