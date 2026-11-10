import { Hono } from "hono";
import type { CheckpointHealthDetail, HealthDetail } from "@lambdata/shared";
import { requireAuth, type AuthVariables } from "../auth/middleware";
import { mariadbExpected, mariadbState } from "../mariadb/controller";
import { boundedHealthCheck } from "../util/mariadbHealth";
import { serviceRunning } from "../lifecycle";
import { isDataDirMigrating } from "../util/dataDirMigration";
import { legacyConversionHealth } from "../checkpoints/startup";

export const healthRoute = new Hono<{ Variables: AuthVariables }>();

healthRoute.get("/", async (c) => {
  if (isDataDirMigrating()) return c.json({ ok: true, mariadb: "moving" });
  if (!mariadbExpected()) return c.json({ ok: true, mariadb: mariadbState() === "running" ? "running" : "not-started" });
  const mariadb = await boundedHealthCheck();
  if (!mariadb.ok) return c.json({ ok: false, mariadb: mariadb.timedOut ? "not-responding" : mariadb.state }, 503);
  return c.json({ ok: true, mariadb: mariadb.state });
});

healthRoute.get("/detail", requireAuth, async (c) => {
  const { timedOut: _timedOut, ...mariadb } = await boundedHealthCheck();
  const res: HealthDetail & { checkpoints: CheckpointHealthDetail } = {
    ok: mariadb.ok,
    mariadb,
    workers: {
      metrics: serviceRunning("metrics"),
      sync: serviceRunning("sync"),
      checkpoints: serviceRunning("checkpoints"),
    },
    uptimeSec: Math.floor(process.uptime()),
    checkpoints: legacyConversionHealth(),
  };
  return c.json(res);
});
