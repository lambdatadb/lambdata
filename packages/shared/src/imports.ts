import type { Database, DatabaseCredentials } from "./types";
import type { CheckpointJobOutcome, CodeObjectFailure } from "./checkpoints";
import type { Job } from "./jobs";

export type ImportSourceFormat = "sqlite" | "sql";
export type ImportMode = "create" | "replace";
export type SqliteStorageClass = "integer" | "real" | "text" | "blob" | "null";

export interface ImportUpload {
  id: string;
  fileName: string;
  sizeBytes: number;
  sha256: string;
  format: ImportSourceFormat;
  createdAt: number;
  expiresAt: number;
}

export interface ImportColumnPlan {
  sourceName: string;
  targetName: string;
  declaredType: string | null;
  observed: Record<SqliteStorageClass, number>;
  maxLength: number | null;
  mariadbType: string;
  nullable: boolean;
  primaryKey: boolean;
  autoIncrement: boolean;
  defaultSql: string | null;
  notes: string[];
}

export interface ImportIndexPlan {
  name: string;
  columns: string[];
  unique: boolean;
  skippedReason: string | null;
}

export interface ImportForeignKeyPlan {
  columns: string[];
  refTable: string;
  refColumns: string[];
  skippedReason: string | null;
}

export interface ImportTablePlan {
  sourceName: string;
  targetName: string;
  rowCount: number;
  columns: ImportColumnPlan[];
  indexes: ImportIndexPlan[];
  foreignKeys: ImportForeignKeyPlan[];
  warnings: string[];
  createSql: string;
}

export interface ImportSkippedObject {
  kind: "view" | "trigger" | "virtual-table" | "internal";
  name: string;
  reason: string;
  sql: string | null;
}

export interface SqliteImportPlan {
  format: "sqlite";
  upload: ImportUpload;
  tables: ImportTablePlan[];
  skipped: ImportSkippedObject[];
  warnings: string[];
  totals: { tables: number; rows: number; warnings: number };
}

export interface SqlImportPlan {
  format: "sql";
  upload: ImportUpload;
  compressed: boolean;
  warnings: string[];
}

export type ImportPlan = SqliteImportPlan | SqlImportPlan;

export interface ImportRecord {
  id: string;
  databaseId: string;
  fileName: string;
  sizeBytes: number;
  sha256: string;
  format: ImportSourceFormat;
  mode: ImportMode;
  tableCount: number | null;
  rowCount: number | null;
  warningCount: number;
  importedByUserId: string | null;
  importedByDisplayName: string | null;
  importedAt: number;
}

export interface ImportUploadResponse {
  upload: ImportUpload;
}

export interface ImportPlanResponse {
  plan: ImportPlan;
}

export interface ImportCreateDatabaseRequest {
  displayName: string;
  connectionsFrom?: string;
  tailnetOnly?: boolean;
  versioned?: boolean;
}

export interface ImportCreateDatabaseResponse {
  database: Database;
  credentials: DatabaseCredentials | null;
  job: Job;
}

export interface ImportReplaceRequest {
  uploadId: string;
}

export interface ImportListResponse {
  imports: ImportRecord[];
}

export interface ImportJobResult {
  importId: string;
  tableCount: number | null;
  rowCount: number | null;
  safetyCheckpointId: string | null;
  checkpointId: string | null;
  durationMs: number;
  outcome?: CheckpointJobOutcome;
  codeFailures?: CodeObjectFailure[];
}

export interface ImportLimitsResponse {
  maxUploadBytes: number;
}
