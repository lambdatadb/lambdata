import type { StorageBucket, StorageObject } from "@lambdata/shared";
import { db } from "../client";

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
