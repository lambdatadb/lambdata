import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const POINTER_DIR = join(homedir(), ".kilndb");
export const POINTER_PATH = join(POINTER_DIR, "config.json");

interface PointerFile {
  dataDir: string;
}

export function readPointer(): string | null {
  try {
    const raw = readFileSync(POINTER_PATH, "utf8");
    const parsed = JSON.parse(raw) as Partial<PointerFile>;
    if (typeof parsed.dataDir === "string" && parsed.dataDir.length > 0) {
      return parsed.dataDir;
    }
  } catch {
    // Missing or unreadable — treat as unconfigured.
  }
  return null;
}

export function writePointer(dataDir: string): void {
  if (!existsSync(POINTER_DIR)) {
    mkdirSync(POINTER_DIR, { recursive: true, mode: 0o700 });
  }
  const tmp = `${POINTER_PATH}.tmp`;
  writeFileSync(tmp, JSON.stringify({ dataDir }, null, 2), { mode: 0o600 });
  renameSync(tmp, POINTER_PATH);
}
