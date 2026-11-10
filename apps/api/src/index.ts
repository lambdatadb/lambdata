import "./workers/metrics";
import "./workers/sync";
import "./checkpoints/scheduler";
import "./imports/service";
import "./network/service";
import "./notifications/service";
import "./databases/startup";
import "./checkpoints/startup";
import { migrate } from "./db/migrate";
import { buildApp } from "./server";
import { env } from "./env";
import { startMariaDb, stopMariaDb } from "./mariadb/controller";
import { settleMariaDbWork } from "./mariadb/shutdown";
import { readPointer } from "./util/pointer";
import { settings } from "./db/queries";
import { realtimeSocketDataFromRequest, realtimeWebSocketHandlers } from "./realtime/hub";
import { guardUpgradeRequest } from "./network/guard";
import { recoverInterruptedJobs } from "./jobs";
import { runStartupTasksOnce, startServices, stopServices } from "./lifecycle";
import { settleAppAuthUpgrade } from "./auth/appJwt";
import { warmPasswordCheck } from "./auth/password";
import { announceSetupToken } from "./auth/setupToken";

const IDLE_TIMEOUT_SECONDS = 120;
const MAX_REQUEST_BODY_BYTES = 64 * 1024 * 1024 * 1024;

async function main(): Promise<void> {
  migrate();
  console.log("[lambdata] sqlite migrated:", env.sqlitePath);
  settleAppAuthUpgrade();
  recoverInterruptedJobs();
  void warmPasswordCheck();

  let mariadbUp = false;
  const storageConfigured = readPointer() !== null || settings.get("setup_complete") === "1";
  if (storageConfigured) {
    try {
      await startMariaDb();
      mariadbUp = true;
    } catch (err) {
      console.error("[lambdata] failed to start MariaDB:", err instanceof Error ? err.message : String(err));
      console.error("[lambdata] API will start anyway; install MariaDB and restart to enable database management.");
    }
  } else {
    console.log("[lambdata] storage not configured — MariaDB will start after the setup wizard's storage step");
  }

  await startServices();

  const app = buildApp();
  const server = Bun.serve({
    port: env.port,
    hostname: env.host,
    async fetch(req, server) {
      const url = new URL(req.url);
      if (url.pathname === "/api/realtime/v1/websocket") {
        const blocked = await guardUpgradeRequest(req, server);
        if (blocked) return blocked;
        const data = await realtimeSocketDataFromRequest(req);
        if (!data) {
          return Response.json({ error: "valid App Auth token required" }, { status: 401 });
        }
        if (server.upgrade(req, { data })) return undefined;
        return Response.json({ error: "websocket upgrade failed" }, { status: 400 });
      }
      return app.fetch(req, { server });
    },
    websocket: realtimeWebSocketHandlers,
    idleTimeout: IDLE_TIMEOUT_SECONDS,
    maxRequestBodySize: MAX_REQUEST_BODY_BYTES,
  });
  console.log(`[lambdata] api listening on http://${server.hostname}:${server.port}`);
  if (settings.get("setup_complete") !== "1") announceSetupToken();

  if (mariadbUp) void runStartupTasksOnce();

  let shuttingDown = false;
  const shutdown = async (): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log("[lambdata] shutting down");
    await settleMariaDbWork();
    await stopServices();
    server.stop();
    await stopMariaDb().catch(() => {});
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error("[lambdata] fatal:", err);
  process.exit(1);
});
