import { migrate } from "./db/migrate";
import { buildApp } from "./server";
import { env } from "./env";
import { startMariaDb, stopMariaDb } from "./mariadb/controller";
import { startSyncScheduler, stopSyncScheduler } from "./workers/sync";
import { startSnapshotScheduler, stopSnapshotScheduler } from "./workers/snapshots";
import { startMetricsLoop, stopMetricsLoop } from "./workers/metrics";
import { readPointer } from "./util/pointer";
import { settings } from "./db/queries";
import { realtimeSocketDataFromRequest, realtimeWebSocketHandlers } from "./realtime/hub";

async function main(): Promise<void> {
  migrate();
  console.log("[kilndb] sqlite migrated:", env.sqlitePath);

  // Defer MariaDB start on a truly-first run: if no pointer config has been
  // written AND setup hasn't been completed, the user hasn't picked a storage
  // location yet. The setup wizard's storage step will write the pointer, copy
  // any bootstrap state, and start MariaDB at the chosen location.
  const storageConfigured = readPointer() !== null || settings.get("setup_complete") === "1";
  if (storageConfigured) {
    try {
      await startMariaDb();
    } catch (err) {
      console.error("[kilndb] failed to start MariaDB:", err);
      console.error("[kilndb] API will start anyway; install MariaDB and restart to enable database management.");
    }
  } else {
    console.log("[kilndb] storage not configured — MariaDB will start after the setup wizard's storage step");
  }

  startMetricsLoop();
  startSyncScheduler();
  startSnapshotScheduler();

  const app = buildApp();
  const server = Bun.serve({
    port: env.port,
    hostname: env.host,
    async fetch(req, server) {
      const url = new URL(req.url);
      if (url.pathname === "/api/realtime/v1/websocket") {
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
    idleTimeout: 60,
  });
  console.log(`[kilndb] api listening on http://${server.hostname}:${server.port}`);

  const shutdown = async (): Promise<void> => {
    console.log("[kilndb] shutting down");
    stopMetricsLoop();
    stopSyncScheduler();
    stopSnapshotScheduler();
    server.stop();
    await stopMariaDb().catch(() => {});
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error("[kilndb] fatal:", err);
  process.exit(1);
});
