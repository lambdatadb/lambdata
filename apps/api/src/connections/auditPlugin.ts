import { existsSync } from "node:fs";
import { join } from "node:path";
import { env, readEnv } from "../env";

export const AUDIT_PLUGIN_NAME = "server_audit";
export const AUDIT_LOG_NAME = "mariadb-audit.log";
export const AUDIT_ROTATE_BYTES = 2 * 1024 * 1024;
export const AUDIT_ROTATIONS = 1;

const pluginDirs = new Map<string, string | null>();
let disabledForProcess = false;

export function auditLogPath(): string {
  return join(env.logsDir, AUDIT_LOG_NAME);
}

function readPluginDir(server: string): string | null {
  try {
    const out = Bun.spawnSync([server, "--verbose", "--help"], {
      stdout: "pipe",
      stderr: "ignore",
      timeout: 10_000,
      env: { ...process.env },
    });
    const text = out.stdout.toString();
    const match = /^plugin[-_]dir\s+(\S.*?)\s*$/m.exec(text);
    return match ? match[1]! : null;
  } catch {
    return null;
  }
}

export function pluginDirFor(server: string): string | null {
  if (!pluginDirs.has(server)) pluginDirs.set(server, readPluginDir(server));
  return pluginDirs.get(server) ?? null;
}

export function auditPluginFile(server: string): string | null {
  const dir = pluginDirFor(server);
  if (!dir) return null;
  for (const ext of [".so", ".dll"]) {
    const file = join(dir, `${AUDIT_PLUGIN_NAME}${ext}`);
    if (existsSync(file)) return file;
  }
  return null;
}

export function auditCaptureWanted(server: string): boolean {
  if (disabledForProcess) return false;
  const setting = readEnv("CONNECTION_AUDIT");
  if (setting === "0" || setting === "off" || setting === "false") return false;
  return auditPluginFile(server) !== null;
}

export function disableAuditCaptureForProcess(): void {
  disabledForProcess = true;
}

export function enableAuditCaptureForProcess(): void {
  disabledForProcess = false;
}

export function auditServerArgs(): string[] {
  return [
    `--plugin-load-add=${AUDIT_PLUGIN_NAME}`,
    "--loose-server-audit-events=CONNECT",
    "--loose-server-audit-output-type=file",
    `--loose-server-audit-file-path=${auditLogPath()}`,
    `--loose-server-audit-file-rotate-size=${AUDIT_ROTATE_BYTES}`,
    `--loose-server-audit-file-rotations=${AUDIT_ROTATIONS}`,
    "--loose-server-audit-logging=ON",
  ];
}
