import { mkdirSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { readPointer } from "./util/pointer";
import { LEGACY } from "./util/legacy";
import { ENV_PREFIX, readEnv } from "./util/readEnv";

export { ENV_PREFIX, readEnv } from "./util/readEnv";

const ROOT = resolve(import.meta.dir, "../../..");

function positiveInt(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

function localDataDir(): string {
  const current = join(ROOT, ".lambdata");
  const legacy = join(ROOT, LEGACY.localDataDirName);
  return !existsSync(current) && existsSync(legacy) ? legacy : current;
}

function defaultDataDir(): string {
  return readEnv("DATA_DIR") ?? localDataDir();
}

let _dataDir = readPointer() ?? defaultDataDir();
export const DEFAULT_MARIADB_BIND = "127.0.0.1";

export function mariadbBindFromEnvironment(source: Record<string, string | undefined> = process.env): string | null {
  for (const prefix of [ENV_PREFIX, LEGACY.envPrefix]) {
    const value = source[`${prefix}MARIADB_BIND`]?.trim();
    if (value) return value;
  }
  return null;
}

function usableBind(value: string | null | undefined): string {
  return value?.trim() || DEFAULT_MARIADB_BIND;
}

let _mariadbBind = usableBind(mariadbBindFromEnvironment());

function detectContainer(): boolean {
  const forced = readEnv("IN_CONTAINER");
  if (forced === "1" || forced === "true") return true;
  if (forced === "0" || forced === "false") return false;
  return existsSync("/.dockerenv") || existsSync("/run/.containerenv");
}

export function setDataDir(path: string): void {
  _dataDir = path;
}

export const env = {
  port: Number(process.env.PORT ?? 4317),
  host: process.env.HOST ?? "127.0.0.1",
  get dataDir(): string {
    return _dataDir;
  },
  get sqlitePath(): string {
    return join(_dataDir, "metadata.sqlite");
  },
  get mariadbDataDir(): string {
    return join(_dataDir, "mariadb");
  },
  get snapshotsDir(): string {
    return join(_dataDir, "snapshots");
  },
  get checkpointsDir(): string {
    return join(_dataDir, "checkpoints");
  },
  get importsDir(): string {
    return join(_dataDir, "imports");
  },
  get storageDir(): string {
    return join(_dataDir, "storage");
  },
  get functionsDir(): string {
    return join(_dataDir, "functions");
  },
  get logsDir(): string {
    return join(_dataDir, "logs");
  },
  get masterKeyPath(): string {
    return join(_dataDir, "master.key");
  },
  mariadbPort: Number(readEnv("MARIADB_PORT") ?? 3307),
  get mariadbBind(): string {
    return _mariadbBind;
  },
  set mariadbBind(value: string) {
    _mariadbBind = usableBind(value);
  },
  mariadbBindFromEnv: mariadbBindFromEnvironment(),
  inContainer: detectContainer(),
  mariadbBin: readEnv("MARIADB_BIN") ?? null,
  rootUser: "lambdata_root",
  webOrigin: readEnv("WEB_ORIGIN") ?? "http://localhost:5173",
  extraOrigins: (readEnv("EXTRA_ORIGINS") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
  cookieSecure: readEnv("COOKIE_SECURE") === "1",
  webDist: readEnv("WEB_DIST") ?? null,
  maxConcurrentJobs: positiveInt(readEnv("MAX_CONCURRENT_JOBS"), 3),
};

export function ensureDataDirs(): void {
  for (const dir of [
    env.dataDir,
    env.mariadbDataDir,
    env.snapshotsDir,
    env.checkpointsDir,
    env.importsDir,
    env.storageDir,
    env.functionsDir,
    env.logsDir,
  ]) {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
}
