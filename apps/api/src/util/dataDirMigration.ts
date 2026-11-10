import {
  accessSync,
  existsSync,
  readdirSync,
  statSync,
  statfsSync,
  constants as fsConstants,
} from "node:fs";
import { cp, lstat, mkdir, readdir, rm } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { homedir } from "node:os";
import { setDataDir, ensureDataDirs, env } from "../env";
import { clearPointer, readPointer, writePointer } from "./pointer";
import { closeDb, reopenDb } from "../db/client";
import { healthCheck, startMariaDb, stopMariaDb } from "../mariadb/controller";
import { migrate } from "../db/migrate";
import { runStartupTasks, runStartupTasksOnce, startServices, startupTasksStarted, stopServices } from "../lifecycle";
import { hasActiveWork } from "../jobs";

const IGNORED_ENTRIES = new Set([".DS_Store", "lost+found", ".Trashes", ".Spotlight-V100", ".fseventsd", "Thumbs.db", "desktop.ini"]);
const INSTALL_MARKER = "metadata.sqlite";

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

export class DataDirMigrationError extends Error {
  readonly status: 400 | 409 | 500 | 507;

  constructor(status: 400 | 409 | 500 | 507, message: string) {
    super(message);
    this.name = "DataDirMigrationError";
    this.status = status;
  }
}

let migrating = false;

export function isDataDirMigrating(): boolean {
  return migrating;
}

function isInside(child: string, parent: string): boolean {
  return child.startsWith(parent.endsWith(sep) ? parent : `${parent}${sep}`);
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

  const current = resolve(env.dataDir);
  if (resolved !== current && (isInside(resolved, current) || isInside(current, resolved))) {
    result.error = "The new data directory cannot be inside the current one, or contain it.";
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
    const entries = readdirSync(resolved).filter((n) => !IGNORED_ENTRIES.has(n));
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

async function copyable(path: string): Promise<boolean> {
  try {
    const st = await lstat(path);
    return !st.isSocket() && !st.isFIFO();
  } catch {
    return false;
  }
}

async function treeSize(root: string): Promise<number> {
  let total = 0;
  const stack: string[] = [root];
  while (stack.length > 0) {
    const cur = stack.pop()!;
    let entries: string[];
    try {
      entries = await readdir(cur);
    } catch {
      continue;
    }
    for (const name of entries) {
      const full = join(cur, name);
      try {
        const st = await lstat(full);
        if (st.isDirectory()) stack.push(full);
        else if (st.isFile() || st.isSymbolicLink()) total += st.size;
      } catch {
        continue;
      }
    }
  }
  return total;
}

async function verifyCopy(source: string, dest: string): Promise<number> {
  let bytes = 0;
  const stack: string[] = [""];
  while (stack.length > 0) {
    const rel = stack.pop()!;
    const entries = await readdir(join(source, rel));
    for (const name of entries) {
      const relPath = rel ? join(rel, name) : name;
      const src = await lstat(join(source, relPath)).catch(() => null);
      if (!src || src.isSocket() || src.isFIFO()) continue;
      const dst = await lstat(join(dest, relPath)).catch(() => null);
      if (!dst) throw new Error(`Copy verification failed: ${relPath} is missing at the destination.`);
      if (src.isDirectory()) {
        if (!dst.isDirectory()) throw new Error(`Copy verification failed: ${relPath} is not a directory.`);
        stack.push(relPath);
      } else if (src.isFile()) {
        if (!dst.isFile() || dst.size !== src.size) {
          throw new Error(`Copy verification failed: ${relPath} differs in size.`);
        }
        bytes += dst.size;
      } else if (src.isSymbolicLink()) {
        if (!dst.isSymbolicLink()) throw new Error(`Copy verification failed: ${relPath} is not a link.`);
        bytes += dst.size;
      }
    }
  }
  return bytes;
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

async function mariaDbRunning(): Promise<boolean> {
  try {
    return (await healthCheck()).ok;
  } catch {
    return false;
  }
}

async function adoptCurrent(path: string, started: number): Promise<MigrationResult> {
  writePointer(path);
  ensureDataDirs();
  if (!(await mariaDbRunning())) {
    try {
      await startMariaDb();
    } catch (err) {
      throw new DataDirMigrationError(
        500,
        `Storage is configured, but MariaDB failed to start: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  void runStartupTasksOnce();
  return { oldPath: path, newPath: path, bytesCopied: 0, durationMs: Date.now() - started };
}

export type DestinationKind = "missing" | "empty" | "install" | "occupied";

export function inspectDestination(path: string): DestinationKind {
  if (!existsSync(path)) return "missing";
  const entries = readdirSync(path).filter((n) => !IGNORED_ENTRIES.has(n));
  if (entries.length === 0) return "empty";
  try {
    if (entries.includes(INSTALL_MARKER) && statSync(join(path, INSTALL_MARKER)).isFile()) return "install";
  } catch {
    return "occupied";
  }
  return "occupied";
}

function rerunStartupTasks(): void {
  void (startupTasksStarted() ? runStartupTasks().then(() => undefined) : runStartupTasksOnce());
}

async function clearCopiedEntries(path: string): Promise<void> {
  for (const name of await readdir(path)) {
    if (IGNORED_ENTRIES.has(name)) continue;
    await rm(join(path, name), { recursive: true, force: true });
  }
}

async function restart(dataDir: string): Promise<void> {
  setDataDir(dataDir);
  try {
    reopenDb();
  } catch (err) {
    console.error("[migrate] reopening metadata failed:", err);
  }
  await startMariaDb().catch((e) => console.error("[migrate] MariaDB restart failed:", e));
  await startServices();
}

async function moveTo(oldPath: string, newPath: string, freeBytes: number | null): Promise<MigrationResult> {
  const started = Date.now();
  const previousPointer = readPointer();
  const createdDest = !existsSync(newPath);
  const destWasEmpty = !createdDest && inspectDestination(newPath) === "empty";
  let pointerWritten = false;
  let bytesCopied = 0;

  await stopServices();
  await stopMariaDb().catch((err) => {
    console.error("[migrate] stopMariaDb failed (continuing):", err);
  });
  closeDb();

  try {
    const sourceSize = existsSync(oldPath) ? await treeSize(oldPath) : 0;
    if (freeBytes !== null && freeBytes < sourceSize * 1.1) {
      throw new DataDirMigrationError(
        507,
        `Not enough free space at destination: need ~${formatBytes(sourceSize)}, have ${formatBytes(freeBytes)}.`,
      );
    }
    await mkdir(newPath, { recursive: true, mode: 0o700 });
    if (existsSync(oldPath)) {
      await cp(oldPath, newPath, {
        recursive: true,
        preserveTimestamps: true,
        force: false,
        errorOnExist: false,
        verbatimSymlinks: true,
        filter: copyable,
      });
      bytesCopied = await verifyCopy(oldPath, newPath);
    }

    writePointer(newPath);
    pointerWritten = true;
    setDataDir(newPath);
    ensureDataDirs();
    reopenDb();
    migrate();
    await startMariaDb();
    await startServices();
  } catch (err) {
    console.error("[migrate] failed, rolling back:", err);
    if (pointerWritten) {
      try {
        if (previousPointer) writePointer(previousPointer);
        else clearPointer();
      } catch (pointerErr) {
        console.error("[migrate] could not restore the data directory pointer:", pointerErr);
      }
    }
    await stopMariaDb().catch(() => {});
    await restart(oldPath);
    if (createdDest) {
      await rm(newPath, { recursive: true, force: true }).catch((rmErr) =>
        console.error("[migrate] could not remove the partial copy:", rmErr),
      );
    } else if (destWasEmpty) {
      await clearCopiedEntries(newPath).catch((rmErr) => console.error("[migrate] could not remove the partial copy:", rmErr));
    }
    throw err;
  }

  void runStartupTasksOnce();

  if (existsSync(oldPath)) {
    await rm(oldPath, { recursive: true, force: true }).catch((err) => {
      console.error("[migrate] failed to delete old data dir (left in place):", err);
    });
  }

  return { oldPath, newPath, bytesCopied, durationMs: Date.now() - started };
}

async function adoptExisting(oldPath: string, newPath: string, started: number): Promise<MigrationResult> {
  const previousPointer = readPointer();
  let pointerWritten = false;
  await stopServices();
  await stopMariaDb().catch((err) => {
    console.error("[migrate] stopMariaDb failed (continuing):", err);
  });
  closeDb();
  try {
    writePointer(newPath);
    pointerWritten = true;
    setDataDir(newPath);
    ensureDataDirs();
    reopenDb();
    migrate();
    await startMariaDb();
    await startServices();
  } catch (err) {
    console.error("[migrate] could not start the existing installation, switching back:", err);
    if (pointerWritten) {
      try {
        if (previousPointer) writePointer(previousPointer);
        else clearPointer();
      } catch (pointerErr) {
        console.error("[migrate] could not restore the data directory pointer:", pointerErr);
      }
    }
    await stopMariaDb().catch(() => {});
    closeDb();
    await restart(oldPath);
    throw new DataDirMigrationError(
      500,
      `${newPath} holds an existing LambData installation, but it could not be started, so nothing was changed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  console.log(`[migrate] now using the existing installation in ${newPath}; ${oldPath} was left as it was`);
  rerunStartupTasks();
  return { oldPath, newPath, bytesCopied: 0, durationMs: Date.now() - started };
}

export async function migrateDataDir(opts: MigrationOptions): Promise<MigrationResult> {
  if (migrating) throw new DataDirMigrationError(409, "A data directory migration is already in progress.");
  if (hasActiveWork()) {
    throw new DataDirMigrationError(409, "Background jobs are running; wait for them to finish first.");
  }
  const started = Date.now();
  const v = validateDataDirPath(opts.newPath);
  if (!v.ok) throw new DataDirMigrationError(400, v.error ?? "invalid path");
  const oldPath = resolve(env.dataDir);
  const newPath = v.resolvedPath;
  migrating = true;
  try {
    if (newPath === oldPath) return await adoptCurrent(oldPath, started);
    const destination = inspectDestination(newPath);
    if (destination === "install") return await adoptExisting(oldPath, newPath, started);
    if (destination === "occupied") {
      throw new DataDirMigrationError(
        409,
        `${newPath} is not empty and does not hold a LambData data directory. Choose an empty folder, or the folder of an existing installation to use it as it is.`,
      );
    }
    return await moveTo(env.dataDir, newPath, v.freeBytes);
  } finally {
    migrating = false;
  }
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
