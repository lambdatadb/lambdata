import type { IngressKind } from "./network";
import type { Database, DatabaseCredentials } from "./types";

export const ACCESS_TOKEN_PREFIX = "ld_";
export const APPROVAL_HEADER = "X-LambData-Approval";
export const NOTE_HEADER = "X-LambData-Note";
export const NOTE_MAX_LENGTH = 200;
export const APPROVAL_REQUIRED_CODE = "approval_required";

export type AccessTokenPreset = "read_only" | "builder" | "admin";

export type AccessTokenStatus = "active" | "paused" | "expired" | "revoked";

export type AccessTokenVia = "api" | "mcp";

export interface AccessTokenLimits {
  maxDatabases: number | null;
  requestsPerMinute: number;
}

export interface AccessToken {
  id: string;
  name: string;
  preset: AccessTokenPreset;
  prefix: string;
  status: AccessTokenStatus;
  paused: boolean;
  createdAt: number;
  createdByUserId: string | null;
  createdByDisplayName: string | null;
  expiresAt: number | null;
  revokedAt: number | null;
  lastUsedAt: number | null;
  lastUsedFrom: string | null;
  lastUsedVia: AccessTokenVia | null;
  databaseIds: string[] | null;
  allowedFrom: IngressKind[];
  revealCredentials: boolean;
  askFirst: boolean;
  limits: AccessTokenLimits;
  databasesCreated: number;
  pendingApprovals: number;
}

export interface AccessTokenPresetDefaults {
  revealCredentials: boolean;
  askFirst: boolean;
  allowedFrom: IngressKind[];
  limits: AccessTokenLimits;
}

export interface AccessTokenPresetInfo {
  preset: AccessTokenPreset;
  label: string;
  summary: string;
  can: string[];
  cannot: string[];
  canRevealCredentials: boolean;
  defaults: AccessTokenPresetDefaults;
}

export interface AccessTokenListResponse {
  tokens: AccessToken[];
  allPaused: boolean;
  presets: AccessTokenPresetInfo[];
}

export interface CreateAccessTokenRequest {
  name: string;
  preset: AccessTokenPreset;
  expiresAt?: number | null;
  databaseIds?: string[] | null;
  allowedFrom?: IngressKind[];
  revealCredentials?: boolean;
  askFirst?: boolean;
  limits?: Partial<AccessTokenLimits>;
}

export interface CreateAccessTokenResponse {
  token: AccessToken;
  secret: string;
}

export interface UpdateAccessTokenRequest {
  name?: string;
  paused?: boolean;
  expiresAt?: number | null;
  databaseIds?: string[] | null;
  allowedFrom?: IngressKind[];
  revealCredentials?: boolean;
  askFirst?: boolean;
  limits?: Partial<AccessTokenLimits>;
}

export interface AccessTokenResponse {
  token: AccessToken;
}

export interface PauseAllAccessTokensRequest {
  paused: boolean;
}

export interface PauseAllAccessTokensResponse {
  allPaused: boolean;
}

export interface AccessTokenIdentity {
  token: AccessToken;
  can: string[];
  cannot: string[];
  allPaused: boolean;
}

export type TokenActivityOutcome = "ok" | "refused" | "error" | "waiting-approval";

export interface TokenActivityEntry {
  id: number;
  tokenId: string;
  at: number;
  via: AccessTokenVia;
  action: string;
  summary: string;
  databaseId: string | null;
  databaseName: string | null;
  outcome: TokenActivityOutcome;
  status: number;
  note: string | null;
  from: string | null;
  detail: string | null;
}

export interface TokenActivityResponse {
  entries: TokenActivityEntry[];
  nextBefore: number | null;
}

export type ApprovalStatus = "pending" | "approved" | "denied" | "expired" | "used" | "cancelled";

export type ApprovalAction =
  | "database.delete"
  | "checkpoint.rollback"
  | "checkpoint.delete"
  | "import.replace"
  | "sql.destructive";

export interface Approval {
  id: string;
  tokenId: string;
  tokenName: string;
  action: ApprovalAction;
  summary: string;
  detail: string | null;
  databaseId: string | null;
  databaseName: string | null;
  note: string | null;
  status: ApprovalStatus;
  requestedAt: number;
  expiresAt: number;
  decidedAt: number | null;
  decidedByDisplayName: string | null;
  approvedUntil?: number | null;
  usedAt: number | null;
}

export interface ApprovalListResponse {
  approvals: Approval[];
  pending: number;
}

export interface ApprovalResponse {
  approval: Approval;
}

export interface DecideApprovalRequest {
  decision: "approve" | "deny";
}

export interface ApprovalRequiredBody {
  error: string;
  code: typeof APPROVAL_REQUIRED_CODE;
  approval: Approval;
}

export interface EnsureDatabaseResponse {
  database: Database;
  credentials: DatabaseCredentials | null;
  created: boolean;
}

export interface UndoPoint {
  checkpointId: string;
  shortHash: string;
  message: string;
  createdAt: number;
  tokenId: string;
  tokenName: string;
}

export interface UndoPointResponse {
  undo: UndoPoint | null;
  versioned: boolean;
}

export interface QueryUndoInfo {
  checkpointId: string;
  shortHash: string;
  createdNow: boolean;
}
