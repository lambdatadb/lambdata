import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { authHeaders, seedUser, useTempMetadata, type SeededUser, type TempMetadata } from "../harness/sqlite";
import { testRoot } from "../harness/isolate";
import { buildApp } from "../../src/server";
import { pointerPathInUse } from "../../src/util/pointer";

const POINTER_MODULE = resolve(import.meta.dir, "../../src/util/pointer.ts");
const DAY_MS = 24 * 60 * 60 * 1000;

let md: TempMetadata;
let app: ReturnType<typeof buildApp>;
let viewer: SeededUser;

beforeAll(() => {
  md = useTempMetadata();
  app = buildApp();
  viewer = seedUser("viewer");
});

afterAll(() => md.cleanup());

function writePointerFile(dir: string, dataDir: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "config.json"), JSON.stringify({ dataDir }));
}

async function pointerInUse(home: string): Promise<{ inUse: string; read: string | null }> {
  const script = `const m = await import(${JSON.stringify(POINTER_MODULE)}); console.log(JSON.stringify({ inUse: m.pointerPathInUse(), read: m.readPointer() }));`;
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && !k.endsWith("POINTER_DIR")) env[k] = v;
  }
  env.HOME = home;
  const proc = Bun.spawn([process.execPath, "-e", script], { env, stdout: "pipe", stderr: "pipe" });
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  return JSON.parse(out.trim()) as { inUse: string; read: string | null };
}

describe("settings report the pointer file actually in use", () => {
  test("an install still on the legacy ~/.kilndb pointer reports that file", async () => {
    const home = mkdtempSync(join(testRoot(), "home-legacy-"));
    writePointerFile(join(home, ".kilndb"), "/legacy/data");
    expect(await pointerInUse(home)).toEqual({ inUse: join(home, ".kilndb", "config.json"), read: "/legacy/data" });
  });

  test("once the new pointer exists it wins, and with neither the new location is reported", async () => {
    const both = mkdtempSync(join(testRoot(), "home-both-"));
    writePointerFile(join(both, ".kilndb"), "/legacy/data");
    writePointerFile(join(both, ".lambdata"), "/new/data");
    expect(await pointerInUse(both)).toEqual({ inUse: join(both, ".lambdata", "config.json"), read: "/new/data" });
    const none = mkdtempSync(join(testRoot(), "home-none-"));
    expect(await pointerInUse(none)).toEqual({ inUse: join(none, ".lambdata", "config.json"), read: null });
  });

  test("GET /api/settings uses it", async () => {
    const res = await app.request("/api/settings", { headers: await authHeaders(viewer) });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { pointerPath: string }).pointerPath).toBe(pointerPathInUse());
  });
});

describe("dashboard ranges", () => {
  test("vitals accept the same ranges as metrics and fall back to 30 days for anything else", async () => {
    const cases: [string, number][] = [
      ["1d", DAY_MS],
      ["7d", 7 * DAY_MS],
      ["15d", 15 * DAY_MS],
      ["24h", DAY_MS],
      ["constructor", 30 * DAY_MS],
      ["toString", 30 * DAY_MS],
      ["__proto__", 30 * DAY_MS],
      ["bogus", 30 * DAY_MS],
    ];
    for (const [range, ms] of cases) {
      const res = await app.request(`/api/dashboard/vitals?range=${range}`, { headers: await authHeaders(viewer) });
      expect(res.status).toBe(200);
      expect({ range, rangeMs: ((await res.json()) as { rangeMs: unknown }).rangeMs }).toEqual({ range, rangeMs: ms });
    }
  });
});
