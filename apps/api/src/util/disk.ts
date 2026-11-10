import { statfsSync } from "node:fs";
import { HTTPException } from "hono/http-exception";
import type { Role } from "@lambdata/shared";
import { settings } from "../db/queries";
import { env, readEnv } from "../env";

const KB = 1024;
const MB = 1024 * KB;
const GB = 1024 * MB;
const TB = 1024 * GB;
const HOUR_MS = 60 * 60 * 1000;

export const DISK_DEFAULTS = {
  floorBytes: 5 * GB,
  floorFraction: 0.1,
  checkpointMaxAutoRetention: 30,
  checkpointMinIntervalHours: 1,
} as const;

export const CHECKPOINT_RETENTION_KEY = "checkpoint_max_auto_retention";
export const CHECKPOINT_INTERVAL_KEY = "checkpoint_min_interval_hours";
export const MAX_RETENTION_CEILING = 1000;
export const MAX_INTERVAL_FLOOR_HOURS = 8760;

const UNITS: Record<string, number> = {
  "": 1,
  b: 1,
  k: KB,
  kb: KB,
  kib: KB,
  m: MB,
  mb: MB,
  mib: MB,
  g: GB,
  gb: GB,
  gib: GB,
  t: TB,
  tb: TB,
  tib: TB,
};

export function parseByteSize(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  const m = /^\s*(\d+(?:\.\d+)?)\s*([a-z]*)\s*$/i.exec(raw);
  if (!m) return null;
  const unit = UNITS[m[2]!.toLowerCase()];
  if (unit === undefined) return null;
  const n = Math.round(Number(m[1]) * unit);
  return Number.isSafeInteger(n) && n >= 0 ? n : null;
}

export function formatBytes(n: number): string {
  if (n >= TB) return `${Math.round((n / TB) * 10) / 10} TB`;
  if (n >= GB) return `${Math.round((n / GB) * 10) / 10} GB`;
  if (n >= MB) return `${Math.round((n / MB) * 10) / 10} MB`;
  if (n >= KB) return `${Math.round(n / KB)} KB`;
  return `${n} bytes`;
}

const reportedBadEnv = new Set<string>();

function reportBadEnv(name: string, raw: string, expected: string): void {
  const key = `${name}=${raw}`;
  if (reportedBadEnv.has(key)) return;
  reportedBadEnv.add(key);
  console.warn(`[limits] LAMBDATA_${name}="${raw}" is not ${expected}; using the default instead`);
}

export function envBytes(name: string): number | null {
  const raw = readEnv(name);
  if (raw === undefined || raw.trim() === "") return null;
  const n = parseByteSize(raw);
  if (n === null) reportBadEnv(name, raw, "a size such as 5GB, 500MB or 0");
  return n;
}

export function envCount(name: string, min = 1): number | null {
  const raw = readEnv(name);
  if (raw === undefined || raw.trim() === "") return null;
  const n = Number(raw.trim());
  if (!Number.isSafeInteger(n) || n < min) {
    reportBadEnv(name, raw, `a whole number of at least ${min}`);
    return null;
  }
  return n;
}

export interface VolumeSpace {
  freeBytes: number;
  totalBytes: number;
}

export const diskProbe = {
  space(dir: string): VolumeSpace | null {
    try {
      const s = statfsSync(dir);
      return { freeBytes: Number(s.bavail) * Number(s.bsize), totalBytes: Number(s.blocks) * Number(s.bsize) };
    } catch {
      return null;
    }
  },
};

let cache: { dir: string; at: number; value: number | null } | null = null;

export async function dataDirFreeBytes(ttlMs = 10_000): Promise<number | null> {
  const dir = env.dataDir;
  const now = Date.now();
  if (cache && cache.dir === dir && now - cache.at < ttlMs) return cache.value;
  const value = diskProbe.space(dir)?.freeBytes ?? null;
  cache = { dir, at: now, value };
  return value;
}

export interface DiskStatus {
  dir: string;
  freeBytes: number | null;
  totalBytes: number | null;
  floorBytes: number;
  warnBytes: number;
  belowFloor: boolean;
  low: boolean;
}

export function diskFloorBytes(totalBytes: number | null): number {
  const configured = envBytes("DISK_FLOOR");
  if (configured !== null) return configured;
  if (totalBytes !== null && totalBytes > 0) {
    return Math.min(DISK_DEFAULTS.floorBytes, Math.floor(totalBytes * DISK_DEFAULTS.floorFraction));
  }
  return DISK_DEFAULTS.floorBytes;
}

export const DISK_CACHE_MS = 10_000;

let spaceCache: { dir: string; at: number; probe: (dir: string) => VolumeSpace | null; space: VolumeSpace | null } | null = null;

function cachedSpace(dir: string, ttlMs: number): VolumeSpace | null {
  const now = Date.now();
  const probe = diskProbe.space;
  if (spaceCache && spaceCache.dir === dir && spaceCache.probe === probe && now - spaceCache.at < ttlMs) return spaceCache.space;
  const space = probe(dir);
  spaceCache = { dir, at: now, probe, space };
  return space;
}

export function diskStatus(opts: { cachedMs?: number } = {}): DiskStatus {
  const dir = env.dataDir;
  const space = opts.cachedMs !== undefined ? cachedSpace(dir, opts.cachedMs) : diskProbe.space(dir);
  const floorBytes = diskFloorBytes(space?.totalBytes ?? null);
  const warnBytes = Math.max(floorBytes, envBytes("DISK_WARN") ?? floorBytes * 2);
  const freeBytes = space?.freeBytes ?? null;
  return {
    dir,
    freeBytes,
    totalBytes: space?.totalBytes ?? null,
    floorBytes,
    warnBytes,
    belowFloor: freeBytes !== null && floorBytes > 0 && freeBytes < floorBytes,
    low: freeBytes !== null && warnBytes > 0 && freeBytes < warnBytes,
  };
}

export class DiskSpaceError extends HTTPException {
  readonly freeBytes: number;
  readonly floorBytes: number;

  constructor(message: string, freeBytes: number, floorBytes: number) {
    super(507, { message });
    this.name = "DiskSpaceError";
    this.freeBytes = freeBytes;
    this.floorBytes = floorBytes;
  }
}

function refusal(action: string, status: DiskStatus & { freeBytes: number }, incomingBytes: number): string {
  const free = formatBytes(status.freeBytes);
  const floor = formatBytes(status.floorBytes);
  const why =
    incomingBytes > 0 && status.freeBytes >= status.floorBytes
      ? `the data volume has ${free} free, and ${formatBytes(incomingBytes)} more would leave ${formatBytes(Math.max(0, status.freeBytes - incomingBytes))}, below the ${floor} floor`
      : `the data volume has ${free} free, below the ${floor} floor`;
  return `Not enough disk space to ${action}: ${why} that LambData keeps free so MariaDB can keep running. Free some space (old checkpoints, pending uploads, files in Storage) or ask an admin to; the floor is set with LAMBDATA_DISK_FLOOR.`;
}

export function lowSpaceWarning(status: DiskStatus): string | null {
  if (!status.low || status.freeBytes === null) return null;
  if (status.belowFloor) {
    return `Disk space is below the floor: ${formatBytes(status.freeBytes)} free on the data volume, less than ${formatBytes(status.floorBytes)}. LambData is refusing uploads, files in Storage, Data API inserts and updates, checkpoints and syncs until space is freed, so that MariaDB keeps running.`;
  }
  return `Disk space is running low: ${formatBytes(status.freeBytes)} free on the data volume. Below ${formatBytes(status.floorBytes)} LambData stops accepting uploads, files in Storage, Data API inserts and updates, checkpoints and syncs so that MariaDB keeps running.`;
}

let lastLowLog = 0;

export function noteDiskStatus(status: DiskStatus, now: number = Date.now()): void {
  const warning = lowSpaceWarning(status);
  if (!warning) {
    lastLowLog = 0;
    return;
  }
  if (lastLowLog !== 0 && now - lastLowLog < HOUR_MS) return;
  lastLowLog = now;
  console.warn(`[limits] ${warning} Data directory: ${status.dir}`);
}

export function assertDiskRoom(action: string, incomingBytes = 0, opts: { cachedMs?: number } = {}): DiskStatus {
  const status = diskStatus(opts);
  noteDiskStatus(status);
  if (status.freeBytes === null || status.floorBytes <= 0) return status;
  const free = status.freeBytes;
  if (free < status.floorBytes || free - incomingBytes < status.floorBytes) {
    throw new DiskSpaceError(refusal(action, { ...status, freeBytes: free }, incomingBytes), free, status.floorBytes);
  }
  return status;
}

export interface CheckpointCeilings {
  maxAutoRetention: number;
  minIntervalHours: number;
}

function storedCount(key: string, max: number): number | null {
  const raw = settings.get(key);
  if (raw === null || raw === "") return null;
  const n = Number(raw);
  return Number.isSafeInteger(n) && n >= 1 && n <= max ? n : null;
}

export function checkpointCeilings(): CheckpointCeilings {
  return {
    maxAutoRetention:
      storedCount(CHECKPOINT_RETENTION_KEY, MAX_RETENTION_CEILING) ??
      envCount("CHECKPOINT_MAX_RETENTION") ??
      DISK_DEFAULTS.checkpointMaxAutoRetention,
    minIntervalHours:
      storedCount(CHECKPOINT_INTERVAL_KEY, MAX_INTERVAL_FLOOR_HOURS) ??
      envCount("CHECKPOINT_MIN_INTERVAL_HOURS") ??
      DISK_DEFAULTS.checkpointMinIntervalHours,
  };
}

export function setCheckpointCeilings(patch: { maxAutoRetention?: number | null; minIntervalHours?: number | null }): void {
  if (patch.maxAutoRetention !== undefined) {
    settings.set(CHECKPOINT_RETENTION_KEY, patch.maxAutoRetention === null ? "" : String(patch.maxAutoRetention));
  }
  if (patch.minIntervalHours !== undefined) {
    settings.set(CHECKPOINT_INTERVAL_KEY, patch.minIntervalHours === null ? "" : String(patch.minIntervalHours));
  }
}

function everyHours(hours: number): string {
  return hours === 1 ? "every hour" : `every ${hours} hours`;
}

export interface AutoPolicy {
  autoIntervalHours: number;
  autoRetention: number;
}

export function assertCheckpointPolicyAllowed(p: { role: Role; next: AutoPolicy; current: AutoPolicy }): void {
  if (p.role === "admin") return;
  const limits = checkpointCeilings();
  const { next, current } = p;
  if (next.autoRetention > limits.maxAutoRetention && next.autoRetention !== current.autoRetention) {
    throw new HTTPException(400, {
      message: `This server keeps at most ${limits.maxAutoRetention} automatic checkpoints per database, and ${next.autoRetention} were requested. Choose ${limits.maxAutoRetention} or fewer, or ask an admin to raise the limit in Settings.`,
    });
  }
  if (
    next.autoIntervalHours > 0 &&
    next.autoIntervalHours < limits.minIntervalHours &&
    next.autoIntervalHours !== current.autoIntervalHours
  ) {
    throw new HTTPException(400, {
      message: `Automatic checkpoints can run at most ${everyHours(limits.minIntervalHours)} on this server, and ${everyHours(next.autoIntervalHours)} was requested. Choose a longer interval, or ask an admin to lower the minimum in Settings.`,
    });
  }
}
