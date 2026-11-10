import type { CloudflareTunnelStatus } from "@lambdata/shared";

export type TunnelPhase =
  | "off"
  | "external"
  | "not-installed"
  | "no-token"
  | "connected"
  | "connecting"
  | "retrying"
  | "failed"
  | "stopped";

export function tunnelPhase(t: CloudflareTunnelStatus): TunnelPhase {
  if (t.mode === "off") return "off";
  if (t.mode === "external") return "external";
  if (!t.installed) return "not-installed";
  if (t.running) return (t.connections ?? 0) > 0 ? "connected" : "connecting";
  if (!t.tokenConfigured) return "no-token";
  if (t.desired === true) return "retrying";
  if (t.desired === false) return t.lastError ? "failed" : "stopped";
  return t.lastError ? "retrying" : "stopped";
}

export type PhaseTone = "success" | "warn" | "danger" | "muted" | "info";

export const TUNNEL_PHASES: Record<TunnelPhase, { tone: PhaseTone; short: string; badge: string; state: string }> = {
  off: { tone: "muted", short: "off", badge: "off", state: "Off" },
  external: { tone: "muted", short: "external", badge: "running elsewhere", state: "Run by your own cloudflared" },
  "not-installed": { tone: "warn", short: "missing", badge: "cloudflared missing", state: "cloudflared is not installed" },
  "no-token": { tone: "warn", short: "no token", badge: "needs a token", state: "Waiting for a token" },
  connected: { tone: "success", short: "up", badge: "connected", state: "Connected to Cloudflare" },
  connecting: { tone: "warn", short: "starting", badge: "connecting", state: "Starting, waiting for Cloudflare" },
  retrying: { tone: "warn", short: "retrying", badge: "retrying", state: "Not connected; LambData keeps retrying" },
  failed: { tone: "danger", short: "stopped", badge: "stopped after an error", state: "Stopped after an error" },
  stopped: { tone: "muted", short: "stopped", badge: "stopped", state: "Stopped" },
};
