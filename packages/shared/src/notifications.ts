import type { TableRowChange } from "./checkpoints";

export type NotificationKind = "discord" | "slack" | "webhook" | "ntfy";

export type NotificationGroup = "databases" | "checkpoints" | "mirrors" | "imports" | "access" | "agents" | "health";

export type NotificationSeverity = "info" | "success" | "warning" | "error";

export type NotificationEventType =
  | "database.created"
  | "database.deleted"
  | "database.password_rotated"
  | "checkpoint.created"
  | "checkpoint.auto_created"
  | "checkpoint.failed"
  | "checkpoint.rolled_back"
  | "checkpoint.rollback_errors"
  | "checkpoint.rollback_refused"
  | "checkpoint.deleted"
  | "sync.finished"
  | "sync.failed"
  | "sync.recovered"
  | "import.finished"
  | "import.failed"
  | "user.created"
  | "user.removed"
  | "data_api.opened"
  | "data_api.closed"
  | "network.policy_changed"
  | "token.created"
  | "token.revoked"
  | "approval.requested"
  | "mariadb.down"
  | "mariadb.recovered"
  | "disk.low"
  | "disk.recovered"
  | "snapshot.unconverted";

export interface NotificationEventInfo {
  type: NotificationEventType;
  group: NotificationGroup;
  label: string;
  description: string;
  severity: NotificationSeverity;
  defaultOn: boolean;
  perDatabase: boolean;
}

export interface NotificationGroupInfo {
  group: NotificationGroup;
  label: string;
}

export interface NotificationCatalogResponse {
  groups: NotificationGroupInfo[];
  events: NotificationEventInfo[];
  defaultIconUrl: string;
}

export interface DiscordDestinationConfig {
  url: string;
}

export interface SlackDestinationConfig {
  url: string;
}

export interface WebhookDestinationConfig {
  url: string;
  secret?: string | null;
  headers?: Record<string, string>;
}

export interface NtfyDestinationConfig {
  server?: string;
  topic: string;
  token?: string | null;
  priority?: 1 | 2 | 3 | 4 | 5;
}

export type NotificationDestinationConfig =
  | { kind: "discord"; config: DiscordDestinationConfig }
  | { kind: "slack"; config: SlackDestinationConfig }
  | { kind: "webhook"; config: WebhookDestinationConfig }
  | { kind: "ntfy"; config: NtfyDestinationConfig };

export type NotificationDestinationHealth = "new" | "ok" | "failing";

export interface NotificationDestination {
  id: string;
  name: string;
  kind: NotificationKind;
  enabled: boolean;
  target: string;
  hasSecret: boolean;
  headerNames: string[];
  ntfyPriority: number | null;
  events: NotificationEventType[];
  databaseIds: string[] | null;
  iconUrl: string | null;
  skipUnchanged?: boolean;
  health: NotificationDestinationHealth;
  lastSuccessAt: number | null;
  lastFailureAt: number | null;
  lastError: string | null;
  consecutiveFailures: number;
  createdByUserId: string | null;
  createdAt: number;
  updatedAt: number;
}

export type CreateNotificationDestinationRequest = NotificationDestinationConfig & {
  name: string;
  enabled?: boolean;
  events: NotificationEventType[];
  databaseIds?: string[] | null;
  iconUrl?: string | null;
  skipUnchanged?: boolean;
};

export type NotificationDestinationConfigPatch =
  | Partial<DiscordDestinationConfig>
  | Partial<SlackDestinationConfig>
  | Partial<WebhookDestinationConfig>
  | (Partial<Omit<NtfyDestinationConfig, "priority">> & { priority?: 1 | 2 | 3 | 4 | 5 | null });

export interface UpdateNotificationDestinationRequest {
  name?: string;
  enabled?: boolean;
  events?: NotificationEventType[];
  databaseIds?: string[] | null;
  iconUrl?: string | null;
  skipUnchanged?: boolean;
  config?: NotificationDestinationConfigPatch;
}

export interface NotificationDestinationResponse {
  destination: NotificationDestination;
}

export interface NotificationDestinationListResponse {
  destinations: NotificationDestination[];
}

export type NotificationDeliveryStatus = "queued" | "sending" | "sent" | "failed" | "dropped";

export interface NotificationDelivery {
  id: string;
  destinationId: string;
  eventType: NotificationEventType | "test";
  title: string;
  status: NotificationDeliveryStatus;
  attempts: number;
  responseStatus: number | null;
  lastError: string | null;
  createdAt: number;
  sentAt: number | null;
  nextAttemptAt: number | null;
}

export interface NotificationDeliveryListResponse {
  deliveries: NotificationDelivery[];
}

export interface NotificationTestResponse {
  ok: boolean;
  responseStatus: number | null;
  error: string | null;
  durationMs: number;
}

export interface NotificationWebhookPayload {
  version: 1;
  product: "lambdata";
  id: string;
  type: NotificationEventType | "test" | "summary";
  group: NotificationGroup | "test" | "summary";
  severity: NotificationSeverity;
  occurredAt: string;
  title: string;
  message: string;
  actor: { displayName: string } | null;
  database: { id: string; name: string; displayName: string } | null;
  data: Record<string, string | number | boolean | null>;
  changes?: { tables: TableRowChange[]; truncated: boolean } | null;
  link: string | null;
  iconUrl: string | null;
}
