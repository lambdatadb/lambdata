import { existsSync, mkdirSync } from "node:fs";
import { open, readdir, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { HTTPException } from "hono/http-exception";
import type { User } from "@lambdata/shared";
import { db } from "../db/client";
import { imports } from "../db/queries";
import type { StoredUpload } from "../db/queries/imports";
import { env } from "../env";
import { assertDiskRoom, envBytes, envCount, formatBytes } from "../util/disk";
import { newId } from "../util/id";
import { SNIFF_BYTES, UnsupportedFileError, detectFormat } from "./detect";
import { openSqliteReadOnly } from "./sqliteFile";

export const UPLOAD_TTL_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_MAX_IMPORT_BYTES = 2 * 1024 * 1024 * 1024;
export const DEFAULT_MAX_PENDING_UPLOADS = 5;
export const DISK_CHECK_EVERY_BYTES = 16 * 1024 * 1024;
const UPLOAD_ID = /^upl_[0-9a-f]{32}$/;
const MAX_FILE_NAME = 255;
const HOUR_MS = 60 * 60 * 1000;

const inFlight = new Map<string, { userId: string; bytes: number }>();
const inUse = new Map<string, number>();

export function maxImportBytes(): number {
  const n = envBytes("IMPORT_MAX_BYTES");
  return n !== null && n > 0 ? n : DEFAULT_MAX_IMPORT_BYTES;
}

export interface PendingUploadLimits {
  maxCount: number;
  maxBytes: number;
}

export function pendingUploadLimits(): PendingUploadLimits {
  const bytes = envBytes("IMPORT_MAX_PENDING_BYTES");
  return {
    maxCount: envCount("IMPORT_MAX_PENDING_UPLOADS") ?? DEFAULT_MAX_PENDING_UPLOADS,
    maxBytes: bytes !== null && bytes > 0 ? bytes : 2 * maxImportBytes(),
  };
}

export interface PendingUploads {
  count: number;
  bytes: number;
  nextExpiryAt: number | null;
}

export function pendingUploadsFor(userId: string, now: number = Date.now(), exceptId?: string): PendingUploads {
  const row = db
    .query(
      "SELECT COUNT(*) AS n, COALESCE(SUM(size_bytes), 0) AS bytes, MIN(expires_at) AS next FROM import_uploads WHERE user_id = ? AND expires_at > ?",
    )
    .get(userId, now) as { n: number; bytes: number; next: number | null } | null;
  let count = Number(row?.n ?? 0);
  let bytes = Number(row?.bytes ?? 0);
  for (const [id, entry] of inFlight) {
    if (entry.userId !== userId || id === exceptId) continue;
    count++;
    bytes += entry.bytes;
  }
  return { count, bytes, nextExpiryAt: row?.next === null || row?.next === undefined ? null : Number(row.next) };
}

function uploadsPhrase(n: number): string {
  return n === 1 ? "1 upload" : `${n} uploads`;
}

function expiryHint(pending: PendingUploads, now: number): string {
  if (pending.nextExpiryAt === null) return "Wait for the uploads in progress to finish, then import or delete one.";
  const hours = Math.max(1, Math.ceil((pending.nextExpiryAt - now) / HOUR_MS));
  return `Import or delete one you no longer need, or wait: the oldest is removed automatically in about ${hours === 1 ? "an hour" : `${hours} hours`}.`;
}

function pendingRefusal(message: string): HTTPException {
  return new HTTPException(429, { message });
}

export function assertPendingRoom(
  user: Pick<User, "id" | "role">,
  incomingBytes: number,
  opts: { bytesOnly?: boolean; now?: number; exceptId?: string } = {},
): void {
  if (user.role === "admin") return;
  const now = opts.now ?? Date.now();
  const limits = pendingUploadLimits();
  const pending = pendingUploadsFor(user.id, now, opts.exceptId);
  if (!opts.bytesOnly && pending.count >= limits.maxCount) {
    throw pendingRefusal(
      `You already have ${uploadsPhrase(pending.count)} waiting to be imported (${formatBytes(pending.bytes)} in all), the most one person can have at a time. ${expiryHint(pending, now)}`,
    );
  }
  if (pending.bytes + incomingBytes > limits.maxBytes) {
    const what = opts.bytesOnly
      ? "This upload would bring"
      : incomingBytes > 0
        ? `This ${formatBytes(incomingBytes)} file would bring`
        : "Another upload would bring";
    throw pendingRefusal(
      `${what} your uploads waiting to be imported to more than ${formatBytes(limits.maxBytes)}, the most one person can have at a time (you have ${formatBytes(pending.bytes)} in ${uploadsPhrase(pending.count)}). ${expiryHint(pending, now)}`,
    );
  }
}

export function importTooLargeMessage(max: number = maxImportBytes()): string {
  return `The file is larger than the ${formatBytes(max)} import limit. A SQL dump can be uploaded gzip-compressed (.sql.gz); otherwise ask an admin to raise LAMBDATA_IMPORT_MAX_BYTES.`;
}

export function isUploadId(id: string): boolean {
  return UPLOAD_ID.test(id);
}

export function uploadPath(id: string): string {
  if (!isUploadId(id)) throw new Error("invalid upload id");
  return join(env.importsDir, id);
}

export function planCachePath(id: string): string {
  return `${uploadPath(id)}.plan.json`;
}

function partPath(id: string): string {
  return `${uploadPath(id)}.part`;
}

export function cleanFileName(raw: string | undefined): string {
  if (raw === undefined || raw.trim() === "") {
    throw new HTTPException(400, { message: "X-File-Name header required (URI-encoded file name)" });
  }
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    throw new HTTPException(400, { message: "X-File-Name must be URI-encoded" });
  }
  const base = decoded.split(/[\\/]/).pop() ?? "";
  const cleaned = base.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  if (!cleaned) throw new HTTPException(400, { message: "X-File-Name is empty" });
  return [...cleaned].slice(0, MAX_FILE_NAME).join("");
}

async function writeAll(fh: Awaited<ReturnType<typeof open>>, chunk: Uint8Array): Promise<void> {
  let offset = 0;
  while (offset < chunk.byteLength) {
    const { bytesWritten } = await fh.write(chunk, offset, chunk.byteLength - offset);
    if (bytesWritten <= 0) throw new Error("could not write the upload to disk");
    offset += bytesWritten;
  }
}

function validateSqlite(path: string): void {
  try {
    const db = openSqliteReadOnly(path);
    try {
      db.query("SELECT count(*) FROM sqlite_master").get();
    } finally {
      db.close();
    }
  } catch (err) {
    throw new UnsupportedFileError(
      `This file starts like a SQLite database but SQLite cannot read it (${err instanceof Error ? err.message : String(err)}). It may be damaged, truncated or encrypted`,
      422,
    );
  }
}

const ACCEPT_ACTION = "accept this upload";
export const IMPORT_ACTION = "import this file";

export async function receiveUpload(p: {
  body: ReadableStream<Uint8Array> | null;
  fileName: string;
  userId: string;
  role: User["role"];
  declaredLength: number | null;
}): Promise<StoredUpload> {
  const max = maxImportBytes();
  const tooLarge = () => new HTTPException(413, { message: importTooLargeMessage(max) });
  if (p.declaredLength !== null && p.declaredLength > max) throw tooLarge();
  if (!p.body) throw new HTTPException(400, { message: "The uploaded file is empty" });
  const user = { id: p.userId, role: p.role };
  assertPendingRoom(user, p.declaredLength ?? 0);
  assertDiskRoom(ACCEPT_ACTION, p.declaredLength ?? 0);
  if (!existsSync(env.importsDir)) mkdirSync(env.importsDir, { recursive: true, mode: 0o700 });
  const id = newId("upl");
  const tracked = { userId: p.userId, bytes: 0 };
  inFlight.set(id, tracked);
  const part = partPath(id);
  const hasher = new Bun.CryptoHasher("sha256");
  const head = new Uint8Array(SNIFF_BYTES);
  let headLength = 0;
  let size = 0;
  let nextCheck = DISK_CHECK_EVERY_BYTES;
  const reader = p.body.getReader();
  let fh: Awaited<ReturnType<typeof open>> | null = null;
  try {
    fh = await open(part, "wx", 0o600);
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || value.byteLength === 0) continue;
      size += value.byteLength;
      if (size > max) throw tooLarge();
      tracked.bytes = size;
      if (size >= nextCheck) {
        assertPendingRoom(user, size, { bytesOnly: true, exceptId: id });
        assertDiskRoom(ACCEPT_ACTION);
        nextCheck = size + DISK_CHECK_EVERY_BYTES;
      }
      hasher.update(value);
      if (headLength < SNIFF_BYTES) {
        const take = value.subarray(0, SNIFF_BYTES - headLength);
        head.set(take, headLength);
        headLength += take.byteLength;
      }
      await writeAll(fh, value);
    }
    await fh.close();
    fh = null;
    if (size === 0) throw new HTTPException(400, { message: "The uploaded file is empty" });
    assertPendingRoom(user, size, { bytesOnly: true, exceptId: id });
    const detected = await detectFormat(head.subarray(0, headLength), part);
    if (detected.format === "sqlite") validateSqlite(part);
    await rename(part, uploadPath(id));
    const now = Date.now();
    const upload: StoredUpload = {
      id,
      userId: p.userId,
      fileName: p.fileName,
      sizeBytes: size,
      sha256: hasher.digest("hex"),
      format: detected.format,
      compressed: detected.compressed,
      createdAt: now,
      expiresAt: now + UPLOAD_TTL_MS,
    };
    imports.insertUpload(upload);
    return upload;
  } catch (err) {
    await reader.cancel().catch(() => {});
    if (fh) await fh.close().catch(() => {});
    await rm(part, { force: true }).catch(() => {});
    await rm(uploadPath(id), { force: true }).catch(() => {});
    if (err instanceof UnsupportedFileError) throw new HTTPException(err.status, { message: err.message });
    throw err;
  } finally {
    inFlight.delete(id);
  }
}

export function canUseUpload(user: Pick<User, "id" | "role">, upload: StoredUpload): boolean {
  return user.role === "admin" || upload.userId === user.id;
}

export function requireUpload(user: Pick<User, "id" | "role">, id: string): StoredUpload {
  const upload = isUploadId(id) ? imports.uploadById(id) : null;
  if (!upload || !canUseUpload(user, upload) || upload.expiresAt <= Date.now()) {
    throw new HTTPException(404, { message: "upload not found or expired" });
  }
  if (!existsSync(uploadPath(upload.id))) {
    throw new HTTPException(410, { message: "the uploaded file is gone; upload it again" });
  }
  return upload;
}

export function markUploadInUse(id: string): () => void {
  inUse.set(id, (inUse.get(id) ?? 0) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const left = (inUse.get(id) ?? 1) - 1;
    if (left > 0) inUse.set(id, left);
    else inUse.delete(id);
  };
}

export function uploadInUse(id: string): boolean {
  return (inUse.get(id) ?? 0) > 0;
}

export async function deleteUpload(id: string): Promise<void> {
  imports.deleteUpload(id);
  await rm(uploadPath(id), { force: true });
  await rm(planCachePath(id), { force: true });
  await rm(partPath(id), { force: true });
}

const FILE_PATTERN = /^(upl_[0-9a-f]{32})(\.plan\.json|\.part)?$/;

export async function removeStaleUploads(now: number = Date.now()): Promise<string[]> {
  const removed: string[] = [];
  for (const u of imports.expiredUploads(now)) {
    if (uploadInUse(u.id)) continue;
    await deleteUpload(u.id);
    removed.push(u.id);
  }
  if (!existsSync(env.importsDir)) return removed;
  const known = imports.uploadIds();
  for (const name of await readdir(env.importsDir)) {
    const m = FILE_PATTERN.exec(name);
    if (!m) continue;
    const id = m[1]!;
    if (known.has(id) || inFlight.has(id) || uploadInUse(id)) continue;
    const path = join(env.importsDir, name);
    const info = await stat(path).catch(() => null);
    if (!info) continue;
    await rm(path, { force: true });
    if (!removed.includes(id)) removed.push(id);
  }
  return removed;
}
