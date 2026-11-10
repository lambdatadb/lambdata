import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface UpgradeOutcome {
  ran: boolean;
  from: string | null;
  to: string;
  summary: string;
}

const MARKER_FILES = ["mariadb_upgrade_info", "mysql_upgrade_info"];
const UPGRADE_TIMEOUT_MS = 30 * 60 * 1000;
const CHILD_ENV_KEYS = ["PATH", "LANG", "LC_ALL", "LC_CTYPE", "TZ", "TMPDIR"];

export function parseVersion(text: string | null | undefined): [number, number, number] | null {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(text ?? "");
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

export function compareVersions(a: [number, number, number], b: [number, number, number]): number {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i]! - b[i]!;
  return 0;
}

export function readUpgradeMarker(datadir: string): string | null {
  for (const name of MARKER_FILES) {
    const path = join(datadir, name);
    if (!existsSync(path)) continue;
    try {
      return readFileSync(path, "utf8").replace(/\u0000/g, "").trim() || null;
    } catch {
      continue;
    }
  }
  return null;
}

function optionValue(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("\n", "\\n")}"`;
}

function childEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of CHILD_ENV_KEYS) {
    const v = process.env[key];
    if (v) out[key] = v;
  }
  return out;
}

function summarize(output: string, password: string): string {
  const lines = output
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => (password ? l.replaceAll(password, "***") : l));
  const picked = lines.filter((l) => /error|warning|upgraded|phase|already/i.test(l)).slice(-6);
  const text = (picked.length > 0 ? picked : lines.slice(-4)).join(" | ");
  return text.length > 1500 ? `${text.slice(0, 1500)}...` : text;
}

export async function upgradeDataDirIfNeeded(p: {
  bin: string | null;
  datadir: string;
  serverVersion: string;
  host: string;
  port: number;
  user: string;
  password: string;
  timeoutMs?: number;
}): Promise<UpgradeOutcome> {
  const marker = readUpgradeMarker(p.datadir);
  const server = parseVersion(p.serverVersion);
  const recorded = parseVersion(marker);
  const to = server ? server.join(".") : p.serverVersion;
  const from = recorded ? recorded.join(".") : null;
  if (!server) return { ran: false, from, to, summary: `could not read the server version (${p.serverVersion})` };
  if (recorded && compareVersions(server, recorded) === 0) return { ran: false, from, to, summary: "data directory is current" };
  if (recorded && compareVersions(server, recorded) < 0) {
    return {
      ran: false,
      from,
      to,
      summary: `the data directory was last upgraded by MariaDB ${from}, which is newer than this server (${to}); MariaDB does not support running an older server on it`,
    };
  }
  if (!p.bin) return { ran: false, from, to, summary: "mariadb-upgrade is not installed, so the system tables were not upgraded" };
  const dir = mkdtempSync(join(tmpdir(), "ld-upg-"));
  const cnf = join(dir, "client.cnf");
  try {
    writeFileSync(
      cnf,
      [
        "[client]",
        `host=${optionValue(p.host)}`,
        `port=${p.port}`,
        `user=${optionValue(p.user)}`,
        `password=${optionValue(p.password)}`,
        "protocol=TCP",
        "skip-ssl",
        "",
      ].join("\n"),
      { mode: 0o600, flag: "wx" },
    );
    const proc = Bun.spawn([p.bin, `--defaults-extra-file=${cnf}`], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      env: childEnv(),
    });
    const timer = setTimeout(() => proc.kill("SIGKILL"), p.timeoutMs ?? UPGRADE_TIMEOUT_MS);
    try {
      const [exit, out, err] = await Promise.all([
        proc.exited,
        new Response(proc.stdout as ReadableStream<Uint8Array>).text(),
        new Response(proc.stderr as ReadableStream<Uint8Array>).text(),
      ]);
      const summary = summarize(`${out}\n${err}`, p.password);
      if (exit !== 0) throw new Error(`mariadb-upgrade failed (exit ${exit})${summary ? `: ${summary}` : ""}`);
      return { ran: true, from, to, summary };
    } finally {
      clearTimeout(timer);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
