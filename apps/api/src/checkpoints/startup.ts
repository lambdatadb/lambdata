import { existsSync, mkdirSync, statSync, utimesSync } from "node:fs";
import { readdir, rename, unlink } from "node:fs/promises";
import { basename, join, resolve, sep } from "node:path";
import type { Snapshot } from "@lambdata/shared";
import { checkpoints, databases, snapshots } from "../db/queries";
import { env } from "../env";
import { registerStartupTask } from "../lifecycle";
import { notifySnapshotUnconverted } from "../notifications/bus";
import { commitHash } from "./hash";
import { legacyMessage } from "./sql";
import { gunzipObject, hasObject, ObjectWriter, sha256Hex, type StoredObject } from "./store";

export interface LegacyConversionResult {
  converted: number;
  dropped: number;
  failed: number;
}

export const CONVERTED_DIR_NAME = "converted";
export const CONVERTED_KEEP_MS = 30 * 24 * 60 * 60 * 1000;
const RETRY_INTERVAL_MS = 60 * 60 * 1000;
const SNAPSHOT_FILE = /^([A-Za-z0-9_-]+)_(\d+)\.sql$/;

const attempted = new Set<string>();
const movedThisBoot = new Set<string>();
let conversionRuns = 0;
let lastAttemptAt = 0;
let lastError: string | null = null;
let running: Promise<LegacyConversionResult> | null = null;

export function legacyCheckpointId(snapshotId: string): string {
  return `cp_${sha256Hex(`legacy:${snapshotId}`).slice(0, 32)}`;
}

export function convertedDir(): string {
  return join(env.snapshotsDir, CONVERTED_DIR_NAME);
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function resolveLegacyFile(stored: string): { path: string; owned: boolean } | null {
  const name = basename(stored || "");
  if (name && name !== "." && name !== "..") {
    const local = join(env.snapshotsDir, name);
    if (isFile(local)) return { path: local, owned: true };
  }
  if (stored && isFile(stored)) {
    const inside = resolve(stored).startsWith(`${resolve(env.snapshotsDir)}${sep}`);
    const converted = resolve(stored).startsWith(`${resolve(convertedDir())}${sep}`);
    return { path: stored, owned: inside && !converted };
  }
  return null;
}

async function storeFile(databaseId: string, path: string): Promise<StoredObject> {
  const writer = await ObjectWriter.open(databaseId);
  try {
    const reader = Bun.file(path).stream().getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) await writer.write(value);
    }
  } catch (err) {
    await writer.abort();
    throw err;
  }
  return writer.finish();
}

async function verifyObject(databaseId: string, hash: string): Promise<number> {
  let bytes = 0;
  for await (const chunk of gunzipObject(databaseId, hash)) bytes += chunk.length;
  return bytes;
}

async function keepOriginal(path: string): Promise<void> {
  const dir = convertedDir();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const target = join(dir, basename(path));
  await rename(path, target);
  const now = new Date();
  try {
    utimesSync(target, now, now);
  } catch {}
  movedThisBoot.add(basename(path));
}

async function convertOne(snap: Snapshot): Promise<"converted" | "dropped"> {
  const found = resolveLegacyFile(snap.filePath);
  if (!found) {
    console.warn(`[checkpoints] legacy snapshot ${snap.id} has no file at ${snap.filePath}; dropping the record`);
    snapshots.delete(snap.id);
    checkpoints.clearConversionFailure(snap.id);
    return "dropped";
  }
  const path = found.path;
  const size = statSync(path).size;
  const object = await storeFile(snap.databaseId, path);
  const verified = await verifyObject(snap.databaseId, object.hash);
  if (verified !== size || object.logicalBytes !== size) {
    throw new Error(`stored copy of ${basename(path)} does not match the original (${verified} of ${size} bytes)`);
  }
  const id = legacyCheckpointId(snap.id);
  const parentId = checkpoints.latestLegacyBefore(snap.databaseId, snap.createdAt);
  const parentHash = parentId ? checkpoints.hashOf(parentId) : null;
  const trigger = snap.trigger === "scheduled" ? "scheduled" : "legacy";
  const message = legacyMessage(snap.createdAt);
  const hash = commitHash({
    parentHash,
    treeHash: null,
    message,
    trigger,
    createdAt: snap.createdAt,
    legacyObjectHash: object.hash,
  });
  checkpoints.insertLegacy(
    {
      id,
      databaseId: snap.databaseId,
      hash,
      treeHash: null,
      parentId,
      message,
      trigger,
      format: "legacy",
      createdByUserId: null,
      createdAt: snap.createdAt,
      tableCount: null,
      rowCount: null,
      logicalBytes: object.logicalBytes,
      storedBytes: object.storedBytes,
      newBytes: object.isNew ? object.storedBytes : 0,
    },
    {
      kind: "legacy",
      name: basename(path),
      objectHash: object.hash,
      rowCount: null,
      logicalBytes: object.logicalBytes,
      storedBytes: object.storedBytes,
      schemaHash: null,
      checksum: null,
    },
    snap.id,
  );
  checkpoints.clearConversionFailure(snap.id);
  if (found.owned) {
    await keepOriginal(path).catch((err) => {
      console.warn(`[checkpoints] converted ${snap.id} but could not move ${path} to ${convertedDir()}:`, errorMessage(err));
    });
  } else {
    console.warn(`[checkpoints] converted ${snap.id} from ${path}, which is outside the data directory; it was left in place`);
  }
  return "converted";
}

async function keepConvertedLeftovers(): Promise<void> {
  if (!existsSync(env.snapshotsDir)) return;
  const pending = new Set(snapshots.listAll().map((s) => basename(s.filePath)));
  for (const name of await readdir(env.snapshotsDir)) {
    const m = SNAPSHOT_FILE.exec(name);
    if (!m || pending.has(name)) continue;
    const databaseId = m[1]!;
    const createdAt = Number(m[2]);
    const match = checkpoints
      .listForDatabase(databaseId)
      .find((c) => c.format === "legacy" && c.createdAt === createdAt);
    if (!match) continue;
    const entry = checkpoints.entries(match.id).find((e) => e.kind === "legacy");
    if (!entry || !hasObject(databaseId, entry.objectHash)) continue;
    const path = join(env.snapshotsDir, name);
    if (!isFile(path) || statSync(path).size !== entry.logicalBytes) continue;
    await keepOriginal(path).catch(() => {});
  }
}

export async function removeExpiredOriginals(now: number = Date.now()): Promise<number> {
  const dir = convertedDir();
  if (!existsSync(dir)) return 0;
  let removed = 0;
  for (const name of await readdir(dir)) {
    if (!SNAPSHOT_FILE.test(name) || movedThisBoot.has(name)) continue;
    const path = join(dir, name);
    try {
      const st = statSync(path);
      if (!st.isFile() || now - st.mtimeMs < CONVERTED_KEEP_MS) continue;
      await unlink(path);
      removed++;
    } catch (err) {
      console.warn(`[checkpoints] could not remove the converted snapshot original ${path}:`, errorMessage(err));
    }
  }
  return removed;
}

export function legacyConversionHasRun(): boolean {
  return conversionRuns > 0;
}

export function snapshotAwaitingConversion(databaseId: string): boolean {
  return snapshots.list(databaseId).some((s) => !attempted.has(s.id));
}

export function legacyConversionHealth(): { unconvertedSnapshots: number; lastConversionError: string | null } {
  const failures = checkpoints.conversionFailures();
  return {
    unconvertedSnapshots: snapshots.count(),
    lastConversionError: failures[0]?.reason ?? lastError,
  };
}

async function runConversion(): Promise<LegacyConversionResult> {
  const result: LegacyConversionResult = { converted: 0, dropped: 0, failed: 0 };
  const rows = snapshots.listAll();
  const touched = new Set<string>();
  lastAttemptAt = Date.now();
  for (const snap of rows) {
    try {
      const outcome = await convertOne(snap);
      result[outcome]++;
      touched.add(snap.databaseId);
    } catch (err) {
      result.failed++;
      const reason = errorMessage(err);
      lastError = reason;
      try {
        checkpoints.recordConversionFailure(snap.id, snap.databaseId, reason, Date.now());
        notifySnapshotUnconverted(snap.id, snap.databaseId);
      } catch {}
      console.error(
        `[checkpoints] could not convert legacy snapshot ${snap.id}; it is kept, shown in the database's history as not converted, and retried later:`,
        reason,
      );
    } finally {
      attempted.add(snap.id);
    }
  }
  checkpoints.pruneConversionFailures();
  for (const databaseId of touched) {
    const row = databases.byId(databaseId);
    if (!row || row.baseCheckpointId) continue;
    const newest = checkpoints.listForDatabase(databaseId).find((c) => c.format === "legacy");
    if (newest) databases.setBaseCheckpoint(databaseId, newest.id);
  }
  await keepConvertedLeftovers().catch((err) => {
    console.warn("[checkpoints] could not keep converted snapshot files:", errorMessage(err));
  });
  conversionRuns++;
  if (result.converted + result.dropped + result.failed > 0) {
    console.log(
      `[checkpoints] legacy snapshots: ${result.converted} converted, ${result.dropped} dropped, ${result.failed} failed`,
    );
  }
  return result;
}

export function convertLegacySnapshots(): Promise<LegacyConversionResult> {
  if (running) return running;
  running = runConversion().finally(() => {
    running = null;
  });
  return running;
}

export async function retryFailedConversions(now: number = Date.now()): Promise<LegacyConversionResult | null> {
  if (!legacyConversionHasRun() || snapshots.count() === 0) return null;
  if (now - lastAttemptAt < RETRY_INTERVAL_MS) return null;
  return convertLegacySnapshots();
}

registerStartupTask("checkpoints.legacy", async () => {
  await convertLegacySnapshots();
  const removed = await removeExpiredOriginals().catch(() => 0);
  if (removed > 0) console.log(`[checkpoints] removed ${removed} converted snapshot original(s) older than 30 days`);
});
