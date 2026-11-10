import { testRoot } from "../harness/isolate";
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync } from "node:fs";
import { join, resolve } from "node:path";
import { FakeDestination, until } from "./helpers";

const API_DIR = resolve(import.meta.dir, "../..");
const SEED = join(import.meta.dir, "fixtures", "seedPending.ts");

describe("pending deliveries across a real process restart", () => {
  test("deliveries queued by one process are sent by the next API process", async () => {
    const root = mkdtempSync(join(testRoot(), "nr-"));
    const home = join(root, "home");
    const dataDir = join(root, "data");
    mkdirSync(home, { recursive: true, mode: 0o700 });
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    const fake = new FakeDestination(4368);
    const env: Record<string, string> = {
      ...(process.env as Record<string, string>),
      HOME: home,
      LAMBDATA_DATA_DIR: dataDir,
      LAMBDATA_POINTER_DIR: join(home, ".lambdata"),
      LAMBDATA_TAILSCALE_BIN: "/nonexistent/tailscale",
      LAMBDATA_CLOUDFLARED_BIN: "/nonexistent/cloudflared",
      PORT: "4361",
      LAMBDATA_MARIADB_PORT: "3361",
    };
    let api: ReturnType<typeof Bun.spawn> | null = null;
    let output: Promise<string> = Promise.resolve("");
    try {
      const seed = Bun.spawn([process.execPath, "run", SEED, fake.url("/after-restart")], { cwd: API_DIR, env, stdout: "pipe", stderr: "pipe" });
      const seedErr = new Response(seed.stderr).text();
      expect(await seed.exited, await seedErr).toBe(0);
      expect(fake.requests).toHaveLength(0);
      api = Bun.spawn([process.execPath, "run", "src/index.ts"], { cwd: API_DIR, env, stdout: "pipe", stderr: "pipe" });
      const out = new Response(api.stdout as ReadableStream).text();
      const err = new Response(api.stderr as ReadableStream).text();
      output = Promise.all([out, err]).then(([a, b]) => `${a}\n${b}`);
      await until(() => fake.requests.length >= 2, 30_000, "deliveries after restart");
      expect(fake.requests.map((r) => (JSON.parse(r.body) as { title: string }).title)).toEqual([
        "Queued before restart 1",
        "Queued before restart 2",
      ]);
      expect(fake.requests[0]!.headers["x-lambdata-delivery"]).toBe("ndl_restart_1");
      expect(fake.requests[0]!.headers["x-lambdata-signature"]).toMatch(/^sha256=[0-9a-f]{64}$/);
    } finally {
      if (api) {
        api.kill("SIGTERM");
        const exited = await Promise.race([api.exited.then(() => true), Bun.sleep(10_000).then(() => false)]);
        if (!exited) api.kill("SIGKILL");
        await api.exited;
      }
      fake.stop();
    }
    const log = await output;
    expect(log).not.toContain("restart-secret");
    expect(log).not.toContain("/after-restart");
  }, 60_000);
});
