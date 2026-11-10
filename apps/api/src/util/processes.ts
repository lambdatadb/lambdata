import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const procfs = { root: "/proc" };

function procAvailable(root: string): boolean {
  return existsSync(join(root, "self")) || existsSync(join(root, "1"));
}

function readCmdline(root: string, pid: number): string | null {
  try {
    const raw = readFileSync(join(root, String(pid), "cmdline"), "utf8");
    const command = raw.split("\0").filter(Boolean).join(" ");
    return command || null;
  } catch {
    return null;
  }
}

function runTool(argv: string[]): string | null {
  try {
    const r = Bun.spawnSync(argv, { stdout: "pipe", stderr: "ignore" });
    return r.exitCode === 0 ? r.stdout.toString() : null;
  } catch {
    return null;
  }
}

export function processCommand(pid: number): string | null {
  const root = procfs.root;
  if (procAvailable(root)) return readCmdline(root, pid);
  const out = runTool(["ps", "-ww", "-o", "command=", "-p", String(pid)])?.trim();
  return out ? out : null;
}

export function findProcesses(fragment: string): number[] {
  const root = procfs.root;
  if (procAvailable(root)) {
    const found: number[] = [];
    let names: string[];
    try {
      names = readdirSync(root);
    } catch {
      return [];
    }
    for (const name of names) {
      if (!/^\d+$/.test(name)) continue;
      const pid = Number(name);
      if (pid === process.pid) continue;
      const command = readCmdline(root, pid);
      if (command !== null && command.includes(fragment)) found.push(pid);
    }
    return found.sort((a, b) => a - b);
  }
  const out = runTool(["pgrep", "-f", "--", fragment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")]);
  if (!out) return [];
  return out
    .split("\n")
    .map((l) => Number(l.trim()))
    .filter((n) => Number.isInteger(n) && n > 0 && n !== process.pid);
}
