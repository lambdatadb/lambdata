import { mkdir, rm, unlink, writeFile } from "node:fs/promises";
import { dirname, join, posix } from "node:path";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { StorageBucket, StorageObject, User } from "@kilndb/shared";
import { audit, storageBuckets, storageObjects } from "../db/queries";
import { requireAuth, type AuthVariables } from "../auth/middleware";
import { newId } from "../util/id";
import { env } from "../env";

const MAX_UPLOAD_BYTES = 250 * 1024 * 1024;

export const storageRoute = new Hono<{ Variables: AuthVariables }>();

storageRoute.get("/public/:bucketName/:objectName{.+}", async (c) => {
  const bucketName = c.req.param("bucketName");
  const bucket = storageBuckets.byName(bucketName);
  if (!bucket?.public) throw new HTTPException(404, { message: "not found" });

  const objectName = normalizeObjectName(c.req.param("objectName") ?? "");
  const object = storageObjects.byBucketAndName(bucket.id, objectName);
  if (!object) throw new HTTPException(404, { message: "not found" });

  return objectResponse(bucket, object, true);
});

storageRoute.use("*", requireAuth);

storageRoute.get("/buckets", (c) => {
  const user = c.get("user");
  const buckets = user.role === "db_owner"
    ? storageBuckets.listForUser(user.id)
    : storageBuckets.list();
  return c.json({ buckets });
});

storageRoute.post("/buckets", async (c) => {
  const user = c.get("user");
  if (user.role === "viewer") {
    throw new HTTPException(403, { message: "viewers cannot create storage buckets" });
  }
  const body = (await c.req.json()) as { name?: string; public?: boolean };
  const name = normalizeBucketName(body.name ?? "");
  if (storageBuckets.byName(name)) {
    throw new HTTPException(409, { message: "bucket name already exists" });
  }

  const id = newId("bucket");
  storageBuckets.insert({
    id,
    name,
    public: body.public === true,
    ownerUserId: user.id,
  });
  await mkdir(join(env.storageDir, id), { recursive: true, mode: 0o700 });
  audit.log(user.id, "storage.bucket.create", id, { name, public: body.public === true });

  const bucket = storageBuckets.byId(id);
  return c.json({ bucket });
});

storageRoute.delete("/buckets/:bucketId", async (c) => {
  const user = c.get("user");
  const bucket = requireBucket(c.req.param("bucketId"));
  assertCanWriteBucket(user, bucket);

  storageBuckets.delete(bucket.id);
  await rm(join(env.storageDir, bucket.id), { recursive: true, force: true });
  audit.log(user.id, "storage.bucket.delete", bucket.id, { name: bucket.name });
  return c.json({ ok: true });
});

storageRoute.get("/buckets/:bucketId/objects", (c) => {
  const user = c.get("user");
  const bucket = requireBucket(c.req.param("bucketId"));
  assertCanReadBucket(user, bucket);
  return c.json({ objects: storageObjects.list(bucket.id) });
});

storageRoute.post("/buckets/:bucketId/objects", async (c) => {
  const user = c.get("user");
  const bucket = requireBucket(c.req.param("bucketId"));
  assertCanWriteBucket(user, bucket);

  const form = await c.req.formData();
  const file = form.get("file");
  if (!(file instanceof File)) {
    throw new HTTPException(400, { message: "file field required" });
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    throw new HTTPException(413, { message: "file exceeds 250 MB limit" });
  }

  const requestedName = typeof form.get("name") === "string" ? String(form.get("name")) : file.name;
  const objectName = normalizeObjectName(requestedName || file.name);
  const upsert = c.req.query("upsert") === "1";
  const existing = storageObjects.byBucketAndName(bucket.id, objectName);
  if (existing && !upsert) {
    throw new HTTPException(409, { message: "object already exists" });
  }

  const objectId = existing?.id ?? newId("obj");
  const relativePath = existing?.relativePath ?? `${bucket.id}/${objectId}`;
  const destination = join(env.storageDir, relativePath);
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
  await writeFile(destination, Buffer.from(await file.arrayBuffer()));

  if (existing) {
    storageObjects.updateFile(existing.id, {
      mimeType: file.type || null,
      sizeBytes: file.size,
    });
    audit.log(user.id, "storage.object.upsert", existing.id, {
      bucket: bucket.name,
      name: objectName,
      sizeBytes: file.size,
    });
    return c.json({ object: stripObject(storageObjects.byId(existing.id)!) });
  }

  storageObjects.insert({
    id: objectId,
    bucketId: bucket.id,
    name: objectName,
    relativePath,
    mimeType: file.type || null,
    sizeBytes: file.size,
  });
  audit.log(user.id, "storage.object.create", objectId, {
    bucket: bucket.name,
    name: objectName,
    sizeBytes: file.size,
  });

  return c.json({ object: stripObject(storageObjects.byId(objectId)!) });
});

storageRoute.get("/buckets/:bucketId/objects/:objectId/download", async (c) => {
  const user = c.get("user");
  const bucket = requireBucket(c.req.param("bucketId"));
  assertCanReadBucket(user, bucket);

  const object = requireObject(bucket.id, c.req.param("objectId"));
  return objectResponse(bucket, object, false);
});

storageRoute.delete("/buckets/:bucketId/objects/:objectId", async (c) => {
  const user = c.get("user");
  const bucket = requireBucket(c.req.param("bucketId"));
  assertCanWriteBucket(user, bucket);

  const object = requireObject(bucket.id, c.req.param("objectId"));
  storageObjects.delete(object.id);
  await unlink(join(env.storageDir, object.relativePath)).catch(() => undefined);
  audit.log(user.id, "storage.object.delete", object.id, {
    bucket: bucket.name,
    name: object.name,
  });
  return c.json({ ok: true });
});

function requireBucket(bucketId: string): StorageBucket {
  const bucket = storageBuckets.byId(bucketId);
  if (!bucket) throw new HTTPException(404, { message: "bucket not found" });
  return bucket;
}

function requireObject(
  bucketId: string,
  objectId: string,
): StorageObject & { relativePath: string } {
  const object = storageObjects.byId(objectId);
  if (!object || object.bucketId !== bucketId) {
    throw new HTTPException(404, { message: "object not found" });
  }
  return object;
}

function assertCanReadBucket(user: User, bucket: StorageBucket): void {
  if (user.role === "db_owner" && bucket.ownerUserId !== user.id) {
    throw new HTTPException(403, { message: "not bucket owner" });
  }
}

function assertCanWriteBucket(user: User, bucket: StorageBucket): void {
  if (user.role === "viewer") {
    throw new HTTPException(403, { message: "read-only role" });
  }
  if (user.role === "db_owner" && bucket.ownerUserId !== user.id) {
    throw new HTTPException(403, { message: "not bucket owner" });
  }
}

function normalizeBucketName(input: string): string {
  const name = input.trim().toLowerCase();
  if (
    name.length < 3 ||
    name.length > 63 ||
    !/^[a-z0-9][a-z0-9_-]*[a-z0-9]$/.test(name)
  ) {
    throw new HTTPException(400, {
      message: "bucket name must be 3-63 lowercase letters, numbers, underscores, or hyphens",
    });
  }
  return name;
}

function normalizeObjectName(input: string): string {
  const raw = input.trim().replace(/\\/g, "/").replace(/^\/+/, "");
  if (!raw || raw.split("/").some((part) => part === "..")) {
    throw new HTTPException(400, { message: "object name must not be empty or traverse directories" });
  }
  const normalized = posix.normalize(raw);
  if (!normalized || normalized === "." || normalized.startsWith("../")) {
    throw new HTTPException(400, { message: "invalid object name" });
  }
  return normalized;
}

function stripObject(object: StorageObject & { relativePath: string }): StorageObject {
  const { relativePath: _strip, ...rest } = object;
  void _strip;
  return rest;
}

function objectResponse(
  bucket: StorageBucket,
  object: StorageObject & { relativePath: string },
  isPublic: boolean,
): Response {
  const file = Bun.file(join(env.storageDir, object.relativePath));
  const filename = object.name.split("/").pop()?.replace(/["\\]/g, "") || object.id;
  return new Response(file, {
    headers: {
      "Content-Type": object.mimeType ?? "application/octet-stream",
      "Content-Length": String(object.sizeBytes),
      "Content-Disposition": `inline; filename="${filename}"`,
      "Cache-Control": isPublic && bucket.public ? "public, max-age=300" : "private, max-age=60",
    },
  });
}
