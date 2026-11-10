import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { LEGACY } from "./legacy";
import { readEnv } from "./readEnv";

const HOME = process.env.HOME || homedir();
const OVERRIDE_DIR = readEnv("POINTER_DIR")?.trim() || null;

export const POINTER_DIR = OVERRIDE_DIR ? resolve(OVERRIDE_DIR) : join(HOME, ".lambdata");
export const POINTER_PATH = join(POINTER_DIR, "config.json");
const LEGACY_POINTER_PATH = OVERRIDE_DIR ? null : join(HOME, LEGACY.pointerDirName, "config.json");

interface PointerFile {
  dataDir: string;
}

function readPointerFile(path: string): string | null {
  try {
    const raw = readFileSync(path, "utf8");
    const parsed = JSON.parse(raw) as Partial<PointerFile>;
    if (typeof parsed.dataDir === "string" && parsed.dataDir.length > 0) {
      return parsed.dataDir;
    }
  } catch {
    return null;
  }
  return null;
}

export function readPointer(): string | null {
  return readPointerFile(POINTER_PATH) ?? (LEGACY_POINTER_PATH ? readPointerFile(LEGACY_POINTER_PATH) : null);
}

export function pointerPathInUse(): string {
  if (readPointerFile(POINTER_PATH) !== null) return POINTER_PATH;
  if (LEGACY_POINTER_PATH && readPointerFile(LEGACY_POINTER_PATH) !== null) return LEGACY_POINTER_PATH;
  return POINTER_PATH;
}

export function writePointer(dataDir: string): void {
  if (!existsSync(POINTER_DIR)) {
    mkdirSync(POINTER_DIR, { recursive: true, mode: 0o700 });
  }
  const tmp = `${POINTER_PATH}.tmp`;
  writeFileSync(tmp, JSON.stringify({ dataDir }, null, 2), { mode: 0o600 });
  renameSync(tmp, POINTER_PATH);
}

export function clearPointer(): void {
  rmSync(POINTER_PATH, { force: true });
}
