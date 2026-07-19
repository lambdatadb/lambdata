import type { TailscaleStatus } from "@kilndb/shared";

async function run(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const proc = Bun.spawn(["tailscale", ...args], { stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    const code = await proc.exited;
    return { code, stdout, stderr };
  } catch {
    return { code: 127, stdout: "", stderr: "tailscale not found" };
  }
}

export function tailscaleManager(): TailscaleStatus["managedBy"] {
  return process.env.ORG_ENTRYPOINT && process.env.TAILSCALE_STATE_DIR ? "unraid" : null;
}

export async function tailscaleStatus(): Promise<TailscaleStatus> {
  const managedBy = tailscaleManager();
  const ver = await run(["--version"]);
  if (ver.code !== 0) {
    return { installed: false, running: false, hostname: null, tailnetIp: null, managedBy };
  }
  const s = await run(["status", "--json"]);
  if (s.code !== 0) {
    return { installed: true, running: false, hostname: null, tailnetIp: null, managedBy };
  }
  try {
    const data = JSON.parse(s.stdout) as {
      Self?: { HostName?: string; TailscaleIPs?: string[] };
      BackendState?: string;
    };
    const ip = data.Self?.TailscaleIPs?.[0] ?? null;
    return {
      installed: true,
      running: data.BackendState === "Running",
      hostname: data.Self?.HostName ?? null,
      tailnetIp: ip,
      managedBy,
    };
  } catch {
    return { installed: true, running: false, hostname: null, tailnetIp: null, managedBy };
  }
}

export async function tailscaleUp(authKey?: string): Promise<{ ok: boolean; error?: string }> {
  const args = ["up"];
  if (authKey) args.push(`--auth-key=${authKey}`);
  const r = await run(args);
  return r.code === 0 ? { ok: true } : { ok: false, error: r.stderr || r.stdout };
}

export async function tailscaleDown(): Promise<{ ok: boolean; error?: string }> {
  const r = await run(["down"]);
  return r.code === 0 ? { ok: true } : { ok: false, error: r.stderr || r.stdout };
}
