import { mkdir, open, readdir, rename, rm, stat, unlink, type FileHandle } from "node:fs/promises";
import { dirname, join, posix } from "node:path";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import type { StorageBucket, StorageObject, User } from "@lambdata/shared";
import { audit, storageBuckets, storageObjects } from "../db/queries";
import { requireAuth, type AuthVariables } from "../auth/middleware";
import { assertDiskRoom, formatBytes } from "../util/disk";
import { newId } from "../util/id";
import { parseJson } from "../util/validate";
import { env } from "../env";

export const MAX_UPLOAD_BYTES = 250 * 1024 * 1024;
export const MAX_MULTIPART_OVERHEAD_BYTES = 1024 * 1024;
export const DISK_CHECK_EVERY_BYTES = 16 * 1024 * 1024;
export const STORE_ACTION = "store this file";
const MAX_PART_HEADER_BYTES = 16 * 1024;
const MAX_FIELD_BYTES = 64 * 1024;
const UPLOADS_DIR = ".uploads";
const STALE_UPLOAD_MS = 24 * 60 * 60 * 1000;
const CRLF = Buffer.from("\r\n");
const HEADER_END = Buffer.from("\r\n\r\n");

export const INLINE_SAFE_TYPES: ReadonlySet<string> = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/avif",
  "image/bmp",
  "image/x-icon",
  "image/vnd.microsoft.icon",
  "text/plain",
]);
export const OBJECT_CSP = "default-src 'none'; style-src 'unsafe-inline'; sandbox";

const bucketSchema = z.object({
  name: z.string().max(200),
  public: z.boolean().optional(),
});

export const storageRoute = new Hono<{ Variables: AuthVariables }>();

storageRoute.get("/public/:bucketName/:objectName{.+}", async (c) => {
  const bucketName = c.req.param("bucketName");
  const bucket = storageBuckets.byName(bucketName);
  if (!bucket?.public) throw new HTTPException(404, { message: "not found" });

  const objectName = normalizeObjectName(c.req.param("objectName") ?? "");
  const object = storageObjects.byBucketAndName(bucket.id, objectName);
  if (!object) throw new HTTPException(404, { message: "not found" });

  return objectResponse(bucket, object, { isPublic: true, inline: c.req.query("download") !== "1" });
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
  const body = await parseJson(c, bucketSchema);
  const name = normalizeBucketName(body.name);
  const isPublic = body.public === true;
  if (storageBuckets.byName(name)) {
    throw new HTTPException(409, { message: "bucket name already exists" });
  }

  const id = newId("bucket");
  storageBuckets.insert({ id, name, public: isPublic, ownerUserId: user.id });
  await mkdir(join(env.storageDir, id), { recursive: true, mode: 0o700 });
  audit.log(user.id, "storage.bucket.create", id, { name, public: isPublic });

  return c.json({ bucket: storageBuckets.byId(id) });
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

  const declared = declaredLength(c.req.header("content-length"));
  if (declared !== null && declared > MAX_UPLOAD_BYTES + MAX_MULTIPART_OVERHEAD_BYTES) throw tooLarge();
  const body = c.req.raw.body;
  if (!body) throw new HTTPException(400, { message: "file field required" });
  const boundary = multipartBoundary(c.req.header("content-type"));
  assertDiskRoom(STORE_ACTION, declared ?? 0);
  const uploadsDir = join(env.storageDir, UPLOADS_DIR);
  sweepStaleUploads(uploadsDir).catch(() => {});
  const upload = await receiveMultipart(body, boundary, uploadsDir);

  let stored = false;
  try {
    const file = upload.file;
    if (!file) throw new HTTPException(400, { message: "file field required" });
    const objectName = normalizeObjectName(upload.fields.get("name") || file.fileName);
    const upsert = c.req.query("upsert") === "1";
    const existing = storageObjects.byBucketAndName(bucket.id, objectName);
    if (existing && !upsert) {
      throw new HTTPException(409, { message: "object already exists" });
    }

    const objectId = existing?.id ?? newId("obj");
    const relativePath = existing?.relativePath ?? `${bucket.id}/${objectId}`;
    const destination = join(env.storageDir, relativePath);
    await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
    await rename(file.tempPath, destination);
    stored = true;

    if (existing) {
      storageObjects.updateFile(existing.id, { mimeType: file.mimeType, sizeBytes: file.sizeBytes });
      audit.log(user.id, "storage.object.upsert", existing.id, {
        bucket: bucket.name,
        name: objectName,
        sizeBytes: file.sizeBytes,
      });
      return c.json({ object: stripObject(storageObjects.byId(existing.id)!) });
    }

    storageObjects.insert({
      id: objectId,
      bucketId: bucket.id,
      name: objectName,
      relativePath,
      mimeType: file.mimeType,
      sizeBytes: file.sizeBytes,
    });
    audit.log(user.id, "storage.object.create", objectId, {
      bucket: bucket.name,
      name: objectName,
      sizeBytes: file.sizeBytes,
    });
    return c.json({ object: stripObject(storageObjects.byId(objectId)!) });
  } finally {
    if (upload.file && !stored) await unlink(upload.file.tempPath).catch(() => undefined);
  }
});

storageRoute.get("/buckets/:bucketId/objects/:objectId/download", async (c) => {
  const user = c.get("user");
  const bucket = requireBucket(c.req.param("bucketId"));
  assertCanReadBucket(user, bucket);

  const object = requireObject(bucket.id, c.req.param("objectId"));
  return objectResponse(bucket, object, { isPublic: false, inline: c.req.query("inline") === "1" });
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
  if (/[\u0000-\u001f\u007f]/.test(raw)) {
    throw new HTTPException(400, { message: "object name must not contain control characters" });
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

export function mimeEssence(value: string | null | undefined): string | null {
  const essence = value?.split(";")[0]?.trim().toLowerCase();
  if (!essence) return null;
  return /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/.test(essence) ? essence : null;
}

function encodeRfc5987(value: string): string {
  const wellFormed = value.replace(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g, "�");
  return encodeURIComponent(wellFormed).replace(
    /['()*]/g,
    (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

export function contentDisposition(kind: "inline" | "attachment", fileName: string): string {
  const fallback = fileName.replace(/[^\x20-\x7e]|["\\%]/gu, "_");
  return `${kind}; filename="${fallback}"; filename*=UTF-8''${encodeRfc5987(fileName)}`;
}

function objectResponse(
  bucket: StorageBucket,
  object: StorageObject & { relativePath: string },
  opts: { isPublic: boolean; inline: boolean },
): Response {
  const file = Bun.file(join(env.storageDir, object.relativePath));
  const type = mimeEssence(object.mimeType);
  const inline = opts.inline && type !== null && INLINE_SAFE_TYPES.has(type);
  const contentType = inline && type === "text/plain"
    ? "text/plain; charset=utf-8"
    : (type ?? "application/octet-stream");
  const fileName = object.name.split("/").pop() || object.id;
  return new Response(file, {
    headers: {
      "Content-Type": contentType,
      "Content-Length": String(object.sizeBytes),
      "Content-Disposition": contentDisposition(inline ? "inline" : "attachment", fileName),
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": OBJECT_CSP,
      "Cache-Control": opts.isPublic && bucket.public ? "public, max-age=300" : "private, max-age=60",
    },
  });
}

type ReceivedFile = { tempPath: string; fileName: string; mimeType: string | null; sizeBytes: number };
type ReceivedUpload = { file: ReceivedFile | null; fields: Map<string, string> };
type PartHeaders = { name: string | null; fileName: string | null; contentType: string | null };

function multipartBoundary(contentType: string | undefined): string {
  const [type, ...params] = (contentType ?? "").split(";");
  if (type?.trim().toLowerCase() === "multipart/form-data") {
    for (const param of params) {
      const eq = param.indexOf("=");
      if (eq < 0 || param.slice(0, eq).trim().toLowerCase() !== "boundary") continue;
      const value = param.slice(eq + 1).trim().replace(/^"(.*)"$/, "$1");
      if (value.length >= 1 && value.length <= 70) return value;
    }
  }
  throw new HTTPException(400, { message: "upload must be multipart/form-data with a file field" });
}

function headerParam(header: string, key: string): string | null {
  const match = new RegExp(`(?:^|;)\\s*${key}\\s*=\\s*(?:"([^"]*)"|([^;]*))`, "i").exec(header);
  if (!match) return null;
  return match[1] ?? (match[2] ?? "").trim();
}

function parsePartHeaders(raw: string): PartHeaders {
  const result: PartHeaders = { name: null, fileName: null, contentType: null };
  for (const line of raw.split("\r\n")) {
    const colon = line.indexOf(":");
    if (colon < 0) continue;
    const key = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    if (key === "content-type") result.contentType = value;
    if (key !== "content-disposition") continue;
    result.name = headerParam(value, "name");
    const extended = headerParam(value, "filename\\*");
    const utf8 = extended ? /^utf-8''(.*)$/i.exec(extended) : null;
    if (utf8) {
      try {
        result.fileName = decodeURIComponent(utf8[1]!);
      } catch {
        result.fileName = null;
      }
    }
    result.fileName ??= headerParam(value, "filename");
  }
  return result;
}

function malformed(message = "upload ended before the multipart body was complete"): HTTPException {
  return new HTTPException(400, { message });
}

export function storageTooLargeMessage(): string {
  return `The file is larger than the ${formatBytes(MAX_UPLOAD_BYTES)} limit for files in Storage.`;
}

function tooLarge(): HTTPException {
  return new HTTPException(413, { message: storageTooLargeMessage() });
}

function declaredLength(header: string | undefined): number | null {
  return header !== undefined && /^\d+$/.test(header.trim()) ? Number(header.trim()) : null;
}

async function receiveMultipart(
  body: ReadableStream<Uint8Array>,
  boundary: string,
  tempDir: string,
): Promise<ReceivedUpload> {
  const delimiter = Buffer.from(`\r\n--${boundary}`);
  const keep = delimiter.length - 1;
  const reader = body.getReader();
  const fields = new Map<string, string>();
  let buffer = Buffer.from(CRLF);
  let received = 0;
  let ended = false;
  let file: ReceivedFile | null = null;
  let handle: FileHandle | null = null;

  const read = async () => {
    try {
      return await reader.read();
    } catch (err) {
      if (err instanceof Error && err.name === "BodyTooLargeError") throw tooLarge();
      throw malformed("the upload was interrupted before it finished");
    }
  };

  const more = async (): Promise<boolean> => {
    if (ended) return false;
    const { done, value } = await read();
    if (done) {
      ended = true;
      return false;
    }
    received += value.length;
    if (received > MAX_UPLOAD_BYTES + MAX_MULTIPART_OVERHEAD_BYTES) throw tooLarge();
    buffer = buffer.length > 0 ? Buffer.concat([buffer, value]) : Buffer.from(value);
    return true;
  };

  const skipTo = async (marker: Buffer, limit: number, onSkipped?: (chunk: Buffer) => Promise<void>) => {
    for (;;) {
      const index = buffer.indexOf(marker);
      if (index >= 0) {
        if (onSkipped && index > 0) await onSkipped(buffer.subarray(0, index));
        buffer = buffer.subarray(index + marker.length);
        return;
      }
      if (buffer.length > keep) {
        const cut = buffer.length - keep;
        if (onSkipped) await onSkipped(buffer.subarray(0, cut));
        buffer = buffer.subarray(cut);
      }
      if (buffer.length > limit) throw malformed("multipart part headers are too large");
      if (!(await more())) throw malformed();
    }
  };

  try {
    await skipTo(delimiter, Number.POSITIVE_INFINITY);
    for (;;) {
      while (buffer.length < 2) if (!(await more())) throw malformed();
      if (buffer[0] === 0x2d && buffer[1] === 0x2d) break;
      await skipTo(CRLF, MAX_PART_HEADER_BYTES);
      while (buffer.length < 2) if (!(await more())) throw malformed();

      let rawHeaders = "";
      if (buffer[0] === 0x0d && buffer[1] === 0x0a) {
        buffer = buffer.subarray(2);
      } else {
        for (;;) {
          const index = buffer.indexOf(HEADER_END);
          if (index >= 0) {
            rawHeaders = buffer.subarray(0, index).toString("utf8");
            buffer = buffer.subarray(index + HEADER_END.length);
            break;
          }
          if (buffer.length > MAX_PART_HEADER_BYTES) throw malformed("multipart part headers are too large");
          if (!(await more())) throw malformed();
        }
      }

      const part = parsePartHeaders(rawHeaders);
      if (part.name === "file" && part.fileName !== null) {
        if (file) throw new HTTPException(400, { message: "send one file per upload" });
        await mkdir(tempDir, { recursive: true, mode: 0o700 });
        const tempPath = join(tempDir, newId("upload"));
        handle = await open(tempPath, "wx", 0o600);
        const current: ReceivedFile = {
          tempPath,
          fileName: part.fileName,
          mimeType: mimeEssence(part.contentType),
          sizeBytes: 0,
        };
        file = current;
        const sink = handle;
        let nextDiskCheck = DISK_CHECK_EVERY_BYTES;
        await skipTo(delimiter, Number.POSITIVE_INFINITY, async (chunk) => {
          current.sizeBytes += chunk.length;
          if (current.sizeBytes > MAX_UPLOAD_BYTES) throw tooLarge();
          if (current.sizeBytes >= nextDiskCheck) {
            assertDiskRoom(STORE_ACTION);
            nextDiskCheck = current.sizeBytes + DISK_CHECK_EVERY_BYTES;
          }
          await sink.write(chunk);
        });
        await sink.close();
        handle = null;
      } else if (part.name !== null && part.fileName === null) {
        const pieces: Buffer[] = [];
        let size = 0;
        await skipTo(delimiter, Number.POSITIVE_INFINITY, async (chunk) => {
          size += chunk.length;
          if (size > MAX_FIELD_BYTES) throw malformed(`form field ${part.name} is too large`);
          pieces.push(Buffer.from(chunk));
        });
        if (!fields.has(part.name)) fields.set(part.name, Buffer.concat(pieces).toString("utf8"));
      } else {
        await skipTo(delimiter, Number.POSITIVE_INFINITY, async () => {});
      }
    }
    await reader.cancel().catch(() => undefined);
    return { file, fields };
  } catch (err) {
    await handle?.close().catch(() => undefined);
    if (file) await unlink(file.tempPath).catch(() => undefined);
    await reader.cancel().catch(() => undefined);
    throw err;
  }
}

async function sweepStaleUploads(dir: string): Promise<void> {
  const entries = await readdir(dir).catch(() => [] as string[]);
  const cutoff = Date.now() - STALE_UPLOAD_MS;
  for (const name of entries) {
    const path = join(dir, name);
    const info = await stat(path).catch(() => null);
    if (info?.isFile() && info.mtimeMs < cutoff) await unlink(path).catch(() => undefined);
  }
}
