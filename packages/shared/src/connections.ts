export type DatabasePortSource = "env" | "setting" | "default";

export interface DatabasePortStatus {
  bind: string;
  port: number;
  outsideConnections: boolean;
  source: DatabasePortSource;
  lockedByEnv: boolean;
  inContainer: boolean;
  rejectionsSupported: boolean;
}

export interface UpdateDatabasePortRequest {
  outsideConnections: boolean;
}

export interface DatabasePortResponse {
  databasePort: DatabasePortStatus;
}

export type ConnectionRejectionReason =
  | "address-not-allowed"
  | "wrong-password"
  | "unknown-account"
  | "closed-for-operation"
  | "other";

export interface RejectedConnection {
  address: string;
  account: string | null;
  databaseId: string | null;
  databaseName: string | null;
  reason: ConnectionRejectionReason;
  explanation: string;
  count: number;
  firstAt: number;
  lastAt: number;
  canAllow: boolean;
}

export interface RejectedConnectionsResponse {
  supported: boolean;
  since: number | null;
  rejections: RejectedConnection[];
}

export interface DatabaseConnectionInfo {
  host: string | null;
  port: number;
  outsideConnections: boolean;
}
