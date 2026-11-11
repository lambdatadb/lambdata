import type {
  NotificationCatalogResponse,
  NotificationDelivery,
  NotificationDestination,
  NotificationEventInfo,
  NotificationEventType,
  NotificationTestResponse,
} from "@lambdata/shared";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

export const DEFAULT_ICON_URL = "https://raw.githubusercontent.com/lambdatadb/lambdata/main/apps/web/public/lambdata-mark.png";

function event(
  type: NotificationEventType,
  group: NotificationEventInfo["group"],
  label: string,
  description: string,
  severity: NotificationEventInfo["severity"],
  defaultOn: boolean,
  perDatabase: boolean,
): NotificationEventInfo {
  return { type, group, label, description, severity, defaultOn, perDatabase };
}

export const fixtureCatalog: NotificationCatalogResponse = {
  defaultIconUrl: DEFAULT_ICON_URL,
  groups: [
    { group: "databases", label: "Databases" },
    { group: "checkpoints", label: "Checkpoints" },
    { group: "mirrors", label: "Mirrors" },
    { group: "imports", label: "Imports" },
    { group: "access", label: "People and access" },
    { group: "agents", label: "Access tokens" },
    { group: "health", label: "Server health" },
  ],
  events: [
    event("database.created", "databases", "Database created", "Someone created a database, empty or from a file.", "success", true, true),
    event("database.deleted", "databases", "Database deleted", "A database and all its data were removed.", "warning", true, true),
    event("database.password_rotated", "databases", "Password rotated", "A database's MariaDB password was changed.", "info", true, true),
    event("checkpoint.created", "checkpoints", "Checkpoint made", "Someone made a checkpoint, with its message and short hash.", "success", true, true),
    event("checkpoint.auto_created", "checkpoints", "Automatic checkpoint", "Scheduled, sync, safety and import checkpoints.", "info", false, true),
    event("checkpoint.failed", "checkpoints", "Checkpoint failed", "A checkpoint could not be taken.", "error", true, true),
    event("checkpoint.rolled_back", "checkpoints", "Rolled back", "A database was rolled back to a checkpoint.", "warning", true, true),
    event("checkpoint.rollback_errors", "checkpoints", "Rolled back with errors", "The tables are back, but some views, triggers or routines are missing.", "warning", true, true),
    event("checkpoint.rollback_refused", "checkpoints", "Rollback refused", "A rollback stopped before anything changed.", "warning", true, true),
    event("checkpoint.deleted", "checkpoints", "Checkpoint deleted", "Someone deleted a checkpoint.", "info", true, true),
    event("sync.finished", "mirrors", "Sync finished", "A mirror finished a sync, with or without errors.", "success", false, true),
    event("sync.failed", "mirrors", "Sync failed", "A mirror could not sync from its source.", "error", true, true),
    event("sync.recovered", "mirrors", "Sync recovered", "A mirror synced again after failing.", "success", true, true),
    event("import.finished", "imports", "Import finished", "A database was created or replaced from a file.", "success", true, true),
    event("import.failed", "imports", "Import failed", "Loading a file stopped; nothing was changed.", "error", true, true),
    event("user.created", "access", "Console user added", "Someone was given a sign-in to this console.", "info", true, false),
    event("user.removed", "access", "Console user removed", "A console sign-in was removed.", "info", true, false),
    event("data_api.opened", "access", "Data API opened", "A database was opened to the Data API.", "warning", true, true),
    event("data_api.closed", "access", "Data API closed", "A database was closed to the Data API.", "info", true, true),
    event("network.policy_changed", "access", "Network policy changed", "The rules for who may reach the console changed.", "warning", true, false),
    event("token.created", "agents", "Access token created", "An admin created an access token, so an agent or script can use the management API.", "info", false, false),
    event("token.revoked", "agents", "Access token revoked", "An admin revoked an access token. Anything still using it is refused from then on.", "warning", false, false),
    event(
      "approval.requested",
      "agents",
      "Approval needed",
      "An access token set to ask first wants to do something and waits until an admin approves or declines it.",
      "warning",
      true,
      false,
    ),
    event("mariadb.down", "health", "MariaDB stopped", "The database server stopped unexpectedly or could not start.", "error", true, false),
    event("mariadb.recovered", "health", "MariaDB running again", "The database server is back after stopping.", "success", true, false),
    event("disk.low", "health", "Disk space low", "Free space fell below the floor; checkpoints, imports and uploads pause.", "warning", true, false),
    event("disk.recovered", "health", "Disk space recovered", "Free space is back above the floor.", "success", false, false),
    event("snapshot.unconverted", "health", "Old snapshot not converted", "A snapshot from an older version could not become a checkpoint.", "warning", true, true),
  ],
};

export const fixtureDefaultEvents: NotificationEventType[] = fixtureCatalog.events.filter((e) => e.defaultOn).map((e) => e.type);

export const FIXTURE_DATABASES = [
  { id: "db_fixture_storefront", name: "storefront", displayName: "Storefront" },
  { id: "db_fixture_ledger", name: "ledger", displayName: "Ledger" },
  { id: "db_fixture_game_mirror", name: "game_mirror", displayName: "Game Mirror" },
];

function destination(partial: Partial<NotificationDestination> & Pick<NotificationDestination, "id" | "name" | "kind" | "target">, now: number): NotificationDestination {
  return {
    enabled: true,
    hasSecret: false,
    headerNames: [],
    ntfyPriority: null,
    events: fixtureDefaultEvents,
    databaseIds: null,
    iconUrl: null,
    health: "ok",
    lastSuccessAt: now - 4 * MINUTE,
    lastFailureAt: null,
    lastError: null,
    consecutiveFailures: 0,
    createdByUserId: "user_avery",
    createdAt: now - 9 * 24 * HOUR,
    updatedAt: now - 2 * 24 * HOUR,
    ...partial,
  };
}

export function fixtureDestinations(now = Date.now(), databaseIds: string[] = FIXTURE_DATABASES.map((d) => d.id)): NotificationDestination[] {
  return [
    destination({ id: "nd_ops", name: "Ops channel", kind: "discord", target: "discord.com/…k3Qz" }, now),
    destination(
      {
        id: "nd_home",
        name: "Home automation",
        kind: "webhook",
        target: "https://automation.example.com",
        hasSecret: true,
        headerNames: ["X-Team"],
        events: ["sync.failed", "sync.recovered", "mariadb.down", "mariadb.recovered", "disk.low", "checkpoint.failed"],
        databaseIds: databaseIds.slice(0, 2),
        health: "failing",
        lastSuccessAt: now - 26 * HOUR,
        lastFailureAt: now - 12 * MINUTE,
        lastError: "HTTP 404 Not Found",
        consecutiveFailures: 4,
      },
      now,
    ),
    destination(
      {
        id: "nd_phone",
        name: "My phone",
        kind: "ntfy",
        target: "ntfy.sh/la…",
        ntfyPriority: 4,
        events: ["mariadb.down", "disk.low", "sync.failed", "sync.finished", "checkpoint.failed", "import.failed"],
        skipUnchanged: true,
        health: "new",
        lastSuccessAt: null,
      },
      now,
    ),
    destination(
      {
        id: "nd_team",
        name: "Team chat",
        kind: "slack",
        target: "hooks.slack.com/…7a1e",
        enabled: false,
        lastSuccessAt: now - 3 * 24 * HOUR,
      },
      now,
    ),
  ];
}

function delivery(partial: Partial<NotificationDelivery> & Pick<NotificationDelivery, "id" | "eventType" | "title" | "status">, now: number): NotificationDelivery {
  return {
    destinationId: "nd_home",
    attempts: 1,
    responseStatus: partial.status === "sent" ? 204 : null,
    lastError: null,
    createdAt: now - 5 * MINUTE,
    sentAt: partial.status === "sent" ? now - 5 * MINUTE : null,
    nextAttemptAt: null,
    ...partial,
  };
}

export function fixtureDeliveries(now = Date.now(), destinationId = "nd_home"): NotificationDelivery[] {
  return [
    delivery(
      {
        id: "dl_5",
        destinationId,
        eventType: "sync.failed",
        title: "Sync failed: Game Mirror",
        status: "queued",
        attempts: 2,
        responseStatus: 503,
        lastError: "HTTP 503 Service Unavailable",
        createdAt: now - 70_000,
        nextAttemptAt: now + 45_000,
      },
      now,
    ),
    delivery(
      {
        id: "dl_4",
        destinationId,
        eventType: "test",
        title: "Test message from LambData",
        status: "failed",
        attempts: 1,
        responseStatus: 404,
        lastError: "HTTP 404 Not Found",
        createdAt: now - 12 * MINUTE,
      },
      now,
    ),
    delivery(
      {
        id: "dl_3",
        destinationId,
        eventType: "disk.low",
        title: "Disk space low on the data directory",
        status: "failed",
        attempts: 6,
        responseStatus: 404,
        lastError: "HTTP 404 Not Found",
        createdAt: now - 3 * HOUR,
      },
      now,
    ),
    delivery({ id: "dl_2", destinationId, eventType: "sync.recovered", title: "Sync recovered: Game Mirror", status: "sent", createdAt: now - 26 * HOUR, sentAt: now - 26 * HOUR }, now),
    delivery(
      {
        id: "dl_1",
        destinationId,
        eventType: "checkpoint.failed",
        title: "Checkpoint failed: Ledger",
        status: "dropped",
        lastError: "Folded into a summary: more than 20 messages in a minute",
        createdAt: now - 27 * HOUR,
      },
      now,
    ),
  ];
}

export const fixtureTestOk: NotificationTestResponse = { ok: true, responseStatus: 204, error: null, durationMs: 312 };

export const fixtureTestNotFound: NotificationTestResponse = { ok: false, responseStatus: 404, error: "HTTP 404 Not Found", durationMs: 188 };

export const fixtureTestTimeout: NotificationTestResponse = { ok: false, responseStatus: null, error: "No answer within 10 seconds", durationMs: 10_000 };
