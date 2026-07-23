import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { AppSettings, DataDirMigrationResponse } from "@kilndb/shared";
import { settings as store, audit } from "../db/queries";
import { requireAuth, requireRole, type AuthVariables } from "../auth/middleware";
import { env } from "../env";
import { dataDirFreeBytes } from "../util/disk";
import { migrateDataDir } from "../util/dataDirMigration";
import { POINTER_PATH } from "../util/pointer";

export const settingsRoute = new Hono<{ Variables: AuthVariables }>();

settingsRoute.use("*", requireAuth);

settingsRoute.get("/", async (c) => {
  const freeBytes = await dataDirFreeBytes();
  const res: AppSettings = {
    setupComplete: store.get("setup_complete") === "1",
    tailscaleEnabled: store.get("tailscale_enabled") === "1",
    dashboardShowAddresses: store.get("dashboard_show_addresses") !== "0",
    mariadbPort: env.mariadbPort,
    dataDir: env.dataDir,
    pointerPath: POINTER_PATH,
    dataDirFreeBytes: freeBytes,
  };
  return c.json(res);
});

settingsRoute.patch("/", requireRole("admin"), async (c) => {
  const body = (await c.req.json()) as Record<string, string | number | boolean>;
  for (const [k, v] of Object.entries(body)) {
    store.set(k, String(v));
  }
  audit.log(c.get("user").id, "settings.update", null, body);
  return c.json({ ok: true });
});

settingsRoute.post("/data-dir", requireRole("admin"), async (c) => {
  const body = (await c.req.json()) as { path?: string };
  if (!body.path) throw new HTTPException(400, { message: "path required" });

  const userId = c.get("user").id;
  audit.log(userId, "data_dir.migrate.start", null, { from: env.dataDir, to: body.path });

  try {
    const result = await migrateDataDir({ newPath: body.path });
    audit.log(userId, "data_dir.migrate.complete", null, result);
    const res: DataDirMigrationResponse = {
      ok: true,
      oldPath: result.oldPath,
      newPath: result.newPath,
      bytesCopied: result.bytesCopied,
      durationMs: result.durationMs,
    };
    return c.json(res);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    audit.log(userId, "data_dir.migrate.failed", null, { error: message });
    throw new HTTPException(500, { message });
  }
});
