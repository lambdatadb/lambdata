import {
  accessSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
  statfsSync,
  constants as fsConstants,
} from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { homedir } from "node:os";
import { setDataDir, ensureDataDirs, env } from "../env";
import { writePointer } from "./pointer";
import { closeDb, reopenDb } from "../db/client";
import { startMariaDb, stopMariaDb } from "../mariadb/controller";
import { startSyncScheduler, stopSyncScheduler } from "../workers/sync";
import { startSnapshotScheduler, stopSnapshotScheduler } from "../workers/snapshots";
import { startMetricsLoop, stopMetricsLoop } from "../workers/metrics";
import { migrate } from "../db/migrate";

const FORBIDDEN_PREFIXES = [
  "/System",
  "/Library/System",
  "/usr/bin",
  "/usr/sbin",
  "/bin",
  "/sbin",
  "/etc",
  "/dev",
  "/private/etc",
  "/private/var/db",
];

export interface PathValidation {
  ok: boolean;
  error?: string;
  resolvedPath: string;
  exists: boolean;
  writable: boolean;
  freeBytes: number | null;
  isEmpty: boolean | null;
}

export function validateDataDirPath(input: string): PathValidation {
  const trimmed = input.trim();
  const result: PathValidation = {
    ok: false,
    resolvedPath: trimmed,
    exists: false,
    writable: false,
    freeBytes: null,
    isEmpty: null,
  };

  if (!trimmed) {
    result.error = "Path is required.";
    return result;
  }

  let resolved = trimmed;
  if (resolved.startsWith("~/") || resolved === "~") {
    resolved = join(homedir(), resolved.slice(1));
  }
  if (!isAbsolute(resolved)) {
    result.error = "Path must be absolute.";
    return result;
  }
  resolved = resolve(resolved);
  result.resolvedPath = resolved;

  if (resolved === "/") {
    result.error = "Cannot use the filesystem root.";
    return result;
  }
  for (const bad of FORBIDDEN_PREFIXES) {
    if (resolved === bad || resolved.startsWith(`${bad}/`)) {
      result.error = `Cannot use a system path (${bad}).`;
      return result;
    }
  }

  if (resolved === env.dataDir) {
    result.error = "This is already the current data directory.";
    return result;
  }

  const exists = existsSync(resolved);
  result.exists = exists;

  if (exists) {
    const stat = statSync(resolved);
    if (!stat.isDirectory()) {
      result.error = "Path exists but is not a directory.";
      return result;
    }
    try {
      accessSync(resolved, fsConstants.W_OK);
      result.writable = true;
    } catch {
      result.error = "Directory is not writable.";
      return result;
    }
    const entries = readdirSync(resolved).filter((n) => n !== ".DS_Store");
    result.isEmpty = entries.length === 0;
  } else {
    const parent = dirname(resolved);
    if (!existsSync(parent)) {
      result.error = `Parent directory does not exist: ${parent}`;
      return result;
    }
    try {
      accessSync(parent, fsConstants.W_OK);
      result.writable = true;
    } catch {
      result.error = `Parent directory is not writable: ${parent}`;
      return result;
    }
    result.isEmpty = true;
  }

  try {
    const target = exists ? resolved : dirname(resolved);
    const stats = statfsSync(target);
    result.freeBytes = Number(stats.bavail) * Number(stats.bsize);
  } catch {
    result.freeBytes = null;
  }

  result.ok = true;
  return result;
}

function dirSize(p: string): number {
  let total = 0;
  if (!existsSync(p)) return 0;
  const stack: string[] = [p];
  while (stack.length > 0) {
    const cur = stack.pop()!;
    let entries: string[];
    try {
      entries = readdirSync(cur);
    } catch {
      continue;
    }
    for (const name of entries) {
      const full = join(cur, name);
      try {
        // lstat so symlinks count as their own (small) size, matching how
        // cpSync preserves them rather than dereferencing.
        const st = lstatSync(full);
        if (st.isDirectory()) stack.push(full);
        else if (st.isFile() || st.isSymbolicLink()) total += st.size;
      } catch {
        // Skip unreadable entries.
      }
    }
  }
  return total;
}

export interface MigrationOptions {
  newPath: string;
}

export interface MigrationResult {
  oldPath: string;
  newPath: string;
  bytesCopied: number;
  durationMs: number;
}

export async function migrateDataDir(opts: MigrationOptions): Promise<MigrationResult> {
  const started = Date.now();
  const oldPath = env.dataDir;
  const v = validateDataDirPath(opts.newPath);
  if (!v.ok) {
    throw new Error(v.error ?? "invalid path");
  }
  const newPath = v.resolvedPath;

  if (newPath === oldPath) {
    throw new Error("New path is the same as the current data directory.");
  }

  stopMetricsLoop();
  stopSyncScheduler();
  stopSnapshotScheduler();
  await stopMariaDb().catch((err) => {
    console.error("[migrate] stopMariaDb failed (continuing):", err);
  });
  closeDb();

  // Measure AFTER shutdown: MariaDB truncates redo logs and other transient
  // files on clean stop, so the running-process size doesn't match what cpSync
  // will actually see. Measuring here keeps source and dest comparable.
  const sourceSize = existsSync(oldPath) ? dirSize(oldPath) : 0;
  if (v.freeBytes !== null && v.freeBytes < sourceSize * 1.1) {
    try {
      reopenDb();
    } catch {
      // Ignore reopen errors during rollback.
    }
    await startMariaDb().catch((e) => console.error("[migrate] restart failed:", e));
    startMetricsLoop();
    startSyncScheduler();
    startSnapshotScheduler();
    throw new Error(
      `Not enough free space at destination: need ~${formatBytes(sourceSize)}, have ${formatBytes(v.freeBytes)}.`,
    );
  }

  let bytesCopied = 0;

  try {
    if (!existsSync(newPath)) {
      mkdirSync(newPath, { recursive: true, mode: 0o700 });
    }

    if (existsSync(oldPath)) {
      cpSync(oldPath, newPath, {
        recursive: true,
        preserveTimestamps: true,
        force: true,
        errorOnExist: false,
      });
      const destSize = dirSize(newPath);
      bytesCopied = destSize;
      if (sourceSize > 0 && destSize < sourceSize * 0.99) {
        throw new Error(
          `Copy verification failed: source ${formatBytes(sourceSize)}, dest ${formatBytes(destSize)}.`,
        );
      }
    }

    writePointer(newPath);
    setDataDir(newPath);
    ensureDataDirs();

    reopenDb();
    migrate();

    await startMariaDb();
    startMetricsLoop();
    startSyncScheduler();
    startSnapshotScheduler();
  } catch (err) {
    console.error("[migrate] failed, attempting rollback:", err);
    setDataDir(oldPath);
    try {
      reopenDb();
    } catch {
      // Ignore reopen errors during rollback.
    }
    await startMariaDb().catch((e) => console.error("[migrate] rollback restart failed:", e));
    startMetricsLoop();
    startSyncScheduler();
    startSnapshotScheduler();
    throw err;
  }

  if (existsSync(oldPath) && oldPath !== newPath) {
    try {
      rmSync(oldPath, { recursive: true, force: true });
    } catch (err) {
      console.error("[migrate] failed to delete old data dir (left in place):", err);
    }
  }

  return {
    oldPath,
    newPath,
    bytesCopied,
    durationMs: Date.now() - started,
  };
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(1)} ${units[i]}`;
}
