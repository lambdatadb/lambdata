import { mariadbAvailable, startTestInstance, type TestInstance } from "../harness/instance";
import { authHeaders, seedUser, type SeededUser } from "../harness/sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { buildApp } from "../../src/server";
import { createCheckpoint, invalidateWorkingCopyStatus } from "../../src/checkpoints";
import { provisionDatabase } from "../../src/databases/provision";
import { mariadbServerPid } from "../../src/mariadb/controller";
import { healthLimits } from "../../src/util/mariadbHealth";
import { exec } from "./helpers";

const FROZEN = "MariaDB did not answer within 2 seconds; it may be frozen or overloaded";

describe.skipIf(!mariadbAvailable())("checkpoint polls against a frozen MariaDB", () => {
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

  async function timed(path: string, headers: Record<string, string>) {
    const started = Date.now();
    const res = await app.request(path, { headers });
    return { status: res.status, body: (await res.json()) as Record<string, any>, ms: Date.now() - started };
  }

  test("the status poll answers unknown within the bound and the list never waits for MariaDB", async () => {
    const { database } = await provisionDatabase({ displayName: "Frozen History", ownerUserId: admin.id });
    await exec(database.name, "CREATE TABLE t (id INT PRIMARY KEY)", "INSERT INTO t VALUES (1)");
    const cp = (await createCheckpoint(database.id, { trigger: "manual" })).checkpointId!;
    const auth = await authHeaders(admin);
    const base = `/api/databases/${database.id}/checkpoints`;
    expect((await timed(`${base}/status`, auth)).body.status.state).toBe("clean");
    invalidateWorkingCopyStatus(database.id);
    const bound = healthLimits.timeoutMs + 1500;
    const pid = mariadbServerPid();
    expect(pid).not.toBeNull();
    process.kill(pid!, "SIGSTOP");
    try {
      const list = await timed(base, auth);
      expect(list.status).toBe(200);
      expect(list.ms).toBeLessThan(500);
      expect(list.body.checkpoints.map((c: { id: string }) => c.id)).toEqual([cp]);
      const [a, b] = await Promise.all([timed(`${base}/status`, auth), timed(`${base}/status`, auth)]);
      for (const r of [a, b]) {
        expect(r.status).toBe(200);
        expect(r.ms).toBeLessThan(bound);
        expect(r.body.status).toMatchObject({ state: "unknown", reason: FROZEN, baseCheckpointId: cp });
      }
      const refreshed = await timed(`${base}/status?refresh=1`, auth);
      expect(refreshed.ms).toBeLessThan(bound);
      expect(refreshed.body.status).toMatchObject({ state: "unknown", reason: FROZEN });
      const diff = await timed(`${base}/${cp}/diff?against=working`, auth);
      expect(diff.status).toBe(503);
      expect(diff.ms).toBeLessThan(bound);
      expect(diff.body.error).toBe(FROZEN);
      expect((await timed(`${base}/${cp}`, auth)).ms).toBeLessThan(500);
    } finally {
      process.kill(pid!, "SIGCONT");
    }
    const deadline = Date.now() + 20_000;
    let state = "";
    while (Date.now() < deadline) {
      state = (await timed(`${base}/status?refresh=1`, auth)).body.status.state;
      if (state === "clean") break;
      await Bun.sleep(200);
    }
    expect(state).toBe("clean");
  }, 120_000);

  test("a status check that is already running when MariaDB freezes stops waiting", async () => {
    const { database } = await provisionDatabase({ displayName: "Frozen Midway", ownerUserId: admin.id });
    await exec(database.name, "CREATE TABLE big (id INT PRIMARY KEY, pad VARCHAR(200))", "INSERT INTO big SELECT seq, REPEAT('x', 190) FROM seq_1_to_400000");
    await createCheckpoint(database.id, { trigger: "manual" });
    invalidateWorkingCopyStatus(database.id);
    const auth = await authHeaders(admin);
    const pid = mariadbServerPid()!;
    const pending = timed(`/api/databases/${database.id}/checkpoints/status?refresh=1`, auth);
    await Bun.sleep(30);
    process.kill(pid, "SIGSTOP");
    const frozenAt = Date.now();
    try {
      const r = await pending;
      expect(r.status).toBe(200);
      if (r.body.status.state === "unknown") {
        expect(r.body.status.reason).toBe(FROZEN);
        expect(Date.now() - frozenAt).toBeLessThan(2 * healthLimits.timeoutMs + 2500);
      } else {
        expect(r.body.status.state).toBe("clean");
      }
    } finally {
      process.kill(pid, "SIGCONT");
    }
  }, 120_000);
});
