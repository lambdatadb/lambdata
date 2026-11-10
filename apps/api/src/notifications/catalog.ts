import type {
  NotificationCatalogResponse,
  NotificationEventInfo,
  NotificationEventType,
  NotificationGroup,
  NotificationGroupInfo,
} from "@lambdata/shared";

export const DEFAULT_ICON_URL = "https://raw.githubusercontent.com/lambdatadb/lambdata/main/apps/web/public/lambdata-mark.png";
export const SENDER_NAME = "LambData";

export const NOTIFICATION_GROUPS: NotificationGroupInfo[] = [
  { group: "databases", label: "Databases" },
  { group: "checkpoints", label: "Checkpoints" },
  { group: "mirrors", label: "Mirrors" },
  { group: "imports", label: "Imports" },
  { group: "access", label: "Access" },
  { group: "health", label: "Health" },
];

export const NOTIFICATION_EVENTS: NotificationEventInfo[] = [
  {
    type: "database.created",
    group: "databases",
    label: "Database created",
    description: "Someone created a database, from scratch or from an uploaded file.",
    severity: "success",
    defaultOn: true,
    perDatabase: true,
  },
  {
    type: "database.deleted",
    group: "databases",
    label: "Database deleted",
    description: "Someone deleted a database together with its data and checkpoints.",
    severity: "warning",
    defaultOn: true,
    perDatabase: true,
  },
  {
    type: "database.password_rotated",
    group: "databases",
    label: "Password rotated",
    description: "Someone generated a new password for a database; apps using the old one can no longer connect.",
    severity: "info",
    defaultOn: true,
    perDatabase: true,
  },
  {
    type: "checkpoint.created",
    group: "checkpoints",
    label: "Checkpoint made",
    description: "Someone made a checkpoint by hand, with its message and short hash.",
    severity: "success",
    defaultOn: true,
    perDatabase: true,
  },
  {
    type: "checkpoint.auto_created",
    group: "checkpoints",
    label: "Automatic checkpoint",
    description: "A scheduled, sync, import or safety checkpoint was made. Can be noisy on busy databases.",
    severity: "info",
    defaultOn: false,
    perDatabase: true,
  },
  {
    type: "checkpoint.failed",
    group: "checkpoints",
    label: "Checkpoint or rollback failed",
    description: "A checkpoint, automatic or made by hand, or a rollback could not finish.",
    severity: "error",
    defaultOn: true,
    perDatabase: true,
  },
  {
    type: "checkpoint.rolled_back",
    group: "checkpoints",
    label: "Rolled back",
    description: "A database was rolled back to one of its checkpoints.",
    severity: "success",
    defaultOn: true,
    perDatabase: true,
  },
  {
    type: "checkpoint.rollback_errors",
    group: "checkpoints",
    label: "Rolled back with errors",
    description: "A rollback brought the tables back, but some views, triggers or routines could not be re-created.",
    severity: "warning",
    defaultOn: true,
    perDatabase: true,
  },
  {
    type: "checkpoint.rollback_refused",
    group: "checkpoints",
    label: "Rollback refused",
    description: "A rollback was stopped before anything changed, for example because the checkpoint could not be loaded exactly.",
    severity: "warning",
    defaultOn: true,
    perDatabase: true,
  },
  {
    type: "checkpoint.deleted",
    group: "checkpoints",
    label: "Checkpoint deleted",
    description: "Someone deleted a checkpoint.",
    severity: "info",
    defaultOn: true,
    perDatabase: true,
  },
  {
    type: "sync.finished",
    group: "mirrors",
    label: "Sync finished",
    description: "A mirror copied its source again. A mirror that syncs every five minutes sends a message every five minutes.",
    severity: "success",
    defaultOn: false,
    perDatabase: true,
  },
  {
    type: "sync.failed",
    group: "mirrors",
    label: "Sync failed",
    description: "A mirror could not copy its source.",
    severity: "error",
    defaultOn: true,
    perDatabase: true,
  },
  {
    type: "sync.recovered",
    group: "mirrors",
    label: "Sync recovered",
    description: "A mirror synced successfully after one or more failures.",
    severity: "success",
    defaultOn: true,
    perDatabase: true,
  },
  {
    type: "import.finished",
    group: "imports",
    label: "Import finished",
    description: "A database was created from a file, or its data was replaced from one.",
    severity: "success",
    defaultOn: true,
    perDatabase: true,
  },
  {
    type: "import.failed",
    group: "imports",
    label: "Import failed",
    description: "An import from a file did not finish.",
    severity: "error",
    defaultOn: true,
    perDatabase: true,
  },
  {
    type: "user.created",
    group: "access",
    label: "User added",
    description: "An admin added a console user.",
    severity: "info",
    defaultOn: true,
    perDatabase: false,
  },
  {
    type: "user.removed",
    group: "access",
    label: "User removed",
    description: "An admin removed a console user.",
    severity: "warning",
    defaultOn: true,
    perDatabase: false,
  },
  {
    type: "data_api.opened",
    group: "access",
    label: "Data API opened",
    description: "Someone opened a database to the Data API, so apps can reach its tables.",
    severity: "warning",
    defaultOn: true,
    perDatabase: true,
  },
  {
    type: "data_api.closed",
    group: "access",
    label: "Data API closed",
    description: "Someone closed a database to the Data API.",
    severity: "info",
    defaultOn: true,
    perDatabase: true,
  },
  {
    type: "network.policy_changed",
    group: "access",
    label: "Access policy changed",
    description: "The rules for which networks can reach the console changed.",
    severity: "warning",
    defaultOn: true,
    perDatabase: false,
  },
  {
    type: "mariadb.down",
    group: "health",
    label: "MariaDB down",
    description: "The database server stopped unexpectedly or failed to start.",
    severity: "error",
    defaultOn: true,
    perDatabase: false,
  },
  {
    type: "mariadb.recovered",
    group: "health",
    label: "MariaDB back",
    description: "The database server is running again after being down.",
    severity: "success",
    defaultOn: true,
    perDatabase: false,
  },
  {
    type: "disk.low",
    group: "health",
    label: "Disk space low",
    description: "Free space on the data volume fell below the floor; uploads, checkpoints and syncs stop until space is freed.",
    severity: "error",
    defaultOn: true,
    perDatabase: false,
  },
  {
    type: "disk.recovered",
    group: "health",
    label: "Disk space recovered",
    description: "Free space on the data volume is back above the floor.",
    severity: "success",
    defaultOn: false,
    perDatabase: false,
  },
  {
    type: "snapshot.unconverted",
    group: "health",
    label: "Snapshot not converted",
    description: "An old snapshot could not be turned into a checkpoint. It is kept and retried.",
    severity: "warning",
    defaultOn: true,
    perDatabase: true,
  },
];

const BY_TYPE = new Map(NOTIFICATION_EVENTS.map((e) => [e.type, e]));

export const EVENT_TYPES = NOTIFICATION_EVENTS.map((e) => e.type) as [NotificationEventType, ...NotificationEventType[]];

export function eventInfo(type: NotificationEventType): NotificationEventInfo {
  return BY_TYPE.get(type)!;
}

export function groupOf(type: NotificationEventType): NotificationGroup {
  return eventInfo(type).group;
}

export function defaultEventTypes(): NotificationEventType[] {
  return NOTIFICATION_EVENTS.filter((e) => e.defaultOn).map((e) => e.type);
}

export function catalog(): NotificationCatalogResponse {
  return {
    groups: NOTIFICATION_GROUPS.map((g) => ({ ...g })),
    events: NOTIFICATION_EVENTS.map((e) => ({ ...e })),
    defaultIconUrl: DEFAULT_ICON_URL,
  };
}
