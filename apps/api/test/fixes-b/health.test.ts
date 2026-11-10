import { mariadbAvailable, startTestInstance, type TestInstance } from "../harness/instance";
import { authHeaders, seedUser, type SeededUser } from "../harness/sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { buildApp } from "../../src/server";
import { provisionDatabase } from "../../src/databases/provision";
import { mariadbServerPid } from "../../src/mariadb/controller";
import { healthLimits } from "../../src/util/mariadbHealth";

describe.skipIf(!mariadbAvailable())("health checks against a frozen MariaDB", () => {
  let instance: TestInstance | null = null;
  let app: ReturnType<typeof buildApp>;
  let admin: SeededUser;

  beforeAll(async () => {
    instance = await startTestInstance();
    app = buildApp();
    admin = seedUser("admin");
  }, 180_000);

  afterAll(async () => {
    await instance?.stop();
  }, 60_000);

  async function timed(path: string, headers: Record<string, string> = {}) {
    const started = Date.now();
    const res = await app.request(path, { headers });
    return { status: res.status, body: (await res.json()) as Record<string, unknown>, ms: Date.now() - started };
  }

  test("a stopped mariadbd gets a 503 within the bound instead of a hang, and recovers when it resumes", async () => {
    const { database } = await provisionDatabase({ displayName: "Frozen Shop", ownerUserId: admin.id });
    const auth = await authHeaders(admin);
    expect((await timed("/api/health")).status).toBe(200);
    expect((await timed(`/api/databases/${database.id}/tables`, auth)).status).toBe(200);
    const pid = mariadbServerPid();
    expect(pid).not.toBeNull();
    process.kill(pid!, "SIGSTOP");
    try {
      const plain = await timed("/api/health");
      expect(plain.status).toBe(503);
      expect(plain.body).toEqual({ ok: false, mariadb: "not-responding" });
      expect(plain.ms).toBeLessThan(healthLimits.timeoutMs + 1500);
      const [a, b] = await Promise.all([timed("/api/health"), timed("/api/health")]);
      expect([a.status, b.status]).toEqual([503, 503]);
      const detail = await timed("/api/health/detail", await authHeaders(admin));
      expect(detail.status).toBe(200);
      expect(detail.ms).toBeLessThan(healthLimits.timeoutMs + 1500);
      expect(detail.body.ok).toBe(false);
      expect(detail.body.mariadb).toMatchObject({
        ok: false,
        state: "running",
        error: "MariaDB did not answer within 2 seconds; it may be frozen or overloaded",
      });
      const bound = healthLimits.timeoutMs + 1500;
      const summary = await timed("/api/dashboard/summary", auth);
      expect(summary.status).toBe(200);
      expect(summary.ms).toBeLessThan(bound);
      expect(summary.body).toMatchObject({ databases: { total: 1 }, system: { mariadbOk: false } });
      const tables = await timed(`/api/databases/${database.id}/tables`, auth);
      expect(tables.status).toBe(503);
      expect(tables.ms).toBeLessThan(bound);
      expect(tables.body.error).toBe("MariaDB did not answer within 2 seconds; it may be frozen or overloaded");
      const access = await timed("/api/data-access", auth);
      expect(access.status).toBe(200);
      expect(access.ms).toBeLessThan(bound);
      for (const path of ["/api/dashboard/vitals?range=24h", `/api/databases/${database.id}/metrics?range=24h`, "/api/jobs?limit=8", "/api/system/audit-logs?limit=20", "/api/network/status", "/api/tailscale/status", "/api/realtime/status"]) {
        const polled = await timed(path, auth);
        expect({ path, status: polled.status, fast: polled.ms < bound }).toEqual({ path, status: 200, fast: true });
      }
    } finally {
      process.kill(pid!, "SIGCONT");
    }
    const deadline = Date.now() + 20_000;
    let status = 0;
    while (Date.now() < deadline) {
      status = (await timed("/api/health")).status;
      if (status === 200) break;
      await Bun.sleep(200);
    }
    expect(status).toBe(200);
    expect((await timed("/api/dashboard/summary", auth)).body).toMatchObject({ system: { mariadbOk: true } });
    expect((await timed(`/api/databases/${database.id}/tables`, auth)).status).toBe(200);
  }, 120_000);
});
