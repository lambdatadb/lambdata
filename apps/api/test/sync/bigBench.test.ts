import { exec, makeDatabase, mariadbAvailable, rootQuery, setup, type Fixture } from "../checkpoints/helpers";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { SyncChangeSummary } from "@lambdata/shared";
import { env } from "../../src/env";
import { syncJobs } from "../../src/db/queries";
import { encryptSecret } from "../../src/util/crypto";
import { newId } from "../../src/util/id";
import { runSync } from "../../src/workers/sync";
import type { JobContext } from "../../src/jobs";

const TABLES = Number(process.env.LAMBDATA_SYNC_BENCH_TABLES ?? 4);
const ROWS = Number(process.env.LAMBDATA_SYNC_BENCH_ROWS ?? 500_000);
const enabled = mariadbAvailable() && process.env.LAMBDATA_SYNC_DIFF_BIG_BENCH === "1";

function recorder(): { ctx: JobContext; phases(): string } {
  const marks: { label: string; at: number }[] = [];
  const ctx: JobContext = {
    jobId: newId("job"),
    databaseId: null,
    stage(label) {
      marks.push({ label, at: performance.now() });
    },
    progress() {},
    warn() {},
  };
  return {
    ctx,
    phases() {
      const end = performance.now();
      const merged = new Map<string, number>();
      marks.forEach((m, i) => {
        const key = m.label.replace(/\d+ table\(s\)/, "N table(s)").replace(/[0-9a-f]{7}$/, "").slice(0, 60);
        merged.set(key, (merged.get(key) ?? 0) + ((marks[i + 1]?.at ?? end) - m.at));
      });
      const total = end - (marks[0]?.at ?? end);
      return [...merged].map(([k, ms]) => `    ${(ms / 1000).toFixed(2).padStart(7)} s  ${k}`).join("\n") + `\n    ${(total / 1000).toFixed(2).padStart(7)} s  total`;
    },
  };
}

describe.skipIf(!enabled)("sync cost on a few gigabytes", () => {
  let fx: Fixture;
  let source: Awaited<ReturnType<typeof makeDatabase>>;

  beforeAll(async () => {
    fx = await setup();
    source = await makeDatabase(fx.owner);
    for (let i = 1; i <= TABLES; i++) {
      await exec(source.database.name, `CREATE TABLE t${i} (id INT PRIMARY KEY, payload VARCHAR(1000) NOT NULL, n INT NOT NULL) ENGINE=InnoDB`);
      for (let start = 0; start < ROWS; start += 100_000) {
        await exec(
          source.database.name,
          `INSERT INTO t${i} SELECT seq, RPAD(CONCAT(seq, '-', ${i}), 1000, SHA2(seq, 256)), seq FROM seq_${start + 1}_to_${Math.min(ROWS, start + 100_000)}`,
        );
      }
    }
    for (let i = 1; i <= TABLES; i++) await rootQuery(`ANALYZE TABLE \`${source.database.name}\`.t${i}`);
    const [size] = await rootQuery<{ mb: number }>(
      "SELECT ROUND(SUM(DATA_LENGTH + INDEX_LENGTH) / 1048576) AS mb FROM information_schema.TABLES WHERE TABLE_SCHEMA = ?",
      [source.database.name],
    );
    console.log(`[big-bench] source: ${TABLES} tables x ${ROWS} rows, ${size!.mb} MB`);
  }, 3_600_000);

  afterAll(async () => {
    await fx?.instance.stop();
  }, 300_000);

  for (const versioned of [false, true]) {
    test(`${versioned ? "versioned" : "unversioned"} mirror`, async () => {
      const mirror = await makeDatabase(fx.owner, { kind: "mirror", versioned });
      syncJobs.upsert({
        id: newId("sj"),
        databaseId: mirror.database.id,
        sourceKind: "mysql",
        sourceHost: "127.0.0.1",
        sourcePort: env.mariadbPort,
        sourceUser: source.credentials.user,
        passwordEnc: await encryptSecret(source.credentials.password),
        sourceDatabase: source.database.name,
        intervalSeconds: 3600,
        enabled: false,
      });
      const run = async (label: string): Promise<SyncChangeSummary | null> => {
        const r = recorder();
        const result = await runSync(mirror.database.id, r.ctx);
        const c = result.changes;
        console.log(
          `[big-bench] ${versioned ? "versioned" : "unversioned"} ${label}: changed ${c?.tablesChanged ?? "?"}, unchanged ${c?.tablesUnchanged ?? "?"}, not compared ${c?.tablesNotCompared ?? 0}\n${r.phases()}`,
        );
        return c;
      };
      await run("first sync");
      await exec(
        source.database.name,
        "UPDATE t2 SET n = n + 1 WHERE id % 100 = 0",
        `DELETE FROM t2 WHERE id % 500 = ${versioned ? 2 : 1}`,
        `INSERT INTO t2 SELECT ${ROWS + (versioned ? 10_000 : 0)} + seq, 'new', 0 FROM seq_1_to_1000`,
      );
      const changed = await run("one table changed");
      expect(changed!.tablesChanged).toBe(1);
      const quiet = await run("nothing changed");
      expect(quiet!.tablesChanged).toBe(0);
    }, 3_600_000);
  }
});
