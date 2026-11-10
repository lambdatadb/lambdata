import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import type { AppSettings, DataDirMigrationResponse } from "@lambdata/shared";
import { settings as store, audit } from "../db/queries";
import { requireAuth, requireRole, type AuthVariables } from "../auth/middleware";
import { env } from "../env";
import {
  MAX_INTERVAL_FLOOR_HOURS,
  MAX_RETENTION_CEILING,
  checkpointCeilings,
  dataDirFreeBytes,
  diskStatus,
  setCheckpointCeilings,
} from "../util/disk";
import { DataDirMigrationError, migrateDataDir } from "../util/dataDirMigration";
import { pointerPathInUse } from "../util/pointer";
import { maxImportBytes, pendingUploadLimits } from "../imports/uploads";
import { parseJson } from "../util/validate";
import { disableRequestTimeout } from "../jobs";

export const settingsRoute = new Hono<{ Variables: AuthVariables }>();

settingsRoute.use("*", requireAuth);

const settingsPatchSchema = z
  .object({
    dashboard_show_addresses: z.boolean().optional(),
    dashboardShowAddresses: z.boolean().optional(),
    checkpointMaxAutoRetention: z.number().int().min(1).max(MAX_RETENTION_CEILING).nullable().optional(),
    checkpointMinIntervalHours: z.number().int().min(1).max(MAX_INTERVAL_FLOOR_HOURS).nullable().optional(),
  })
  .strict();

export interface SettingsLimits {
  diskFloorBytes: number;
  diskWarnBytes: number;
  diskLow: boolean;
  importMaxBytes: number;
  importMaxPendingUploads: number;
  importMaxPendingBytes: number;
  checkpointMaxAutoRetention: number;
  checkpointMinIntervalHours: number;
}

export function settingsLimits(): SettingsLimits {
  const disk = diskStatus();
  const pending = pendingUploadLimits();
  const ceilings = checkpointCeilings();
  return {
    diskFloorBytes: disk.floorBytes,
    diskWarnBytes: disk.warnBytes,
    diskLow: disk.low,
    importMaxBytes: maxImportBytes(),
    importMaxPendingUploads: pending.maxCount,
    importMaxPendingBytes: pending.maxBytes,
    checkpointMaxAutoRetention: ceilings.maxAutoRetention,
    checkpointMinIntervalHours: ceilings.minIntervalHours,
  };
}

settingsRoute.get("/", async (c) => {
  const freeBytes = await dataDirFreeBytes();
  const res: AppSettings = {
    setupComplete: store.get("setup_complete") === "1",
    tailscaleEnabled: store.get("tailscale_enabled") === "1",
    dashboardShowAddresses: store.getBool("dashboard_show_addresses", true),
    mariadbPort: env.mariadbPort,
    dataDir: env.dataDir,
    pointerPath: pointerPathInUse(),
    dataDirFreeBytes: freeBytes,
  };
  return c.json({ ...res, limits: settingsLimits() });
});

settingsRoute.patch("/", requireRole("admin"), async (c) => {
  const body = await parseJson(c, settingsPatchSchema);
  const changes: Record<string, boolean | number | null> = {};
  const showAddresses = body.dashboard_show_addresses ?? body.dashboardShowAddresses;
  if (showAddresses !== undefined) changes.dashboard_show_addresses = showAddresses;
  if (body.checkpointMaxAutoRetention !== undefined) changes.checkpointMaxAutoRetention = body.checkpointMaxAutoRetention;
  if (body.checkpointMinIntervalHours !== undefined) changes.checkpointMinIntervalHours = body.checkpointMinIntervalHours;
  if (Object.keys(changes).length === 0) {
    throw new HTTPException(400, { message: "no editable settings in request" });
  }
  if (showAddresses !== undefined) store.set("dashboard_show_addresses", showAddresses ? "1" : "0");
  setCheckpointCeilings({
    maxAutoRetention: body.checkpointMaxAutoRetention,
    minIntervalHours: body.checkpointMinIntervalHours,
  });
  audit.log(c.get("user").id, "settings.update", null, changes);
  return c.json({ ok: true, limits: settingsLimits() });
});

const dataDirSchema = z.object({ path: z.string().trim().min(1, "path required") });

settingsRoute.post("/data-dir", requireRole("admin"), async (c) => {
  const { path } = await parseJson(c, dataDirSchema);
  disableRequestTimeout(c);

  const userId = c.get("user").id;
  audit.log(userId, "data_dir.migrate.start", null, { from: env.dataDir, to: path });

  try {
    const result = await migrateDataDir({ newPath: path });
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
    const status = err instanceof DataDirMigrationError ? err.status : 500;
    throw new HTTPException(status, { message });
  }
});
