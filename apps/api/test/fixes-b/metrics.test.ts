import { mariadbAvailable, startTestInstance, type TestInstance } from "../harness/instance";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { authHeaders, seedUser, type SeededUser } from "../harness/sqlite";
import { db } from "../../src/db/client";
import { provisionDatabase } from "../../src/databases/provision";
import { buildApp } from "../../src/server";
import { RANGE_MS, rangeMsFor } from "../../src/routes/metrics";
import {
  MIN_REFRESH_INTERVAL_MS,
  collectAllMetrics,
  exactCount,
  refreshStaleMetrics,
  requestFreshMetrics,
} from "../../src/workers/metrics";

describe("metric values", () => {
  test("only exact non-negative integers are stored", () => {
    expect(exactCount(0)).toBe(0);
    expect(exactCount(Number.MAX_SAFE_INTEGER)).toBe(Number.MAX_SAFE_INTEGER);
    expect(exactCount(2 ** 53)).toBeNull();
    expect(exactCount(Number("76561198000000008"))).toBeNull();
    expect(exactCount(-1)).toBeNull();
    expect(exactCount(1.5)).toBeNull();
    expect(exactCount(null)).toBeNull();
  });

  test("ranges are shared and ignore inherited keys", () => {
    expect(rangeMsFor("7d", "24h")).toBe(RANGE_MS["7d"]!);
    expect(rangeMsFor("15d", "30d")).toBe(15 * 24 * 60 * 60 * 1000);
    expect(rangeMsFor("toString", "24h")).toBe(RANGE_MS["24h"]!);
    expect(rangeMsFor(undefined, "30d")).toBe(RANGE_MS["30d"]!);
  });
});

describe.skipIf(!mariadbAvailable())("metric refresh", () => {
  let instance: TestInstance;
  let admin: SeededUser;
  let viewer: SeededUser;
  let ids: string[];

  function counts(): number[] {
    return ids.map((id) => (db.query("SELECT COUNT(*) AS n FROM metrics WHERE database_id = ?").get(id) as { n: number }).n);
  }

  beforeAll(async () => {
    instance = await startTestInstance();
    admin = seedUser("admin");
    viewer = seedUser("viewer");
    const stamp = Date.now().toString(36);
    ids = [];
    for (const label of ["a", "b"]) {
      const { database } = await provisionDatabase({ displayName: `fixes b metrics ${label} ${stamp}`, ownerUserId: admin.id });
      ids.push(database.id);
    }
    await collectAllMetrics();
    db.query(`DELETE FROM metrics WHERE database_id IN (?, ?)`).run(ids[0]!, ids[1]!);
  }, 180_000);

  afterAll(async () => {
    await instance?.stop();
  }, 120_000);

  test("a dashboard refresh right after a collection does nothing", async () => {
    await collectAllMetrics();
    expect(counts()).toEqual([1, 1]);
    await requestFreshMetrics();
    await requestFreshMetrics(0);
    expect(counts()).toEqual([1, 1]);
  }, 60_000);

  test("overlapping requests share one collection", async () => {
    const before = counts();
    await Promise.all([
      collectAllMetrics(),
      collectAllMetrics(),
      refreshStaleMetrics(0),
      requestFreshMetrics(),
      requestFreshMetrics(),
    ]);
    expect(counts()).toEqual(before.map((n) => n + 1));
  }, 60_000);

  test("a refresh only collects databases whose latest sample is stale", async () => {
    db.query("UPDATE metrics SET collected_at = collected_at - 600000 WHERE database_id = ?").run(ids[0]!);
    const before = counts();
    await refreshStaleMetrics(MIN_REFRESH_INTERVAL_MS);
    expect(counts()).toEqual([before[0]! + 1, before[1]!]);
  }, 60_000);

  test("viewers hitting the dashboard do not trigger extra collections", async () => {
    const app = buildApp();
    await collectAllMetrics();
    const before = counts();
    const headers = await authHeaders(viewer);
    await Promise.all(
      Array.from({ length: 10 }, (_, i) => app.request(i % 2 ? "/api/dashboard/vitals" : "/api/dashboard/summary", { headers })),
    );
    await requestFreshMetrics();
    expect(counts()).toEqual(before);
  }, 60_000);
});
