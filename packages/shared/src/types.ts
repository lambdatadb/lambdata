import type { CheckpointHealthDetail } from "./checkpoints";

export type Role = "admin" | "db_owner" | "viewer";
export type ExperienceLevel = "novice" | "advanced";
export type ColorTheme = "lime" | "ember" | "tide" | "grove" | "orchid";
export type VitalsChartStyle = "area" | "capsules";
export type DatabaseKind = "standard" | "mirror";
export type DatabaseStatus = "active" | "suspended" | "deleting";
export type SnapshotTrigger = "manual" | "scheduled";
export type SyncSourceKind = "mysql" | "postgres";
export type SyncStatus = "ok" | "error";
export type AppAuthUserStatus = "active" | "disabled";

export interface AppAuthUser {
  id: string;
  email: string;
  displayName: string | null;
  emailConfirmed: boolean;
  status: AppAuthUserStatus;
  createdAt: number;
  lastSignInAt: number | null;
}

export interface AppAuthSession {
  accessToken: string;
  tokenType: "bearer";
  expiresIn: number;
  user: AppAuthUser;
}

export interface AppAuthSettings {
  allowSignup: boolean;
  tokenTtlSeconds: number;
  issuer: string;
  signupDisabledByUpgrade?: boolean;
  signupRefusedCount?: number;
  signupRefusedLastAt?: number | null;
}

export interface StorageBucket {
  id: string;
  name: string;
  public: boolean;
  ownerUserId: string;
  ownerDisplayName?: string | null;
  objectCount: number;
  totalSizeBytes: number;
  createdAt: number;
  updatedAt: number;
}

export interface StorageObject {
  id: string;
  bucketId: string;
  name: string;
  mimeType: string | null;
  sizeBytes: number;
  createdAt: number;
  updatedAt: number;
}

export interface RealtimeBroadcastMessage {
  channel?: string;
  topic?: string;
  event: string;
  payload?: unknown;
  self?: boolean;
}

export interface RealtimeBroadcastRequest {
  messages: RealtimeBroadcastMessage[];
}

export interface RealtimeChannelStatus {
  name: string;
  subscribers: number;
  presence: number;
}

export interface RealtimeStatus {
  connections: number;
  channels: RealtimeChannelStatus[];
  messagesSent: number;
}

export interface DataApiColumn {
  name: string;
  dataType: string;
  nullable: boolean;
  primary: boolean;
  generated: boolean;
  defaultValue: string | null;
  ordinalPosition: number;
}

export type DataApiOperation = "select" | "insert" | "update" | "delete";

export interface DataApiPolicy {
  databaseId: string;
  tableName: string;
  selectEnabled: boolean;
  insertEnabled: boolean;
  updateEnabled: boolean;
  deleteEnabled: boolean;
  ownerColumn: string | null;
  createdAt: number | null;
  updatedAt: number | null;
}

export interface DataApiTable {
  name: string;
  rowCount: number;
  sizeBytes: number;
  columns: DataApiColumn[];
  policy: DataApiPolicy | null;
}

export interface DataApiSchema {
  database: Database;
  tables: DataApiTable[];
  openApiPath: string;
  generatedAt: number;
}

export interface EdgeFunction {
  name: string;
  verifyJwt: boolean;
  entrypoint: string;
  sourceSizeBytes: number;
  sourceUpdatedAt: number;
  createdAt: number | null;
  updatedAt: number | null;
  invocationCount: number;
  lastInvokedAt: number | null;
  lastStatusCode: number | null;
  lastDurationMs: number | null;
}

export interface EdgeFunctionSecret {
  name: string;
  createdAt: number;
  updatedAt: number;
}

export interface EdgeFunctionInvocation {
  id: string;
  functionName: string;
  method: string;
  path: string;
  statusCode: number | null;
  durationMs: number;
  requestBytes: number;
  responseBytes: number;
  error: string | null;
  logs: string | null;
  invokedByAppUserId: string | null;
  createdAt: number;
}

export interface User {
  id: string;
  email: string;
  displayName: string | null;
  role: Role;
  experienceLevel: ExperienceLevel;
  dataViewEnabled: boolean;
  colorTheme: ColorTheme;
  vitalsChartStyle: VitalsChartStyle;
  createdAt: number;
  lastLoginAt: number | null;
}

export interface Database {
  id: string;
  name: string;
  displayName: string;
  ownerUserId: string;
  ownerDisplayName?: string | null;
  kind: DatabaseKind;
  mysqlUser: string;
  connectionsFrom: string;
  tailscaleExposed: boolean;
  lanExposed: boolean;
  createdAt: number;
  status: DatabaseStatus;
  versioned: boolean;
  baseCheckpointId: string | null;
  baseShortHash: string | null;
  showInVitals: boolean;
}

export interface DatabaseCredentials {
  host: string;
  port: number;
  schema: string;
  user: string;
  password: string;
  mysqlCli: string;
  jdbc: string;
  uri: string;
}

export interface SyncJob {
  id: string;
  databaseId: string;
  sourceKind: SyncSourceKind;
  sourceHost: string;
  sourcePort: number;
  sourceUser: string;
  sourceDatabase: string;
  intervalSeconds: number;
  lastRunAt: number | null;
  lastStatus: SyncStatus | null;
  lastError: string | null;
  enabled: boolean;
}

export interface Snapshot {
  id: string;
  databaseId: string;
  filePath: string;
  sizeBytes: number;
  createdAt: number;
  trigger: SnapshotTrigger;
}

export interface MetricSample {
  collectedAt: number;
  sizeBytes: number | null;
  tableCount: number | null;
  connectionCount: number | null;
  rowCount: number | null;
}

export interface TableBreakdownEntry {
  name: string;
  rowCount: number;
  sizeBytes: number;
  avgRowBytes: number;
}

export interface TableBreakdown {
  collectedAt: number;
  tables: TableBreakdownEntry[];
}

export interface DashboardVitalsSeries {
  databaseId: string;
  name: string;
  displayName: string;
  kind: DatabaseKind;
  samples: MetricSample[];
}

export interface DashboardVitals {
  rangeMs: number;
  collectedAt: number;
  series: DashboardVitalsSeries[];
}

export interface TailscaleStatus {
  installed: boolean;
  running: boolean;
  hostname: string | null;
  tailnetIp: string | null;
  managedBy: "unraid" | null;
}

export interface SetupState {
  needsSetup: boolean;
  dataDir: string;
  dataDirConfigured: boolean;
  homeDir: string;
}

export interface QueryResult {
  columns: string[];
  rows: unknown[][];
  durationMs: number;
  rowCount: number;
}

export interface AppSettings {
  setupComplete: boolean;
  tailscaleEnabled: boolean;
  dashboardShowAddresses: boolean;
  mariadbPort: number;
  dataDir: string;
  pointerPath: string;
  dataDirFreeBytes: number | null;
  limits?: SettingsLimits;
}

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

export interface PathValidationResponse {
  ok: boolean;
  error: string | null;
  resolvedPath: string;
  exists: boolean;
  writable: boolean;
  freeBytes: number | null;
  isEmpty: boolean | null;
}

export interface PickFolderResponse {
  canceled: boolean;
  path: string | null;
  unsupported?: boolean;
}

export interface DataDirMigrationResponse {
  ok: true;
  oldPath: string;
  newPath: string;
  bytesCopied: number;
  durationMs: number;
}

export interface AuthResponse {
  user: User;
}

export interface AuditLogEntry {
  id: number;
  user_id: string | null;
  action: string;
  target: string | null;
  details: string | null;
  at: number;
  user_email: string | null;
  user_display_name: string | null;
}

export type MariaDbState = "stopped" | "starting" | "running" | "restarting" | "stopping" | "failed";

export interface HealthDetail {
  ok: boolean;
  mariadb: { ok: boolean; error?: string; state: MariaDbState; restarts: number };
  workers: { metrics: boolean; sync: boolean; checkpoints: boolean };
  checkpoints?: CheckpointHealthDetail;
  uptimeSec: number;
}

export interface DashboardSummaryDbMetrics {
  databaseId: string;
  name: string;
  displayName: string;
  kind: DatabaseKind;
  sizeBytes: number | null;
  tableCount: number | null;
  connectionCount: number | null;
  rowCount: number | null;
  collectedAt: number | null;
}

export interface DashboardSummary {
  databases: { total: number; active: number; mirrors: number };
  latestMetrics: DashboardSummaryDbMetrics[];
  storage: { buckets: number; objects: number; totalSizeBytes: number };
  checkpoints: {
    total: number;
    lastAt: number | null;
    last24hCount: number;
    storedBytes: number;
    versionedDatabases: number;
  };
  sync: { mirrors: number; ok: number; failing: number; lastError: string | null };
  realtime: { connections: number; channels: number; messagesSent: number };
  functions: { total: number; invocations24h: number };
  system: {
    dataDirFreeBytes: number | null;
    mariadbOk: boolean;
    host: string;
    port: number;
    dashboardShowAddresses: boolean;
  };
}
