import { createReadStream, createWriteStream, existsSync, fsyncSync, closeSync, openSync } from "node:fs";
import { mkdir, readdir, rename, rm, stat, unlink } from "node:fs/promises";
import { once } from "node:events";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { createGunzip, createGzip } from "node:zlib";
import { checkpoints } from "../db/queries/checkpoints";
import { env } from "../env";
import { randAlphaNum } from "../util/id";

export interface ChunkWriter<T> {
  write(bytes: Uint8Array): Promise<void>;
  finish(): Promise<T>;
  abort(): Promise<void>;
}

export interface StoredObject {
  hash: string;
  logicalBytes: number;
  storedBytes: number;
  isNew: boolean;
}

export class ObjectIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ObjectIntegrityError";
  }
}

const HASH = /^[0-9a-f]{64}$/;
const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;
const GZIP_LEVEL = 6;
const WRITE_BUFFER_BYTES = 256 * 1024;

export function assertHash(hash: string): void {
  if (!HASH.test(hash)) throw new Error("invalid object hash");
}

export function checkpointDir(databaseId: string): string {
  if (!SAFE_ID.test(databaseId)) throw new Error(`unsafe database id: ${databaseId}`);
  return join(env.checkpointsDir, databaseId);
}

function objectsDir(databaseId: string): string {
  return join(checkpointDir(databaseId), "objects");
}

function tmpDir(databaseId: string): string {
  return join(checkpointDir(databaseId), "tmp");
}

export function objectPath(databaseId: string, hash: string): string {
  assertHash(hash);
  return join(objectsDir(databaseId), hash.slice(0, 2), `${hash}.sql.gz`);
}

export function hasObject(databaseId: string, hash: string): boolean {
  return existsSync(objectPath(databaseId, hash));
}

export function sha256Hex(data: string | Uint8Array): string {
  return new Bun.CryptoHasher("sha256").update(data).digest("hex");
}

function fsyncPath(path: string): void {
  const fd = openSync(path, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

const pinned = new Map<string, Map<string, number>>();

export class ObjectPins {
  private readonly held = new Map<string, number>();
  private released = false;

  constructor(private readonly databaseId: string) {}

  pin(hash: string): void {
    if (this.released) return;
    const perDb = pinned.get(this.databaseId) ?? new Map<string, number>();
    perDb.set(hash, (perDb.get(hash) ?? 0) + 1);
    pinned.set(this.databaseId, perDb);
    this.held.set(hash, (this.held.get(hash) ?? 0) + 1);
  }

  release(): void {
    if (this.released) return;
    this.released = true;
    const perDb = pinned.get(this.databaseId);
    if (!perDb) return;
    for (const [hash, n] of this.held) {
      const left = (perDb.get(hash) ?? n) - n;
      if (left > 0) perDb.set(hash, left);
      else perDb.delete(hash);
    }
    if (perDb.size === 0) pinned.delete(this.databaseId);
    this.held.clear();
  }
}

export function isObjectPinned(databaseId: string, hash: string): boolean {
  return (pinned.get(databaseId)?.get(hash) ?? 0) > 0;
}

function objectInUse(databaseId: string, hash: string): boolean {
  return isObjectPinned(databaseId, hash) || checkpoints.isObjectReferenced(databaseId, hash);
}

export class ObjectWriter implements ChunkWriter<StoredObject> {
  private readonly hasher = new Bun.CryptoHasher("sha256");
  private readonly gzip = createGzip({ level: GZIP_LEVEL });
  private readonly done: Promise<void>;
  private readonly buffer = new Uint8Array(WRITE_BUFFER_BYTES);
  private buffered = 0;
  private logical = 0;
  private closed = false;

  private constructor(
    private readonly databaseId: string,
    private readonly tmpPath: string,
    private readonly pins: ObjectPins | null,
  ) {
    const out = createWriteStream(tmpPath, { mode: 0o600, flags: "wx" });
    this.done = pipeline(this.gzip, out);
    this.done.catch(() => {});
  }

  static async open(databaseId: string, pins: ObjectPins | null = null): Promise<ObjectWriter> {
    const dir = tmpDir(databaseId);
    if (!existsSync(dir)) await mkdir(dir, { recursive: true, mode: 0o700 });
    return new ObjectWriter(databaseId, join(dir, `${Date.now()}-${randAlphaNum(10)}.gz`), pins);
  }

  private async push(bytes: Uint8Array): Promise<void> {
    this.hasher.update(bytes);
    if (!this.gzip.write(bytes)) {
      await Promise.race([once(this.gzip, "drain"), this.done]);
    }
  }

  private async flushBuffer(): Promise<void> {
    if (this.buffered === 0) return;
    const chunk = this.buffer.slice(0, this.buffered);
    this.buffered = 0;
    await this.push(chunk);
  }

  async write(bytes: Uint8Array): Promise<void> {
    if (this.closed) throw new Error("object writer is closed");
    if (bytes.length === 0) return;
    this.logical += bytes.length;
    if (this.buffered + bytes.length > WRITE_BUFFER_BYTES) await this.flushBuffer();
    if (bytes.length >= WRITE_BUFFER_BYTES) {
      await this.push(bytes.slice());
      return;
    }
    this.buffer.set(bytes, this.buffered);
    this.buffered += bytes.length;
  }

  async finish(): Promise<StoredObject> {
    if (this.closed) throw new Error("object writer is closed");
    this.closed = true;
    try {
      await this.flushBuffer();
      this.gzip.end();
      await this.done;
      fsyncPath(this.tmpPath);
      const hash = this.hasher.digest("hex");
      this.pins?.pin(hash);
      forgetDeferred(this.databaseId, hash);
      const final = objectPath(this.databaseId, hash);
      const storedBytes = (await stat(this.tmpPath)).size;
      const existing = await stat(final).catch(() => null);
      if (existing) {
        await unlink(this.tmpPath).catch(() => {});
        return { hash, logicalBytes: this.logical, storedBytes: existing.size, isNew: false };
      }
      try {
        await rename(this.tmpPath, final);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
        await mkdir(join(objectsDir(this.databaseId), hash.slice(0, 2)), { recursive: true, mode: 0o700 });
        await rename(this.tmpPath, final);
      }
      return { hash, logicalBytes: this.logical, storedBytes, isNew: true };
    } catch (err) {
      await unlink(this.tmpPath).catch(() => {});
      throw err;
    }
  }

  async abort(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.gzip.destroy();
    await this.done.catch(() => {});
    await unlink(this.tmpPath).catch(() => {});
  }
}

export async function storeBytes(databaseId: string, data: string | Uint8Array, pins: ObjectPins | null = null): Promise<StoredObject> {
  const writer = await ObjectWriter.open(databaseId, pins);
  try {
    await writer.write(typeof data === "string" ? new TextEncoder().encode(data) : data);
  } catch (err) {
    await writer.abort();
    throw err;
  }
  return writer.finish();
}

export async function* gunzipObject(databaseId: string, hash: string): AsyncGenerator<Uint8Array> {
  const path = objectPath(databaseId, hash);
  if (!existsSync(path)) throw new ObjectIntegrityError(`checkpoint object ${hash.slice(0, 12)} is missing`);
  const hasher = new Bun.CryptoHasher("sha256");
  const source = createReadStream(path);
  const gunzip = createGunzip();
  source.on("error", (err) => gunzip.destroy(err));
  source.pipe(gunzip);
  try {
    for await (const chunk of gunzip) {
      const bytes = chunk as Uint8Array;
      hasher.update(bytes);
      yield bytes;
    }
  } catch (err) {
    throw new ObjectIntegrityError(
      `checkpoint object ${hash.slice(0, 12)} could not be read: ${err instanceof Error ? err.message : String(err)}`,
    );
  } finally {
    source.destroy();
    gunzip.destroy();
  }
  if (hasher.digest("hex") !== hash) {
    throw new ObjectIntegrityError(`checkpoint object ${hash.slice(0, 12)} is corrupt (hash mismatch)`);
  }
}

export async function readObjectText(databaseId: string, hash: string): Promise<string> {
  const parts: Uint8Array[] = [];
  for await (const chunk of gunzipObject(databaseId, hash)) parts.push(chunk);
  return Buffer.concat(parts).toString("utf8");
}

export function rawObjectStream(databaseId: string, hash: string): ReadableStream<Uint8Array> {
  return Bun.file(objectPath(databaseId, hash)).stream();
}

const leases = new Map<string, number>();
const deferred = new Map<string, Map<string, () => boolean>>();

function forgetDeferred(databaseId: string, hash: string): void {
  deferred.get(databaseId)?.delete(hash);
}

async function unlinkObject(databaseId: string, hash: string): Promise<void> {
  await unlink(objectPath(databaseId, hash)).catch((err: NodeJS.ErrnoException) => {
    if (err.code !== "ENOENT") throw err;
  });
}

export function objectsLeased(databaseId: string): boolean {
  return (leases.get(databaseId) ?? 0) > 0;
}

export function acquireObjectLease(databaseId: string): () => void {
  leases.set(databaseId, (leases.get(databaseId) ?? 0) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const left = (leases.get(databaseId) ?? 1) - 1;
    if (left > 0) {
      leases.set(databaseId, left);
      return;
    }
    leases.delete(databaseId);
    const pending = deferred.get(databaseId);
    deferred.delete(databaseId);
    if (!pending) return;
    for (const [hash, stillUnused] of pending) {
      if (objectInUse(databaseId, hash) || !stillUnused()) continue;
      unlinkObject(databaseId, hash).catch((err) => {
        console.warn(`[checkpoints] could not remove unused checkpoint object ${hash.slice(0, 12)}:`, String(err));
      });
    }
  };
}

export async function removeObject(databaseId: string, hash: string, stillUnused: () => boolean = () => true): Promise<void> {
  assertHash(hash);
  if (objectInUse(databaseId, hash) || !stillUnused()) return;
  if (objectsLeased(databaseId)) {
    const pending = deferred.get(databaseId) ?? new Map<string, () => boolean>();
    pending.set(hash, stillUnused);
    deferred.set(databaseId, pending);
    return;
  }
  await unlinkObject(databaseId, hash);
}

export async function sweepObjects(databaseId: string, referenced: Set<string>): Promise<{ removed: number }> {
  let removed = 0;
  if (objectsLeased(databaseId)) return { removed };
  await rm(tmpDir(databaseId), { recursive: true, force: true });
  const root = objectsDir(databaseId);
  if (!existsSync(root)) return { removed };
  for (const prefix of await readdir(root)) {
    const dir = join(root, prefix);
    let names: string[];
    try {
      names = await readdir(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      const hash = name.endsWith(".sql.gz") ? name.slice(0, -7) : "";
      if (!HASH.test(hash) || referenced.has(hash) || objectInUse(databaseId, hash)) continue;
      await unlink(join(dir, name)).catch(() => {});
      removed++;
    }
  }
  return { removed };
}

export async function removeCheckpointDir(databaseId: string): Promise<void> {
  await rm(checkpointDir(databaseId), { recursive: true, force: true });
}

export interface StoreCheck {
  checked: number;
  missing: string[];
  corrupt: string[];
}

export async function verifyStoredObjects(databaseId: string, hashes: Iterable<string>): Promise<StoreCheck> {
  const out: StoreCheck = { checked: 0, missing: [], corrupt: [] };
  for (const hash of new Set(hashes)) {
    out.checked++;
    if (!hasObject(databaseId, hash)) {
      out.missing.push(hash);
      continue;
    }
    try {
      for await (const _ of gunzipObject(databaseId, hash)) {
      }
    } catch {
      out.corrupt.push(hash);
    }
  }
  return out;
}
