import { mkdirSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { readPointer } from "./util/pointer";

const ROOT = resolve(import.meta.dir, "../../..");

function defaultDataDir(): string {
  return process.env.KILNDB_DATA_DIR ?? join(ROOT, ".kilndb");
}

let _dataDir = readPointer() ?? defaultDataDir();

export function getDataDir(): string {
  return _dataDir;
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
  mariadbPort: Number(process.env.KILNDB_MARIADB_PORT ?? 3307),
  mariadbBind: process.env.KILNDB_MARIADB_BIND ?? "127.0.0.1",
  mariadbBin: process.env.KILNDB_MARIADB_BIN ?? null,
  rootUser: "kilndb_root",
  isProd: process.env.NODE_ENV === "production",
  webOrigin: process.env.KILNDB_WEB_ORIGIN ?? "http://localhost:5173",
  extraOrigins: (process.env.KILNDB_EXTRA_ORIGINS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
  cookieSecure: process.env.KILNDB_COOKIE_SECURE === "1",
  webDist: process.env.KILNDB_WEB_DIST ?? null,
};

export function ensureDataDirs(): void {
  for (const dir of [
    env.dataDir,
    env.mariadbDataDir,
    env.snapshotsDir,
    env.storageDir,
    env.functionsDir,
    env.logsDir,
  ]) {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
}
