import type { DatabasePortSource } from "@lambdata/shared";
import { env } from "../env";
import { settings } from "../db/queries";

export const OUTSIDE_CONNECTIONS_KEY = "mariadb_outside_connections";
export const LOOPBACK_BIND = "127.0.0.1";
export const ALL_INTERFACES_BIND = "0.0.0.0";

export interface ResolvedBind {
  bind: string;
  source: DatabasePortSource;
  lockedByEnv: boolean;
}

export function isLoopbackBind(bind: string): boolean {
  const host = bind.trim().replace(/^\[|\]$/g, "").toLowerCase();
  return host === "localhost" || host === "::1" || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
}

export function storedOutsideConnections(): boolean | null {
  const value = settings.get(OUTSIDE_CONNECTIONS_KEY);
  if (value === "1" || value === "true") return true;
  if (value === "0" || value === "false") return false;
  return null;
}

export function saveOutsideConnections(on: boolean): void {
  settings.set(OUTSIDE_CONNECTIONS_KEY, on ? "1" : "0");
}

export function bindFor(outsideConnections: boolean): string {
  return outsideConnections ? ALL_INTERFACES_BIND : LOOPBACK_BIND;
}

export function resolveDatabaseBind(): ResolvedBind {
  const fromEnv = env.mariadbBindFromEnv?.trim();
  if (fromEnv) return { bind: fromEnv, source: "env", lockedByEnv: true };
  let stored: boolean | null = null;
  try {
    stored = storedOutsideConnections();
  } catch {
    stored = null;
  }
  if (stored !== null) return { bind: bindFor(stored), source: "setting", lockedByEnv: false };
  return { bind: LOOPBACK_BIND, source: "default", lockedByEnv: false };
}
