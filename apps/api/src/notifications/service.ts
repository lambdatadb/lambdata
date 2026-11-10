import { registerService, safeTick, type BackgroundService } from "../lifecycle";
import { notificationDestinations } from "../db/queries/notifications";
import { onMariaDbReady } from "../mariadb/controller";
import { setNotificationHooks } from "./bus";
import { anyEnabledDestination, refreshNameCaches } from "./emit";
import { checkDisk, checkMariaDb, handleAudit, handleJobFinished, handleSnapshotUnconverted } from "./handlers";
import { pruneAllDeliveries, startWorker, stopWorker, workerRunning } from "./worker";

export const MARIADB_POLL_MS = 2_000;
export const HOUSEKEEPING_MS = 60_000;

setNotificationHooks({
  audit: handleAudit,
  jobFinished: handleJobFinished,
  snapshotUnconverted: handleSnapshotUnconverted,
});

function hasDestinations(): boolean {
  try {
    return notificationDestinations.count() > 0;
  } catch {
    return false;
  }
}

export function runHousekeeping(): void {
  if (!hasDestinations()) return;
  pruneAllDeliveries();
  if (!anyEnabledDestination()) return;
  refreshNameCaches();
  checkDisk();
}

function unref(timer: ReturnType<typeof setInterval>): void {
  (timer as { unref?: () => void }).unref?.();
}

function notificationsBackground(): BackgroundService {
  let mariadbTimer: ReturnType<typeof setInterval> | null = null;
  let houseTimer: ReturnType<typeof setInterval> | null = null;
  let unsubscribe: (() => void) | null = null;
  let mariadbBusy = false;
  const mariadbTick = safeTick("notifications", () => checkMariaDb());
  const houseTick = safeTick("notifications", () => runHousekeeping());
  const pollMariaDb = (): void => {
    if (mariadbBusy) return;
    mariadbBusy = true;
    mariadbTick().finally(() => {
      mariadbBusy = false;
    });
  };
  return {
    name: "notifications",
    start() {
      if (mariadbTimer) return;
      startWorker();
      unsubscribe = onMariaDbReady((reason) => {
        void checkMariaDb(reason).catch(() => {});
      });
      mariadbTimer = setInterval(pollMariaDb, MARIADB_POLL_MS);
      houseTimer = setInterval(() => void houseTick(), HOUSEKEEPING_MS);
      unref(mariadbTimer);
      unref(houseTimer);
      void houseTick();
      pollMariaDb();
    },
    async stop() {
      if (mariadbTimer) clearInterval(mariadbTimer);
      if (houseTimer) clearInterval(houseTimer);
      mariadbTimer = null;
      houseTimer = null;
      unsubscribe?.();
      unsubscribe = null;
      await stopWorker();
    },
    running() {
      return mariadbTimer !== null && workerRunning();
    },
  };
}

export const notificationsService = registerService(notificationsBackground());
