import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { testRoot } from "../harness/isolate";
import { findProcesses, processCommand, procfs } from "../../src/util/processes";

const realRoot = procfs.root;

afterEach(() => {
  procfs.root = realRoot;
});

function fakeProc(entries: Record<string, string | null>): string {
  mkdirSync(testRoot(), { recursive: true });
  const root = mkdtempSync(join(testRoot(), "proc-"));
  mkdirSync(join(root, "self"));
  for (const [name, cmdline] of Object.entries(entries)) {
    mkdirSync(join(root, name));
    if (cmdline !== null) writeFileSync(join(root, name, "cmdline"), cmdline);
  }
  return root;
}

describe("process lookups", () => {
  test("on Linux they read /proc and need neither ps nor pgrep", () => {
    const root = fakeProc({
      "120": "sleep\u0000987.25\u0000",
      "121": "/usr/bin/cloudflared\u0000tunnel\u0000run\u0000",
      "122": "",
      "123": null,
      net: "sleep\u0000987.25\u0000",
      [String(process.pid)]: "bun\u0000test\u0000sleep 987.25\u0000",
    });
    const path = process.env.PATH;
    procfs.root = root;
    process.env.PATH = "/nonexistent";
    try {
      expect(findProcesses("sleep 987.25")).toEqual([120]);
      expect(findProcesses("cloudflared")).toEqual([121]);
      expect(findProcesses("nothing like this")).toEqual([]);
      expect(processCommand(120)).toBe("sleep 987.25");
      expect(processCommand(121)).toBe("/usr/bin/cloudflared tunnel run");
      expect(processCommand(122)).toBeNull();
      expect(processCommand(123)).toBeNull();
      expect(processCommand(999)).toBeNull();
    } finally {
      process.env.PATH = path;
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("they find a real process and stop finding it once it is gone", async () => {
    const child = Bun.spawn(["sleep", "654.25"], { stdout: "ignore", stderr: "ignore" });
    try {
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline && !findProcesses("sleep 654.25").includes(child.pid)) await Bun.sleep(20);
      expect(findProcesses("sleep 654.25")).toContain(child.pid);
      expect(processCommand(child.pid)).toContain("654.25");
    } finally {
      child.kill("SIGKILL");
      await child.exited;
    }
    expect(findProcesses("sleep 654.25")).not.toContain(child.pid);
  });
});
