export type CheckpointTrigger =
  | "manual"
  | "scheduled"
  | "sync"
  | "pre-sync"
  | "pre-restore"
  | "pre-import"
  | "import"
  | "legacy";

export type CheckpointFormat = "v1" | "legacy";

export interface Checkpoint {
  id: string;
  databaseId: string;
  hash: string;
  shortHash: string;
  treeHash: string | null;
  parentId: string | null;
  message: string;
  trigger: CheckpointTrigger;
  format: CheckpointFormat;
  createdByUserId: string | null;
  createdByDisplayName: string | null;
  createdAt: number;
  tableCount: number | null;
  rowCount: number | null;
  logicalBytes: number;
  storedBytes: number;
  newBytes: number;
  pinned: boolean;
  isBase: boolean;
  limitations?: string[];
  schemaCharset?: string | null;
  schemaCollation?: string | null;
  verifiedAt?: number | null;
}

export interface CheckpointEntry {
  name: string;
  kind: "table" | "code" | "legacy";
  objectHash: string;
  rowCount: number | null;
  logicalBytes: number;
  storedBytes: number;
}

export interface CheckpointTableDiff {
  name: string;
  change: "added" | "removed" | "modified";
  schemaChanged: boolean;
  rowsBefore: number | null;
  rowsAfter: number | null;
}

export interface CheckpointDiff {
  fromId: string | null;
  toId: string;
  tables: CheckpointTableDiff[];
  codeChanged: boolean;
  unchangedTables: number;
  rowDelta: number | null;
}

export type WorkingCopyState = "clean" | "dirty" | "unknown" | "no-checkpoint";

export interface WorkingCopyStatus {
  databaseId: string;
  baseCheckpointId: string | null;
  state: WorkingCopyState;
  reason: string | null;
  computedAt: number | null;
  diff: CheckpointDiff | null;
}

export interface CheckpointPolicy {
  versioned: boolean;
  autoIntervalHours: number;
  autoRetention: number;
  checkpointOnSync: boolean;
}

export interface CheckpointStorageStats {
  checkpoints: number;
  storedBytes: number;
  logicalBytes: number;
}

export interface UnconvertedSnapshot {
  snapshotId: string;
  databaseId: string;
  createdAt: number;
  trigger: "manual" | "scheduled";
  sizeBytes: number;
  reason: string;
  failedAt: number;
  attempts: number;
}

export interface CheckpointListResponse {
  checkpoints: Checkpoint[];
  policy: CheckpointPolicy;
  storage: CheckpointStorageStats;
  unconverted?: UnconvertedSnapshot[];
}

export interface CheckpointHealthDetail {
  unconvertedSnapshots: number;
  lastConversionError: string | null;
}

export interface CodeObjectFailure {
  kind: string;
  name: string;
  error: string;
}

export type CheckpointJobOutcome = "done" | "done-with-errors";

export interface CheckpointDetailResponse {
  checkpoint: Checkpoint;
  entries: CheckpointEntry[];
  diffFromParent: CheckpointDiff | null;
}

export interface CheckpointStatusResponse {
  status: WorkingCopyStatus;
}

export interface CheckpointDiffResponse {
  diff: CheckpointDiff;
}

export interface CreateCheckpointRequest {
  message?: string;
  verify?: boolean;
}

export interface UpdateCheckpointRequest {
  message?: string;
  pinned?: boolean;
}

export interface CheckpointCreateJobResult {
  checkpointId: string | null;
  unchanged: boolean;
  limitations?: string[];
  verified?: boolean;
}

export interface RestoreCheckpointRequest {
  allowCodeFailures?: boolean;
}

export interface CheckpointRestoreJobResult {
  restoredCheckpointId: string;
  safetyCheckpointId: string | null;
  outcome?: CheckpointJobOutcome;
  codeFailures?: CodeObjectFailure[];
}

export type UpdateCheckpointPolicyRequest = Partial<CheckpointPolicy>;

export interface CheckpointPolicyResponse {
  policy: CheckpointPolicy;
}

export interface CheckpointResponse {
  checkpoint: Checkpoint;
}

export interface SyncJobResult {
  status: "ok";
  tables: number;
  preSyncCheckpointId: string | null;
  checkpointId: string | null;
  unchanged: boolean;
  outcome?: CheckpointJobOutcome;
  codeFailures?: CodeObjectFailure[];
}
