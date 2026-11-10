import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

type Proc = ReturnType<typeof Bun.spawn>;

export interface StackOptions {
  repo: string;
  root: string;
  apiPort: number;
  dbPort: number;
  webPort: number;
}

export interface Stack {
  apiUrl: string;
  webUrl: string;
  dataDir: string;
  logDir: string;
  bootedAt: number;
  stop: () => Promise<void>;
}

const MARKER = ".lambdata-visual";

export async function readSetupToken(logDir: string, timeoutMs = 15_000): Promise<string> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const log = existsSync(join(logDir, "api.log")) ? readFileSync(join(logDir, "api.log"), "utf8") : "";
    const matches = [...log.matchAll(/first-run setup token:\s+(\S+)/g)];
    const token = matches.at(-1)?.[1];
    if (token) return token;
    await Bun.sleep(250);
  }
  throw new Error(`no setup token in ${join(logDir, "api.log")}`);
}

export function prepareRoot(root: string): void {
  if (existsSync(root)) {
    if (!existsSync(join(root, MARKER))) {
      throw new Error(`${root} exists and was not created by this script; pick another VISUAL_ROOT or remove it yourself`);
    }
    rmSync(root, { recursive: true, force: true });
  }
  mkdirSync(join(root, "home"), { recursive: true });
  mkdirSync(join(root, "logs"), { recursive: true });
  writeFileSync(join(root, MARKER), "scratch directory for scripts/visual-test.ts\n");
}

async function waitFor(url: string, label: string, proc: Proc, timeoutMs = 60_000): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (proc.exitCode !== null) throw new Error(`${label} exited with code ${proc.exitCode} before it was ready`);
    try {
      const res = await fetch(url);
      if (res.status < 500) return;
    } catch {
      await Bun.sleep(300);
      continue;
    }
    await Bun.sleep(300);
  }
  throw new Error(`${label} did not answer at ${url} within ${timeoutMs / 1000}s`);
}

function spawnLogged(cmd: string[], cwd: string, env: Record<string, string>, logFile: string): Proc {
  return Bun.spawn(cmd, {
    cwd,
    env: { ...process.env, ...env },
    stdout: Bun.file(logFile),
    stderr: Bun.file(`${logFile}.err`),
  });
}

async function stopProc(proc: Proc | null, graceMs: number): Promise<void> {
  if (!proc || proc.exitCode !== null) return;
  proc.kill("SIGTERM");
  const done = await Promise.race([proc.exited.then(() => true), Bun.sleep(graceMs).then(() => false)]);
  if (!done) {
    proc.kill("SIGKILL");
    await proc.exited;
  }
}

export async function startStack(options: StackOptions): Promise<Stack> {
  const { repo, root, apiPort, dbPort, webPort } = options;
  const logDir = join(root, "logs");
  const dataDir = join(root, "data");
  const apiUrl = `http://127.0.0.1:${apiPort}`;
  const webUrl = `http://127.0.0.1:${webPort}`;
  let api: Proc | null = null;
  let web: Proc | null = null;
  let bootedAt = Date.now();
  const stop = async () => {
    await stopProc(web, 5_000);
    await stopProc(api, 30_000);
  };
  try {
    api = spawnLogged(
      ["bun", "run", "apps/api/src/index.ts"],
      repo,
      {
        HOME: join(root, "home"),
        LAMBDATA_DATA_DIR: join(root, "boot"),
        PORT: String(apiPort),
        LAMBDATA_MARIADB_PORT: String(dbPort),
        LAMBDATA_TAILSCALE_BIN: "/nonexistent/tailscale",
        LAMBDATA_CLOUDFLARED_BIN: "/nonexistent/cloudflared",
      },
      join(logDir, "api.log"),
    );
    await waitFor(`${apiUrl}/api/health`, "API", api);
    bootedAt = Date.now();
    web = spawnLogged(
      ["bunx", "vite", "--host", "127.0.0.1"],
      join(repo, "apps/web"),
      {
        LAMBDATA_API_URL: apiUrl,
        LAMBDATA_WEB_PORT: String(webPort),
        LAMBDATA_VITE_CACHE_DIR: join(root, "vite-cache"),
      },
      join(logDir, "vite.log"),
    );
    await waitFor(webUrl, "Vite", web);
  } catch (error) {
    await stop();
    throw error;
  }
  return { apiUrl, webUrl, dataDir, logDir, bootedAt, stop };
}
