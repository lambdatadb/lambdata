import { accessSync, constants, existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const WATCHDOG_SCRIPT = `
trap '' INT TERM HUP
while kill -0 "$1" 2>/dev/null; do sleep 1; done
find "$2" -path '*/mariadb/*.pid' -type f 2>/dev/null | while read -r f; do kill -9 "$(cat "$f")" 2>/dev/null; done
pkill -9 -f -- "--datadir=$2/" 2>/dev/null
sleep 1
rm -rf "$2"
`;

function shortTmpBase(): string {
  const override = process.env.LAMBDATA_TEST_TMPDIR;
  if (override) return override;
  try {
    accessSync("/tmp", constants.W_OK);
    return "/tmp";
  } catch {
    return tmpdir();
  }
}

function startWatchdog(root: string): void {
  const proc = Bun.spawn(["/bin/sh", "-c", WATCHDOG_SCRIPT, "watchdog", String(process.pid), root], {
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
  });
  proc.unref();
}

function establish(): void {
  const root = mkdtempSync(join(shortTmpBase(), "ld-test-"));
  const home = join(root, "home");
  const tmp = join(root, "tmp");
  mkdirSync(home, { recursive: true, mode: 0o700 });
  mkdirSync(tmp, { recursive: true, mode: 0o700 });
  process.env.LAMBDATA_TEST_REAL_HOME = process.env.HOME ?? "";
  process.env.HOME = home;
  process.env.TMPDIR = tmp;
  process.env.LAMBDATA_POINTER_DIR = join(home, ".lambdata");
  process.env.LAMBDATA_DATA_DIR = join(root, "data");
  process.env.LAMBDATA_TAILSCALE_BIN = join(root, "absent", "tailscale");
  process.env.LAMBDATA_CLOUDFLARED_BIN = join(root, "absent", "cloudflared");
  delete process.env.KILNDB_DATA_DIR;
  delete process.env.KILNDB_POINTER_DIR;
  delete process.env.KILNDB_TAILSCALE_BIN;
  delete process.env.KILNDB_CLOUDFLARED_BIN;
  process.env.LAMBDATA_TEST_ROOT = root;
  process.env.LAMBDATA_TEST_ISOLATED = "1";
  startWatchdog(root);
  process.on("exit", cleanupTestRoot);
}

const inherited = process.env.LAMBDATA_TEST_ROOT;
if (process.env.LAMBDATA_TEST_ISOLATED !== "1" || !inherited || !existsSync(inherited)) establish();

export function testRoot(): string {
  const root = process.env.LAMBDATA_TEST_ROOT;
  if (!root) throw new Error("test isolation did not run");
  return root;
}

export function bootDataDir(): string {
  const dir = process.env.LAMBDATA_DATA_DIR;
  if (!dir) throw new Error("test isolation did not run");
  return dir;
}

export function isInsideTestRoot(path: string): boolean {
  return resolve(path).startsWith(`${resolve(testRoot())}/`);
}

export function cleanupTestRoot(): void {
  const root = process.env.LAMBDATA_TEST_ROOT;
  if (root) rmSync(root, { recursive: true, force: true });
}
