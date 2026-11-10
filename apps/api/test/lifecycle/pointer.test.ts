import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { testRoot } from "../harness/isolate";

const POINTER_MODULE = resolve(import.meta.dir, "../../src/util/pointer.ts");
const dirs: string[] = [];

afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

async function probe(env: Record<string, string>): Promise<{ path: string; pointer: string | null }> {
  const script = `const m = await import(${JSON.stringify(POINTER_MODULE)}); console.log(JSON.stringify({ path: m.POINTER_PATH, pointer: m.readPointer() }));`;
  const base: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && !k.endsWith("POINTER_DIR")) base[k] = v;
  }
  const proc = Bun.spawn([process.execPath, "-e", script], { env: { ...base, ...env }, stdout: "pipe", stderr: "pipe" });
  const out = await new Response(proc.stdout).text();
  expect(await proc.exited).toBe(0);
  return JSON.parse(out.trim()) as { path: string; pointer: string | null };
}

function writeLegacyPointer(home: string, dataDir: string): void {
  mkdirSync(join(home, ".kilndb"), { recursive: true });
  writeFileSync(join(home, ".kilndb", "config.json"), JSON.stringify({ dataDir }));
}

describe("data-dir pointer location", () => {
  test("defaults to ~/.lambdata and still reads the legacy ~/.kilndb pointer", async () => {
    const home = mkdtempSync(join(testRoot(), "ptr-home-"));
    dirs.push(home);
    writeLegacyPointer(home, "/legacy/data");
    const res = await probe({ HOME: home });
    expect(res.path).toBe(join(home, ".lambdata", "config.json"));
    expect(res.pointer).toBe("/legacy/data");
  });

  test("LAMBDATA_POINTER_DIR overrides the location and skips the legacy fallback", async () => {
    const home = mkdtempSync(join(testRoot(), "ptr-home-"));
    const override = mkdtempSync(join(testRoot(), "ptr-dir-"));
    dirs.push(home, override);
    writeLegacyPointer(home, "/legacy/data");
    const empty = await probe({ HOME: home, LAMBDATA_POINTER_DIR: override });
    expect(empty).toEqual({ path: join(override, "config.json"), pointer: null });
    writeFileSync(join(override, "config.json"), JSON.stringify({ dataDir: "/override/data" }));
    expect((await probe({ HOME: home, LAMBDATA_POINTER_DIR: override })).pointer).toBe("/override/data");
  });

  test("the legacy KILNDB_POINTER_DIR name works too", async () => {
    const override = mkdtempSync(join(testRoot(), "ptr-legacy-"));
    dirs.push(override);
    const res = await probe({ KILNDB_POINTER_DIR: override });
    expect(res.path).toBe(join(override, "config.json"));
  });
});
