import type {
  AppAuthUser,
  AppAuthUserStatus,
  AuditLogEntry,
  Database as Db,
  DataApiPolicy,
  DatabaseKind,
  DatabaseStatus,
  EdgeFunctionInvocation,
  EdgeFunctionSecret,
  ExperienceLevel,
  Role,
  Snapshot,
  SnapshotTrigger,
  StorageBucket,
  StorageObject,
  SyncJob,
  SyncSourceKind,
  SyncStatus,
  User,
} from "@kilndb/shared";
import { db } from "./client";

type UserRow = {
  id: string;
  email: string;
  password_hash: string;
  display_name: string | null;
  role: Role;
  experience_level: ExperienceLevel;
  data_view_enabled: number;
  created_at: number;
  last_login_at: number | null;
};

type AppAuthUserRow = {
  id: string;
  email: string;
  password_hash: string;
  display_name: string | null;
  email_confirmed: number;
  status: AppAuthUserStatus;
  created_at: number;
  last_sign_in_at: number | null;
};

type DatabaseRow = {
  id: string;
  name: string;
  display_name: string;
  owner_user_id: string;
  owner_display_name?: string | null;
  kind: DatabaseKind;
  mysql_user: string;
  mysql_password_enc: string;
  connections_from: string;
  tailscale_exposed: number;
  lan_exposed: number;
  created_at: number;
  status: DatabaseStatus;
};

type SyncRow = {
  id: string;
  database_id: string;
  source_kind: SyncSourceKind;
  source_host: string;
  source_port: number;
  source_user: string;
  source_password_enc: string;
  source_database: string;
  interval_seconds: number;
  last_run_at: number | null;
  last_status: SyncStatus | null;
  last_error: string | null;
  enabled: number;
};

type SnapshotRow = {
  id: string;
  database_id: string;
  file_path: string;
  size_bytes: number;
  created_at: number;
  trigger: SnapshotTrigger;
};

type StorageBucketRow = {
  id: string;
  name: string;
  public: number;
  owner_user_id: string;
  owner_display_name?: string | null;
  object_count?: number | null;
  total_size_bytes?: number | null;
  created_at: number;
  updated_at: number;
};

type StorageObjectRow = {
  id: string;
  bucket_id: string;
  name: string;
  relative_path: string;
  mime_type: string | null;
  size_bytes: number;
  created_at: number;
  updated_at: number;
};

type FunctionRow = {
  name: string;
  verify_jwt: number;
  created_by_user_id: string | null;
  created_at: number;
  updated_at: number;
};

type FunctionSecretRow = {
  name: string;
  value_enc: string;
  created_at: number;
  updated_at: number;
};

type FunctionInvocationRow = {
  id: string;
  function_name: string;
  method: string;
  path: string;
  status_code: number | null;
  duration_ms: number;
  request_bytes: number;
  response_bytes: number;
  error: string | null;
  logs: string | null;
  invoked_by_app_user_id: string | null;
  created_at: number;
};

type DataApiPolicyRow = {
  database_id: string;
  table_name: string;
  select_enabled: number;
  insert_enabled: number;
  update_enabled: number;
  delete_enabled: number;
  owner_column: string | null;
  created_at: number;
  updated_at: number;
};

function rowToUser(r: UserRow): User {
  return {
    id: r.id,
    email: r.email,
    displayName: r.display_name,
    role: r.role,
    experienceLevel: r.experience_level,
    dataViewEnabled: r.data_view_enabled === 1,
    createdAt: r.created_at,
    lastLoginAt: r.last_login_at,
  };
}

function rowToAppAuthUser(r: AppAuthUserRow): AppAuthUser {
  return {
    id: r.id,
    email: r.email,
    displayName: r.display_name,
    emailConfirmed: r.email_confirmed === 1,
    status: r.status,
    createdAt: r.created_at,
    lastSignInAt: r.last_sign_in_at,
  };
}

function rowToDb(r: DatabaseRow): Db {
  return {
    id: r.id,
    name: r.name,
    displayName: r.display_name,
    ownerUserId: r.owner_user_id,
    ownerDisplayName: r.owner_display_name ?? null,
    kind: r.kind,
    mysqlUser: r.mysql_user,
    connectionsFrom: r.connections_from,
    tailscaleExposed: r.tailscale_exposed === 1,
    lanExposed: r.lan_exposed === 1,
    createdAt: r.created_at,
    status: r.status,
  };
}

function rowToSync(r: SyncRow): SyncJob {
  return {
    id: r.id,
    databaseId: r.database_id,
    sourceKind: r.source_kind,
    sourceHost: r.source_host,
    sourcePort: r.source_port,
    sourceUser: r.source_user,
    sourceDatabase: r.source_database,
    intervalSeconds: r.interval_seconds,
    lastRunAt: r.last_run_at,
    lastStatus: r.last_status,
    lastError: r.last_error,
    enabled: r.enabled === 1,
  };
}

function rowToSnapshot(r: SnapshotRow): Snapshot {
  return {
    id: r.id,
    databaseId: r.database_id,
    filePath: r.file_path,
    sizeBytes: r.size_bytes,
    createdAt: r.created_at,
    trigger: r.trigger,
  };
}

function rowToStorageBucket(r: StorageBucketRow): StorageBucket {
  return {
    id: r.id,
    name: r.name,
    public: r.public === 1,
    ownerUserId: r.owner_user_id,
    ownerDisplayName: r.owner_display_name ?? null,
    objectCount: Number(r.object_count ?? 0),
    totalSizeBytes: Number(r.total_size_bytes ?? 0),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function rowToStorageObject(r: StorageObjectRow): StorageObject & { relativePath: string } {
  return {
    id: r.id,
    bucketId: r.bucket_id,
    name: r.name,
    mimeType: r.mime_type,
    sizeBytes: r.size_bytes,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    relativePath: r.relative_path,
  };
}

function rowToFunctionInvocation(r: FunctionInvocationRow): EdgeFunctionInvocation {
  return {
    id: r.id,
    functionName: r.function_name,
    method: r.method,
    path: r.path,
    statusCode: r.status_code,
    durationMs: r.duration_ms,
    requestBytes: r.request_bytes,
    responseBytes: r.response_bytes,
    error: r.error,
    logs: r.logs,
    invokedByAppUserId: r.invoked_by_app_user_id,
    createdAt: r.created_at,
  };
}

function rowToFunctionSecret(r: FunctionSecretRow): EdgeFunctionSecret {
  return {
    name: r.name,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function rowToDataApiPolicy(r: DataApiPolicyRow): DataApiPolicy {
  return {
    databaseId: r.database_id,
    tableName: r.table_name,
    selectEnabled: r.select_enabled === 1,
    insertEnabled: r.insert_enabled === 1,
    updateEnabled: r.update_enabled === 1,
    deleteEnabled: r.delete_enabled === 1,
    ownerColumn: r.owner_column,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

// ---------- settings ----------

export const settings = {
  get(key: string): string | null {
    const row = db.query("SELECT value FROM settings WHERE key = ?").get(key) as
      | { value: string }
      | null;
    return row?.value ?? null;
  },
  set(key: string, value: string): void {
    db.query(
      "INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    ).run(key, value);
  },
};

// ---------- users ----------

export const users = {
  countAll(): number {
    const row = db.query("SELECT COUNT(*) AS n FROM users").get() as { n: number };
    return row.n;
  },
  list(): User[] {
    const rows = db
      .query("SELECT * FROM users ORDER BY created_at ASC")
      .all() as UserRow[];
    return rows.map(rowToUser);
  },
  byId(id: string): (User & { passwordHash: string }) | null {
    const r = db.query("SELECT * FROM users WHERE id = ?").get(id) as UserRow | null;
    return r ? { ...rowToUser(r), passwordHash: r.password_hash } : null;
  },
  byEmail(email: string): (User & { passwordHash: string }) | null {
    const r = db.query("SELECT * FROM users WHERE email = ?").get(email) as UserRow | null;
    return r ? { ...rowToUser(r), passwordHash: r.password_hash } : null;
  },
  insert(u: {
    id: string;
    email: string;
    passwordHash: string;
    displayName: string | null;
    role: Role;
    experienceLevel: ExperienceLevel;
  }): void {
    db.query(
      `INSERT INTO users(id, email, password_hash, display_name, role, experience_level, created_at)
       VALUES(?, ?, ?, ?, ?, ?, ?)`,
    ).run(u.id, u.email, u.passwordHash, u.displayName, u.role, u.experienceLevel, Date.now());
  },
  updateLastLogin(id: string): void {
    db.query("UPDATE users SET last_login_at = ? WHERE id = ?").run(Date.now(), id);
  },
  updateRole(id: string, role: Role): void {
    db.query("UPDATE users SET role = ? WHERE id = ?").run(role, id);
  },
  updatePassword(id: string, passwordHash: string): void {
    db.query("UPDATE users SET password_hash = ? WHERE id = ?").run(passwordHash, id);
  },
  updateExperience(id: string, level: ExperienceLevel): void {
    db.query("UPDATE users SET experience_level = ? WHERE id = ?").run(level, id);
  },
  updateDataView(id: string, enabled: boolean): void {
    db.query("UPDATE users SET data_view_enabled = ? WHERE id = ?").run(enabled ? 1 : 0, id);
  },
  delete(id: string): void {
    db.query("DELETE FROM users WHERE id = ?").run(id);
  },
};

// ---------- app auth users ----------

export const appAuthUsers = {
  list(): AppAuthUser[] {
    const rows = db
      .query("SELECT * FROM app_auth_users ORDER BY created_at DESC")
      .all() as AppAuthUserRow[];
    return rows.map(rowToAppAuthUser);
  },
  byId(id: string): (AppAuthUser & { passwordHash: string }) | null {
    const row = db.query("SELECT * FROM app_auth_users WHERE id = ?").get(id) as AppAuthUserRow | null;
    return row ? { ...rowToAppAuthUser(row), passwordHash: row.password_hash } : null;
  },
  byEmail(email: string): (AppAuthUser & { passwordHash: string }) | null {
    const row = db
      .query("SELECT * FROM app_auth_users WHERE email = ?")
      .get(email) as AppAuthUserRow | null;
    return row ? { ...rowToAppAuthUser(row), passwordHash: row.password_hash } : null;
  },
  insert(user: {
    id: string;
    email: string;
    passwordHash: string;
    displayName: string | null;
    emailConfirmed: boolean;
    status: AppAuthUserStatus;
  }): void {
    db.query(
      `INSERT INTO app_auth_users(
        id, email, password_hash, display_name, email_confirmed, status, created_at
      ) VALUES(?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      user.id,
      user.email,
      user.passwordHash,
      user.displayName,
      user.emailConfirmed ? 1 : 0,
      user.status,
      Date.now(),
    );
  },
  update(
    id: string,
    patch: Partial<{
      displayName: string | null;
      emailConfirmed: boolean;
      status: AppAuthUserStatus;
      passwordHash: string;
    }>,
  ): void {
    const sets: string[] = [];
    const values: unknown[] = [];
    if (patch.displayName !== undefined) {
      sets.push("display_name = ?");
      values.push(patch.displayName);
    }
    if (patch.emailConfirmed !== undefined) {
      sets.push("email_confirmed = ?");
      values.push(patch.emailConfirmed ? 1 : 0);
    }
    if (patch.status !== undefined) {
      sets.push("status = ?");
      values.push(patch.status);
    }
    if (patch.passwordHash !== undefined) {
      sets.push("password_hash = ?");
      values.push(patch.passwordHash);
    }
    if (sets.length === 0) return;
    values.push(id);
    db.query(`UPDATE app_auth_users SET ${sets.join(", ")} WHERE id = ?`).run(...(values as never[]));
  },
  updateLastSignIn(id: string): void {
    db.query("UPDATE app_auth_users SET last_sign_in_at = ? WHERE id = ?").run(Date.now(), id);
  },
  delete(id: string): void {
    db.query("DELETE FROM app_auth_users WHERE id = ?").run(id);
  },
};

// ---------- databases ----------

const DB_SELECT = `
  SELECT d.*, u.display_name AS owner_display_name
  FROM databases d
  LEFT JOIN users u ON u.id = d.owner_user_id
`;

export const databases = {
  list(): Db[] {
    const rows = db.query(`${DB_SELECT} ORDER BY d.created_at DESC`).all() as DatabaseRow[];
    return rows.map(rowToDb);
  },
  listForUser(userId: string): Db[] {
    const rows = db
      .query(`${DB_SELECT} WHERE d.owner_user_id = ? ORDER BY d.created_at DESC`)
      .all(userId) as DatabaseRow[];
    return rows.map(rowToDb);
  },
  byId(id: string): (Db & { mysqlPasswordEnc: string }) | null {
    const r = db.query(`${DB_SELECT} WHERE d.id = ?`).get(id) as DatabaseRow | null;
    return r ? { ...rowToDb(r), mysqlPasswordEnc: r.mysql_password_enc } : null;
  },
  byName(name: string): Db | null {
    const r = db.query(`${DB_SELECT} WHERE d.name = ?`).get(name) as DatabaseRow | null;
    return r ? rowToDb(r) : null;
  },
  insert(d: {
    id: string;
    name: string;
    displayName: string;
    ownerUserId: string;
    kind: DatabaseKind;
    mysqlUser: string;
    mysqlPasswordEnc: string;
    connectionsFrom: string;
    tailscaleExposed: boolean;
    lanExposed: boolean;
  }): void {
    db.query(
      `INSERT INTO databases(id, name, display_name, owner_user_id, kind,
        mysql_user, mysql_password_enc, connections_from, tailscale_exposed, lan_exposed, created_at)
       VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      d.id,
      d.name,
      d.displayName,
      d.ownerUserId,
      d.kind,
      d.mysqlUser,
      d.mysqlPasswordEnc,
      d.connectionsFrom,
      d.tailscaleExposed ? 1 : 0,
      d.lanExposed ? 1 : 0,
      Date.now(),
    );
  },
  update(
    id: string,
    patch: Partial<{
      displayName: string;
      connectionsFrom: string;
      tailscaleExposed: boolean;
      lanExposed: boolean;
      status: DatabaseStatus;
    }>,
  ): void {
    const sets: string[] = [];
    const vals: unknown[] = [];
    if (patch.displayName !== undefined) {
      sets.push("display_name = ?");
      vals.push(patch.displayName);
    }
    if (patch.connectionsFrom !== undefined) {
      sets.push("connections_from = ?");
      vals.push(patch.connectionsFrom);
    }
    if (patch.tailscaleExposed !== undefined) {
      sets.push("tailscale_exposed = ?");
      vals.push(patch.tailscaleExposed ? 1 : 0);
    }
    if (patch.lanExposed !== undefined) {
      sets.push("lan_exposed = ?");
      vals.push(patch.lanExposed ? 1 : 0);
    }
    if (patch.status !== undefined) {
      sets.push("status = ?");
      vals.push(patch.status);
    }
    if (sets.length === 0) return;
    vals.push(id);
    db.query(`UPDATE databases SET ${sets.join(", ")} WHERE id = ?`).run(...(vals as never[]));
  },
  updatePassword(id: string, mysqlPasswordEnc: string): void {
    db.query("UPDATE databases SET mysql_password_enc = ? WHERE id = ?").run(mysqlPasswordEnc, id);
  },
  delete(id: string): void {
    db.query("DELETE FROM databases WHERE id = ?").run(id);
  },
};

// ---------- sync_jobs ----------

export const syncJobs = {
  byDatabaseId(databaseId: string): SyncJob | null {
    const r = db
      .query("SELECT * FROM sync_jobs WHERE database_id = ?")
      .get(databaseId) as SyncRow | null;
    return r ? rowToSync(r) : null;
  },
  passwordEncFor(databaseId: string): string | null {
    const r = db
      .query("SELECT source_password_enc FROM sync_jobs WHERE database_id = ?")
      .get(databaseId) as { source_password_enc: string } | null;
    return r?.source_password_enc ?? null;
  },
  upsert(j: Omit<SyncJob, "lastRunAt" | "lastStatus" | "lastError"> & { passwordEnc: string }): void {
    const existing = this.byDatabaseId(j.databaseId);
    if (existing) {
      db.query(
        `UPDATE sync_jobs SET source_kind=?, source_host=?, source_port=?, source_user=?,
         source_password_enc=?, source_database=?, interval_seconds=?, enabled=? WHERE database_id=?`,
      ).run(
        j.sourceKind,
        j.sourceHost,
        j.sourcePort,
        j.sourceUser,
        j.passwordEnc,
        j.sourceDatabase,
        j.intervalSeconds,
        j.enabled ? 1 : 0,
        j.databaseId,
      );
    } else {
      db.query(
        `INSERT INTO sync_jobs(id, database_id, source_kind, source_host, source_port,
         source_user, source_password_enc, source_database, interval_seconds, enabled)
         VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        j.id,
        j.databaseId,
        j.sourceKind,
        j.sourceHost,
        j.sourcePort,
        j.sourceUser,
        j.passwordEnc,
        j.sourceDatabase,
        j.intervalSeconds,
        j.enabled ? 1 : 0,
      );
    }
  },
  recordRun(databaseId: string, status: SyncStatus, error: string | null): void {
    db.query(
      "UPDATE sync_jobs SET last_run_at = ?, last_status = ?, last_error = ? WHERE database_id = ?",
    ).run(Date.now(), status, error, databaseId);
  },
  deleteByDatabaseId(databaseId: string): void {
    db.query("DELETE FROM sync_jobs WHERE database_id = ?").run(databaseId);
  },
  listEnabled(): (SyncJob & { passwordEnc: string })[] {
    const rows = db.query("SELECT * FROM sync_jobs WHERE enabled = 1").all() as SyncRow[];
    return rows.map((r) => ({ ...rowToSync(r), passwordEnc: r.source_password_enc }));
  },
  listAll(): SyncJob[] {
    const rows = db.query("SELECT * FROM sync_jobs").all() as SyncRow[];
    return rows.map(rowToSync);
  },
};

// ---------- snapshots ----------

export const snapshots = {
  list(databaseId: string): Snapshot[] {
    const rows = db
      .query("SELECT * FROM snapshots WHERE database_id = ? ORDER BY created_at DESC")
      .all(databaseId) as SnapshotRow[];
    return rows.map(rowToSnapshot);
  },
  byId(id: string): Snapshot | null {
    const r = db.query("SELECT * FROM snapshots WHERE id = ?").get(id) as SnapshotRow | null;
    return r ? rowToSnapshot(r) : null;
  },
  insert(s: Snapshot): void {
    db.query(
      "INSERT INTO snapshots(id, database_id, file_path, size_bytes, created_at, trigger) VALUES(?, ?, ?, ?, ?, ?)",
    ).run(s.id, s.databaseId, s.filePath, s.sizeBytes, s.createdAt, s.trigger);
  },
  delete(id: string): void {
    db.query("DELETE FROM snapshots WHERE id = ?").run(id);
  },
  stats(
    sinceMs: number,
    databaseIds?: string[],
  ): { total: number; lastAt: number | null; last24hCount: number } {
    let sql =
      "SELECT COUNT(*) AS total, MAX(created_at) AS last_at, COALESCE(SUM(created_at >= ?), 0) AS recent FROM snapshots";
    const params: (number | string)[] = [sinceMs];
    if (databaseIds) {
      if (databaseIds.length === 0) return { total: 0, lastAt: null, last24hCount: 0 };
      sql += ` WHERE database_id IN (${databaseIds.map(() => "?").join(",")})`;
      params.push(...databaseIds);
    }
    const r = db.query(sql).get(...params) as {
      total: number;
      last_at: number | null;
      recent: number;
    };
    return { total: Number(r.total), lastAt: r.last_at, last24hCount: Number(r.recent) };
  },
};

// ---------- storage ----------

const STORAGE_BUCKET_SELECT = `
  SELECT b.*,
    u.display_name AS owner_display_name,
    COUNT(o.id) AS object_count,
    COALESCE(SUM(o.size_bytes), 0) AS total_size_bytes
  FROM storage_buckets b
  LEFT JOIN users u ON u.id = b.owner_user_id
  LEFT JOIN storage_objects o ON o.bucket_id = b.id
`;

export const storageBuckets = {
  list(): StorageBucket[] {
    const rows = db
      .query(`${STORAGE_BUCKET_SELECT} GROUP BY b.id ORDER BY b.updated_at DESC`)
      .all() as StorageBucketRow[];
    return rows.map(rowToStorageBucket);
  },
  listForUser(userId: string): StorageBucket[] {
    const rows = db
      .query(`${STORAGE_BUCKET_SELECT} WHERE b.owner_user_id = ? GROUP BY b.id ORDER BY b.updated_at DESC`)
      .all(userId) as StorageBucketRow[];
    return rows.map(rowToStorageBucket);
  },
  byId(id: string): StorageBucket | null {
    const row = db
      .query(`${STORAGE_BUCKET_SELECT} WHERE b.id = ? GROUP BY b.id`)
      .get(id) as StorageBucketRow | null;
    return row ? rowToStorageBucket(row) : null;
  },
  byName(name: string): StorageBucket | null {
    const row = db
      .query(`${STORAGE_BUCKET_SELECT} WHERE b.name = ? GROUP BY b.id`)
      .get(name) as StorageBucketRow | null;
    return row ? rowToStorageBucket(row) : null;
  },
  insert(bucket: {
    id: string;
    name: string;
    public: boolean;
    ownerUserId: string;
  }): void {
    const now = Date.now();
    db.query(
      "INSERT INTO storage_buckets(id, name, public, owner_user_id, created_at, updated_at) VALUES(?, ?, ?, ?, ?, ?)",
    ).run(bucket.id, bucket.name, bucket.public ? 1 : 0, bucket.ownerUserId, now, now);
  },
  touch(id: string): void {
    db.query("UPDATE storage_buckets SET updated_at = ? WHERE id = ?").run(Date.now(), id);
  },
  delete(id: string): void {
    db.query("DELETE FROM storage_buckets WHERE id = ?").run(id);
  },
};

export const storageObjects = {
  list(bucketId: string): StorageObject[] {
    const rows = db
      .query("SELECT * FROM storage_objects WHERE bucket_id = ? ORDER BY updated_at DESC, name ASC")
      .all(bucketId) as StorageObjectRow[];
    return rows.map((row) => {
      const { relativePath: _strip, ...object } = rowToStorageObject(row);
      void _strip;
      return object;
    });
  },
  byId(id: string): (StorageObject & { relativePath: string }) | null {
    const row = db.query("SELECT * FROM storage_objects WHERE id = ?").get(id) as StorageObjectRow | null;
    return row ? rowToStorageObject(row) : null;
  },
  byBucketAndName(bucketId: string, name: string): (StorageObject & { relativePath: string }) | null {
    const row = db
      .query("SELECT * FROM storage_objects WHERE bucket_id = ? AND name = ?")
      .get(bucketId, name) as StorageObjectRow | null;
    return row ? rowToStorageObject(row) : null;
  },
  insert(object: {
    id: string;
    bucketId: string;
    name: string;
    relativePath: string;
    mimeType: string | null;
    sizeBytes: number;
  }): void {
    const now = Date.now();
    db.query(
      `INSERT INTO storage_objects(id, bucket_id, name, relative_path, mime_type, size_bytes, created_at, updated_at)
       VALUES(?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      object.id,
      object.bucketId,
      object.name,
      object.relativePath,
      object.mimeType,
      object.sizeBytes,
      now,
      now,
    );
    storageBuckets.touch(object.bucketId);
  },
  updateFile(
    id: string,
    patch: {
      mimeType: string | null;
      sizeBytes: number;
    },
  ): void {
    db.query(
      "UPDATE storage_objects SET mime_type = ?, size_bytes = ?, updated_at = ? WHERE id = ?",
    ).run(patch.mimeType, patch.sizeBytes, Date.now(), id);
    const row = this.byId(id);
    if (row) storageBuckets.touch(row.bucketId);
  },
  delete(id: string): void {
    const row = this.byId(id);
    db.query("DELETE FROM storage_objects WHERE id = ?").run(id);
    if (row) storageBuckets.touch(row.bucketId);
  },
};

// ---------- data api policies ----------

export const dataApiPolicies = {
  list(databaseId: string): DataApiPolicy[] {
    const rows = db
      .query("SELECT * FROM data_api_policies WHERE database_id = ? ORDER BY table_name ASC")
      .all(databaseId) as DataApiPolicyRow[];
    return rows.map(rowToDataApiPolicy);
  },
  byTable(databaseId: string, tableName: string): DataApiPolicy | null {
    const row = db
      .query("SELECT * FROM data_api_policies WHERE database_id = ? AND table_name = ?")
      .get(databaseId, tableName) as DataApiPolicyRow | null;
    return row ? rowToDataApiPolicy(row) : null;
  },
  upsert(input: {
    databaseId: string;
    tableName: string;
    selectEnabled: boolean;
    insertEnabled: boolean;
    updateEnabled: boolean;
    deleteEnabled: boolean;
    ownerColumn: string | null;
  }): void {
    const now = Date.now();
    db.query(
      `INSERT INTO data_api_policies(
        database_id, table_name, select_enabled, insert_enabled, update_enabled,
        delete_enabled, owner_column, created_at, updated_at
       ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(database_id, table_name) DO UPDATE SET
        select_enabled = excluded.select_enabled,
        insert_enabled = excluded.insert_enabled,
        update_enabled = excluded.update_enabled,
        delete_enabled = excluded.delete_enabled,
        owner_column = excluded.owner_column,
        updated_at = excluded.updated_at`,
    ).run(
      input.databaseId,
      input.tableName,
      input.selectEnabled ? 1 : 0,
      input.insertEnabled ? 1 : 0,
      input.updateEnabled ? 1 : 0,
      input.deleteEnabled ? 1 : 0,
      input.ownerColumn,
      now,
      now,
    );
  },
  delete(databaseId: string, tableName: string): void {
    db.query("DELETE FROM data_api_policies WHERE database_id = ? AND table_name = ?").run(
      databaseId,
      tableName,
    );
  },
};

// ---------- functions ----------

export const edgeFunctions = {
  listSettings(): Array<{
    name: string;
    verifyJwt: boolean;
    createdByUserId: string | null;
    createdAt: number;
    updatedAt: number;
  }> {
    const rows = db.query("SELECT * FROM functions ORDER BY name ASC").all() as FunctionRow[];
    return rows.map((r) => ({
      name: r.name,
      verifyJwt: r.verify_jwt === 1,
      createdByUserId: r.created_by_user_id,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    }));
  },
  byName(name: string): {
    name: string;
    verifyJwt: boolean;
    createdByUserId: string | null;
    createdAt: number;
    updatedAt: number;
  } | null {
    const row = db.query("SELECT * FROM functions WHERE name = ?").get(name) as FunctionRow | null;
    return row
      ? {
          name: row.name,
          verifyJwt: row.verify_jwt === 1,
          createdByUserId: row.created_by_user_id,
          createdAt: row.created_at,
          updatedAt: row.updated_at,
        }
      : null;
  },
  upsert(input: { name: string; verifyJwt: boolean; createdByUserId: string | null }): void {
    const now = Date.now();
    db.query(
      `INSERT INTO functions(name, verify_jwt, created_by_user_id, created_at, updated_at)
       VALUES(?, ?, ?, ?, ?)
       ON CONFLICT(name) DO UPDATE SET
        verify_jwt = excluded.verify_jwt,
        updated_at = excluded.updated_at`,
    ).run(input.name, input.verifyJwt ? 1 : 0, input.createdByUserId, now, now);
  },
  update(name: string, patch: { verifyJwt?: boolean }): void {
    const sets: string[] = [];
    const values: unknown[] = [];
    if (patch.verifyJwt !== undefined) {
      sets.push("verify_jwt = ?");
      values.push(patch.verifyJwt ? 1 : 0);
    }
    if (sets.length === 0) return;
    sets.push("updated_at = ?");
    values.push(Date.now(), name);
    db.query(`UPDATE functions SET ${sets.join(", ")} WHERE name = ?`).run(...(values as never[]));
  },
  delete(name: string): void {
    db.query("DELETE FROM functions WHERE name = ?").run(name);
  },
};

export const functionSecrets = {
  list(): EdgeFunctionSecret[] {
    const rows = db.query("SELECT * FROM function_secrets ORDER BY name ASC").all() as FunctionSecretRow[];
    return rows.map(rowToFunctionSecret);
  },
  values(): Record<string, string> {
    const rows = db.query("SELECT * FROM function_secrets ORDER BY name ASC").all() as FunctionSecretRow[];
    return Object.fromEntries(rows.map((r) => [r.name, r.value_enc]));
  },
  upsert(secret: { name: string; valueEnc: string }): void {
    const now = Date.now();
    db.query(
      `INSERT INTO function_secrets(name, value_enc, created_at, updated_at)
       VALUES(?, ?, ?, ?)
       ON CONFLICT(name) DO UPDATE SET
        value_enc = excluded.value_enc,
        updated_at = excluded.updated_at`,
    ).run(secret.name, secret.valueEnc, now, now);
  },
  delete(name: string): void {
    db.query("DELETE FROM function_secrets WHERE name = ?").run(name);
  },
};

export const functionInvocations = {
  list(functionName: string, limit = 50): EdgeFunctionInvocation[] {
    const rows = db
      .query(
        `SELECT * FROM function_invocations
         WHERE function_name = ?
         ORDER BY created_at DESC
         LIMIT ?`,
      )
      .all(functionName, limit) as FunctionInvocationRow[];
    return rows.map(rowToFunctionInvocation);
  },
  stats(functionName: string): {
    invocationCount: number;
    lastInvokedAt: number | null;
    lastStatusCode: number | null;
    lastDurationMs: number | null;
  } {
    const countRow = db
      .query("SELECT COUNT(*) AS n FROM function_invocations WHERE function_name = ?")
      .get(functionName) as { n: number } | null;
    const last = db
      .query(
        `SELECT status_code, duration_ms, created_at
         FROM function_invocations
         WHERE function_name = ?
         ORDER BY created_at DESC
         LIMIT 1`,
      )
      .get(functionName) as
      | { status_code: number | null; duration_ms: number; created_at: number }
      | null;
    return {
      invocationCount: Number(countRow?.n ?? 0),
      lastInvokedAt: last?.created_at ?? null,
      lastStatusCode: last?.status_code ?? null,
      lastDurationMs: last?.duration_ms ?? null,
    };
  },
  countSince(sinceMs: number): number {
    const r = db
      .query("SELECT COUNT(*) AS n FROM function_invocations WHERE created_at >= ?")
      .get(sinceMs) as { n: number } | null;
    return Number(r?.n ?? 0);
  },
  insert(input: {
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
  }): void {
    db.query(
      `INSERT INTO function_invocations(
        id, function_name, method, path, status_code, duration_ms,
        request_bytes, response_bytes, error, logs, invoked_by_app_user_id, created_at
       ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      input.id,
      input.functionName,
      input.method,
      input.path,
      input.statusCode,
      input.durationMs,
      input.requestBytes,
      input.responseBytes,
      input.error,
      input.logs,
      input.invokedByAppUserId,
      Date.now(),
    );
  },
  deleteForFunction(functionName: string): void {
    db.query("DELETE FROM function_invocations WHERE function_name = ?").run(functionName);
  },
};

// ---------- metrics ----------

export const metrics = {
  insert(
    databaseId: string,
    m: {
      sizeBytes: number | null;
      tableCount: number | null;
      connectionCount: number | null;
      rowCount: number | null;
    },
  ): void {
    db.query(
      "INSERT INTO metrics(database_id, collected_at, size_bytes, table_count, connection_count, row_count) VALUES(?, ?, ?, ?, ?, ?)",
    ).run(databaseId, Date.now(), m.sizeBytes, m.tableCount, m.connectionCount, m.rowCount);
  },
  range(databaseId: string, sinceMs: number, bucketMs?: number): {
    collectedAt: number;
    sizeBytes: number | null;
    tableCount: number | null;
    connectionCount: number | null;
    rowCount: number | null;
  }[] {
    const query =
      bucketMs && bucketMs > 1
        ? db
            .query(
              "SELECT MAX(collected_at) as collected_at, size_bytes, table_count, connection_count, row_count FROM metrics WHERE database_id = ? AND collected_at >= ? GROUP BY collected_at / ? ORDER BY collected_at ASC",
            )
            .all(databaseId, sinceMs, bucketMs)
        : db
            .query(
              "SELECT collected_at, size_bytes, table_count, connection_count, row_count FROM metrics WHERE database_id = ? AND collected_at >= ? ORDER BY collected_at ASC",
            )
            .all(databaseId, sinceMs);
    const rows = query as {
      collected_at: number;
      size_bytes: number | null;
      table_count: number | null;
      connection_count: number | null;
      row_count: number | null;
    }[];
    return rows.map((r) => ({
      collectedAt: r.collected_at,
      sizeBytes: r.size_bytes,
      tableCount: r.table_count,
      connectionCount: r.connection_count,
      rowCount: r.row_count,
    }));
  },
  prune(olderThanMs: number): void {
    db.query("DELETE FROM metrics WHERE collected_at < ?").run(olderThanMs);
  },
  latestFor(databaseId: string): {
    collectedAt: number;
    sizeBytes: number | null;
    tableCount: number | null;
    connectionCount: number | null;
    rowCount: number | null;
  } | null {
    const r = db
      .query(
        "SELECT collected_at, size_bytes, table_count, connection_count, row_count FROM metrics WHERE database_id = ? ORDER BY collected_at DESC LIMIT 1",
      )
      .get(databaseId) as {
      collected_at: number;
      size_bytes: number | null;
      table_count: number | null;
      connection_count: number | null;
      row_count: number | null;
    } | null;
    if (!r) return null;
    return {
      collectedAt: r.collected_at,
      sizeBytes: r.size_bytes,
      tableCount: r.table_count,
      connectionCount: r.connection_count,
      rowCount: r.row_count,
    };
  },
};

// ---------- audit_log ----------

export const audit = {
  log(userId: string | null, action: string, target: string | null, details: unknown): void {
    db.query(
      "INSERT INTO audit_log(user_id, action, target, details, at) VALUES(?, ?, ?, ?, ?)",
    ).run(
      userId,
      action,
      target,
      details === undefined ? null : JSON.stringify(details),
      Date.now(),
    );
  },
  list(limit = 20): AuditLogEntry[] {
    return db.query(
      `SELECT a.*, u.email as user_email, u.display_name as user_display_name
       FROM audit_log a
       LEFT JOIN users u ON a.user_id = u.id
       ORDER BY a.at DESC
       LIMIT ?`
    ).all(limit) as AuditLogEntry[];
  },
};
