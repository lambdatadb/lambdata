import type { ImportMode, ImportRecord, ImportSourceFormat, ImportUpload } from "@lambdata/shared";
import { db } from "../client";

type UploadRow = {
  id: string;
  user_id: string | null;
  file_name: string;
  size_bytes: number;
  sha256: string;
  format: ImportSourceFormat;
  compressed: number;
  created_at: number;
  expires_at: number;
};

type RecordRow = {
  id: string;
  database_id: string;
  file_name: string;
  size_bytes: number;
  sha256: string;
  format: ImportSourceFormat;
  mode: ImportMode;
  table_count: number | null;
  row_count: number | null;
  warning_count: number;
  imported_by_user_id: string | null;
  imported_by_display_name: string | null;
  imported_at: number;
};

export interface StoredUpload extends ImportUpload {
  userId: string | null;
  compressed: boolean;
}

function rowToUpload(r: UploadRow): StoredUpload {
  return {
    id: r.id,
    userId: r.user_id,
    fileName: r.file_name,
    sizeBytes: Number(r.size_bytes),
    sha256: r.sha256,
    format: r.format,
    compressed: r.compressed === 1,
    createdAt: Number(r.created_at),
    expiresAt: Number(r.expires_at),
  };
}

function rowToRecord(r: RecordRow): ImportRecord {
  return {
    id: r.id,
    databaseId: r.database_id,
    fileName: r.file_name,
    sizeBytes: Number(r.size_bytes),
    sha256: r.sha256,
    format: r.format,
    mode: r.mode,
    tableCount: r.table_count === null ? null : Number(r.table_count),
    rowCount: r.row_count === null ? null : Number(r.row_count),
    warningCount: Number(r.warning_count),
    importedByUserId: r.imported_by_user_id,
    importedByDisplayName: r.imported_by_display_name,
    importedAt: Number(r.imported_at),
  };
}

export function publicUpload(u: StoredUpload): ImportUpload {
  return {
    id: u.id,
    fileName: u.fileName,
    sizeBytes: u.sizeBytes,
    sha256: u.sha256,
    format: u.format,
    createdAt: u.createdAt,
    expiresAt: u.expiresAt,
  };
}

const RECORD_SELECT = `SELECT i.*, u.display_name AS imported_by_display_name
  FROM imports i LEFT JOIN users u ON u.id = i.imported_by_user_id`;

export const imports = {
  insertUpload(u: StoredUpload): void {
    db.query(
      `INSERT INTO import_uploads(id, user_id, file_name, size_bytes, sha256, format, compressed, created_at, expires_at)
       VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(u.id, u.userId, u.fileName, u.sizeBytes, u.sha256, u.format, u.compressed ? 1 : 0, u.createdAt, u.expiresAt);
  },
  uploadById(id: string): StoredUpload | null {
    const r = db.query("SELECT * FROM import_uploads WHERE id = ?").get(id) as UploadRow | null;
    return r ? rowToUpload(r) : null;
  },
  deleteUpload(id: string): void {
    db.query("DELETE FROM import_uploads WHERE id = ?").run(id);
  },
  expiredUploads(now: number): StoredUpload[] {
    const rows = db.query("SELECT * FROM import_uploads WHERE expires_at <= ?").all(now) as UploadRow[];
    return rows.map(rowToUpload);
  },
  uploadIds(): Set<string> {
    const rows = db.query("SELECT id FROM import_uploads").all() as { id: string }[];
    return new Set(rows.map((r) => r.id));
  },
  insertRecord(r: Omit<ImportRecord, "importedByDisplayName">): void {
    db.query(
      `INSERT INTO imports(id, database_id, file_name, size_bytes, sha256, format, mode, table_count, row_count,
        warning_count, imported_by_user_id, imported_at)
       VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      r.id,
      r.databaseId,
      r.fileName,
      r.sizeBytes,
      r.sha256,
      r.format,
      r.mode,
      r.tableCount,
      r.rowCount,
      r.warningCount,
      r.importedByUserId,
      r.importedAt,
    );
  },
  recordById(id: string): ImportRecord | null {
    const r = db.query(`${RECORD_SELECT} WHERE i.id = ?`).get(id) as RecordRow | null;
    return r ? rowToRecord(r) : null;
  },
  listRecords(databaseId: string, limit = 100): ImportRecord[] {
    const rows = db
      .query(`${RECORD_SELECT} WHERE i.database_id = ? ORDER BY i.imported_at DESC, i.id DESC LIMIT ?`)
      .all(databaseId, limit) as RecordRow[];
    return rows.map(rowToRecord);
  },
};

export interface ImportRun {
  jobId: string;
  databaseId: string;
  mode: ImportMode;
  schemaName: string;
  startedAt: number;
}

export const importRuns = {
  start(run: ImportRun): void {
    db.query(
      "INSERT OR REPLACE INTO import_runs(job_id, database_id, mode, schema_name, started_at) VALUES(?, ?, ?, ?, ?)",
    ).run(run.jobId, run.databaseId, run.mode, run.schemaName, run.startedAt);
  },
  finish(jobId: string): void {
    db.query("DELETE FROM import_runs WHERE job_id = ?").run(jobId);
  },
  list(): ImportRun[] {
    const rows = db.query("SELECT * FROM import_runs ORDER BY started_at").all() as {
      job_id: string;
      database_id: string;
      mode: ImportMode;
      schema_name: string;
      started_at: number;
    }[];
    return rows.map((r) => ({ jobId: r.job_id, databaseId: r.database_id, mode: r.mode, schemaName: r.schema_name, startedAt: Number(r.started_at) }));
  },
};
