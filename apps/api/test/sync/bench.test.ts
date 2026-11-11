import { mariadbAvailable, rootQuery, startTestInstance, type TestInstance } from "../harness/instance";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { measureSyncChanges } from "../../src/sync/changes";

const ROWS = 500_000;
const enabled = mariadbAvailable() && process.env.LAMBDATA_SYNC_DIFF_BENCH === "1";

describe.skipIf(!enabled)("row comparison timing", () => {
  let instance: TestInstance;
  const live = `rc_bench_live_${process.pid}`;
  const staging = `rc_bench_stage_${process.pid}`;

  beforeAll(async () => {
    instance = await startTestInstance();
    for (const schema of [live, staging]) {
      await rootQuery(`CREATE DATABASE \`${schema}\``);
      await rootQuery(
        `CREATE TABLE \`${schema}\`.players (id INT PRIMARY KEY, name VARCHAR(64) NOT NULL, bio TEXT NULL, score DOUBLE NULL, seen DATETIME(3) NULL) ENGINE=InnoDB`,
      );
      await rootQuery(
        `INSERT INTO \`${schema}\`.players SELECT seq, CONCAT('player-', seq), IF(seq % 3 = 0, NULL, REPEAT('x', 40 + seq % 50)), seq * 1.5, '2026-01-01 00:00:00.000' FROM \`${schema}\`.seq_1_to_${ROWS}`,
      );
    }
    await rootQuery(`UPDATE \`${staging}\`.players SET score = -1 WHERE id % 1000 = 0`);
    await rootQuery(`DELETE FROM \`${staging}\`.players WHERE id % 5000 = 1`);
    await rootQuery(`INSERT INTO \`${staging}\`.players SELECT ${ROWS} + seq, 'new', NULL, NULL, NULL FROM \`${staging}\`.seq_1_to_250`);
  }, 600_000);

  afterAll(async () => {
    await rootQuery(`DROP DATABASE IF EXISTS \`${live}\``).catch(() => {});
    await rootQuery(`DROP DATABASE IF EXISTS \`${staging}\``).catch(() => {});
    await instance?.stop();
  }, 120_000);

  test("half a million rows", async () => {
    const timings: number[] = [];
    let summary = null;
    for (let i = 0; i < 3; i++) {
      const started = performance.now();
      summary = await measureSyncChanges(live, staging, { limits: { maxRows: 2_000_000, maxSeconds: 30 } });
      timings.push(Math.round(performance.now() - started));
    }
    const checksumStarted = performance.now();
    await rootQuery(`CHECKSUM TABLE \`${staging}\`.players`);
    const checksumMs = Math.round(performance.now() - checksumStarted);
    console.log(`[bench] exact comparison of ${ROWS} rows: ${timings.join(" ms, ")} ms; one CHECKSUM TABLE: ${checksumMs} ms`);
    expect(summary!.tables[0]).toMatchObject({ method: "exact", added: 250, removed: 100, changed: 500 });
  }, 600_000);
});
