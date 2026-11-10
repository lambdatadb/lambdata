import { registerService } from "../lifecycle";
import { audit } from "../db/queries";
import { decryptSecret } from "../util/crypto";
import { refreshTailscaleRuntime } from "../tailscale/cli";
import {
  OPEN_POLICY,
  loadNetworkConfig,
  policyLockedByEnv,
  samePolicy,
  savePolicy,
} from "./config";
import { setTunnelError, startTunnel, stopTunnel } from "./cloudflared";

const TAILSCALE_REFRESH_MS = 30_000;

let started = false;
let timer: ReturnType<typeof setInterval> | null = null;

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function applyEnvPolicyLock(): boolean {
  if (!policyLockedByEnv()) return false;
  const config = loadNetworkConfig();
  if (samePolicy(config.storedPolicy, OPEN_POLICY)) return false;
  savePolicy({ ...OPEN_POLICY });
  audit.log(null, "network.policy.reset_by_env", null, { from: config.storedPolicy, to: OPEN_POLICY });
  console.log("[network] LAMBDATA_ACCESS_POLICY=open: the access policy was reset to allow every connection");
  return true;
}

export async function autostartTunnel(): Promise<void> {
  const config = loadNetworkConfig();
  if (config.tunnelMode !== "managed" || !config.tunnelAutostart || !config.tunnelTokenEnc) return;
  try {
    await startTunnel(await decryptSecret(config.tunnelTokenEnc));
  } catch (err) {
    setTunnelError(describe(err));
    console.error("[network] cloudflared did not start:", describe(err));
  }
}

function refreshTailscale(): void {
  void refreshTailscaleRuntime().catch(() => undefined);
}

export const networkService = registerService({
  name: "network",
  async start() {
    if (started) return;
    started = true;
    try {
      applyEnvPolicyLock();
    } catch (err) {
      console.error("[network] could not apply LAMBDATA_ACCESS_POLICY:", describe(err));
    }
    refreshTailscale();
    timer = setInterval(refreshTailscale, TAILSCALE_REFRESH_MS);
    await autostartTunnel();
  },
  async stop() {
    started = false;
    if (timer) clearInterval(timer);
    timer = null;
    await stopTunnel();
  },
  running() {
    return started;
  },
});
