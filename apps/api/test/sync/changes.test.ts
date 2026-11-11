import { mariadbAvailable, rootQuery, startTestInstance, type TestInstance } from "../harness/instance";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { SyncChangeSummary, TableRowChange } from "@lambdata/shared";
import { changeBudget, changeLimits, measureSyncChanges, type ChangeLimits, type MeasuredTableChange } from "../../src/sync/changes";

const WIDE: ChangeLimits = { maxRows: 2_000_000, maxSeconds: 30 };

let counter = 0;

async function pair(statements: { live: string[]; staging: string[] }): Promise<{ live: string; staging: string }> {
  counter++;
  const tag = `${process.pid % 1000}_${counter}_${Math.random().toString(36).slice(2, 6)}`;
  const live = `rc_live_${tag}`;
  const staging = `rc_stage_${tag}`;
  for (const [schema, list] of [
    [live, statements.live],
    [staging, statements.staging],
  ] as const) {
    await rootQuery(`CREATE DATABASE \`${schema}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
    for (const s of list) await rootQuery(s.replaceAll("$S", `\`${schema}\``));
  }
  return { live, staging };
}

async function drop(p: { live: string; staging: string }): Promise<void> {
  await rootQuery(`DROP DATABASE IF EXISTS \`${p.live}\``);
  await rootQuery(`DROP DATABASE IF EXISTS \`${p.staging}\``);
}

function table(s: SyncChangeSummary, name: string): MeasuredTableChange | undefined {
  return s.tables.find((t) => t.name === name) as MeasuredTableChange | undefined;
}

function counts(t: TableRowChange | undefined) {
  return t ? { added: t.added, removed: t.removed, changed: t.changed, method: t.method } : undefined;
}

describe("sync measuring limits from the environment", () => {
  const keys = ["LAMBDATA_SYNC_DIFF_MAX_ROWS", "LAMBDATA_SYNC_DIFF_MAX_SECONDS", "KILNDB_SYNC_DIFF_MAX_ROWS", "KILNDB_SYNC_DIFF_MAX_SECONDS"];
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));

  afterAll(() => {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  test("defaults, the current prefix, the old prefix, and nonsense", () => {
    for (const k of keys) delete process.env[k];
    expect(changeLimits()).toEqual({ maxRows: 2_000_000, maxSeconds: 30 });
    process.env.KILNDB_SYNC_DIFF_MAX_ROWS = "1000";
    process.env.KILNDB_SYNC_DIFF_MAX_SECONDS = "0";
    expect(changeLimits()).toEqual({ maxRows: 1000, maxSeconds: 0 });
    process.env.LAMBDATA_SYNC_DIFF_MAX_ROWS = "500";
    process.env.LAMBDATA_SYNC_DIFF_MAX_SECONDS = "-4";
    expect(changeLimits()).toEqual({ maxRows: 500, maxSeconds: 30 });
  });
});

describe.skipIf(!mariadbAvailable())("measuring what a sync changed", () => {
  let instance: TestInstance;

  beforeAll(async () => {
    instance = await startTestInstance();
  }, 180_000);

  afterAll(async () => {
    await instance?.stop();
  }, 120_000);

  test("exact counts with adds, removes and changes at once, including NULL to value and value to NULL", async () => {
    const ddl = "CREATE TABLE $S.players (id INT PRIMARY KEY, name VARCHAR(50) NOT NULL, bio TEXT NULL, score DOUBLE NULL, seen DATETIME(3) NULL, avatar BLOB NULL)";
    const p = await pair({
      live: [
        ddl,
        `INSERT INTO $S.players VALUES
          (1, 'Avery', NULL, 1.5, '2026-01-01 00:00:00.000', NULL),
          (2, 'Blake', 'has bio', 2, NULL, 0x00),
          (3, 'Casey', 'same', 3, '2026-01-01 00:00:00.000', 0x01),
          (4, 'Drew', NULL, NULL, NULL, NULL),
          (5, 'Emery', 'gone', 5, NULL, NULL),
          (6, 'Finley', 'x', 6, NULL, NULL)`,
      ],
      staging: [
        ddl,
        `INSERT INTO $S.players VALUES
          (1, 'Avery', 'now has bio', 1.5, '2026-01-01 00:00:00.000', NULL),
          (2, 'Blake', NULL, 2, NULL, 0x00),
          (3, 'Casey', 'same', 3, '2026-01-01 00:00:00.000', 0x01),
          (4, 'Drew', NULL, NULL, NULL, NULL),
          (6, 'FINLEY', 'x', 6, NULL, NULL),
          (7, 'Gray', NULL, NULL, NULL, NULL),
          (8, 'Harper', NULL, NULL, NULL, NULL)`,
      ],
    });
    try {
      const s = await measureSyncChanges(p.live, p.staging, { limits: WIDE });
      expect(counts(table(s, "players"))).toEqual({ added: 2, removed: 1, changed: 3, method: "exact" });
      expect(table(s, "players")).toMatchObject({ change: "modified", schemaChanged: false, rowsBefore: 6, rowsAfter: 7 });
      expect(s).toMatchObject({
        tablesChanged: 1,
        tablesUnchanged: 0,
        exactTables: 1,
        netTables: 0,
        rowsAdded: 2,
        rowsRemoved: 1,
        rowsChanged: 3,
        rowDelta: 1,
        truncated: false,
      });
    } finally {
      await drop(p);
    }
  }, 60_000);

  test("composite keys and a unique NOT NULL key are compared exactly; a nullable unique key is not used", async () => {
    const p = await pair({
      live: [
        "CREATE TABLE $S.scores (season INT NOT NULL, player INT NOT NULL, points INT NULL, PRIMARY KEY (season, player))",
        "INSERT INTO $S.scores VALUES (1, 1, 10), (1, 2, 20), (2, 1, NULL)",
        "CREATE TABLE $S.tags (label VARCHAR(20) NOT NULL, hits INT NOT NULL, UNIQUE KEY uq_label (label))",
        "INSERT INTO $S.tags VALUES ('red', 1), ('blue', 2)",
        "CREATE TABLE $S.loose (code VARCHAR(20) NULL, n INT NOT NULL, UNIQUE KEY uq_code (code))",
        "INSERT INTO $S.loose VALUES ('a', 1), (NULL, 2)",
      ],
      staging: [
        "CREATE TABLE $S.scores (season INT NOT NULL, player INT NOT NULL, points INT NULL, PRIMARY KEY (season, player))",
        "INSERT INTO $S.scores VALUES (1, 1, 10), (1, 2, 25), (2, 2, 5), (2, 1, 0)",
        "CREATE TABLE $S.tags (label VARCHAR(20) NOT NULL, hits INT NOT NULL, UNIQUE KEY uq_label (label))",
        "INSERT INTO $S.tags VALUES ('red', 1), ('green', 3)",
        "CREATE TABLE $S.loose (code VARCHAR(20) NULL, n INT NOT NULL, UNIQUE KEY uq_code (code))",
        "INSERT INTO $S.loose VALUES ('a', 1), (NULL, 3)",
      ],
    });
    try {
      const s = await measureSyncChanges(p.live, p.staging, { limits: WIDE });
      expect(counts(table(s, "scores"))).toEqual({ added: 1, removed: 0, changed: 2, method: "exact" });
      expect(counts(table(s, "tags"))).toEqual({ added: 1, removed: 1, changed: 0, method: "exact" });
      expect(table(s, "loose")).toMatchObject({ method: "net", rowsBefore: 2, rowsAfter: 2, added: null, removed: null, changed: null, reason: "no-key" });
      expect(s.exactTables).toBe(2);
      expect(s.netTables).toBe(1);
      expect(s.rowsAdded).toBe(2);
      expect(s.rowsRemoved).toBe(1);
      expect(s.rowsChanged).toBe(2);
    } finally {
      await drop(p);
    }
  }, 60_000);

  test("a table without a key, a table whose columns changed, and added and removed tables are net", async () => {
    const p = await pair({
      live: [
        "CREATE TABLE $S.log (msg VARCHAR(50))",
        "INSERT INTO $S.log VALUES ('a'), ('b')",
        "CREATE TABLE $S.same_log (msg VARCHAR(50))",
        "INSERT INTO $S.same_log VALUES ('a'), ('b')",
        "CREATE TABLE $S.items (id INT PRIMARY KEY, title VARCHAR(20))",
        "INSERT INTO $S.items VALUES (1, 'x'), (2, 'y')",
        "CREATE TABLE $S.old_table (id INT PRIMARY KEY)",
        "INSERT INTO $S.old_table VALUES (1), (2), (3)",
        "CREATE TABLE $S.stable (id INT PRIMARY KEY, v INT)",
        "INSERT INTO $S.stable VALUES (1, 1)",
      ],
      staging: [
        "CREATE TABLE $S.log (msg VARCHAR(50))",
        "INSERT INTO $S.log VALUES ('a'), ('c')",
        "CREATE TABLE $S.same_log (msg VARCHAR(50))",
        "INSERT INTO $S.same_log VALUES ('b'), ('a')",
        "CREATE TABLE $S.items (id INT PRIMARY KEY, title VARCHAR(20), price INT NULL)",
        "INSERT INTO $S.items VALUES (1, 'x', NULL), (2, 'y', NULL), (3, 'z', 4)",
        "CREATE TABLE $S.new_table (id INT PRIMARY KEY)",
        "INSERT INTO $S.new_table VALUES (1), (2), (3), (4), (5)",
        "CREATE TABLE $S.stable (id INT PRIMARY KEY, v INT)",
        "INSERT INTO $S.stable VALUES (1, 1)",
      ],
    });
    try {
      const s = await measureSyncChanges(p.live, p.staging, { limits: WIDE });
      expect(table(s, "log")).toMatchObject({ change: "modified", method: "net", schemaChanged: false, rowsBefore: 2, rowsAfter: 2, reason: "no-key" });
      expect(table(s, "same_log")).toBeUndefined();
      expect(table(s, "items")).toMatchObject({ change: "modified", method: "net", schemaChanged: true, rowsBefore: 2, rowsAfter: 3, added: null, reason: "structure" });
      expect(table(s, "new_table")).toMatchObject({ change: "added", method: "net", rowsBefore: null, rowsAfter: 5, reason: "new" });
      expect(table(s, "old_table")).toMatchObject({ change: "removed", method: "net", rowsBefore: 3, rowsAfter: null, reason: "removed" });
      expect(table(s, "stable")).toBeUndefined();
      expect(s.tablesChanged).toBe(4);
      expect(s.tablesUnchanged).toBe(2);
      expect(s.exactTables).toBe(1);
      expect(s.rowsAdded).toBe(0);
      expect(s.rowDelta).toBe(0 + 0 + 1 + 5 - 3 + 0);
      expect(s.tables.map((t) => t.name)).toEqual(["new_table", "old_table", "items", "log"]);
    } finally {
      await drop(p);
    }
  }, 60_000);

  test("a first sync into an empty mirror reports every table as added, net", async () => {
    const p = await pair({
      live: [],
      staging: ["CREATE TABLE $S.a (id INT PRIMARY KEY)", "INSERT INTO $S.a VALUES (1), (2)", "CREATE TABLE $S.b (id INT PRIMARY KEY)"],
    });
    try {
      const s = await measureSyncChanges(p.live, p.staging, { limits: WIDE });
      expect(s.tablesChanged).toBe(2);
      expect(s.tables.every((t) => t.change === "added" && t.method === "net")).toBe(true);
      expect(s.rowsAdded).toBeNull();
      expect(s.rowDelta).toBe(2);
    } finally {
      await drop(p);
    }
  }, 60_000);

  test("the row limit and the time budget fall back to net; zero turns exact comparison off", async () => {
    const p = await pair({
      live: [
        "CREATE TABLE $S.big (id INT PRIMARY KEY, v INT)",
        "INSERT INTO $S.big SELECT seq, seq FROM $S.seq_1_to_50",
        "CREATE TABLE $S.small (id INT PRIMARY KEY, v INT)",
        "INSERT INTO $S.small VALUES (1, 1), (2, 2)",
      ],
      staging: [
        "CREATE TABLE $S.big (id INT PRIMARY KEY, v INT)",
        "INSERT INTO $S.big SELECT seq, IF(seq = 7, 0, seq) FROM $S.seq_1_to_50",
        "CREATE TABLE $S.small (id INT PRIMARY KEY, v INT)",
        "INSERT INTO $S.small VALUES (1, 1), (2, 3)",
      ],
    });
    try {
      const limited = await measureSyncChanges(p.live, p.staging, { limits: { maxRows: 10, maxSeconds: 30 } });
      expect(table(limited, "big")).toMatchObject({ method: "net", rowsBefore: 50, rowsAfter: 50, reason: "too-large" });
      expect(counts(table(limited, "small"))).toEqual({ added: 0, removed: 0, changed: 1, method: "exact" });

      const spent = await measureSyncChanges(p.live, p.staging, { limits: WIDE, budget: { deadline: Date.now() - 1 } });
      expect(spent).toMatchObject({ tablesChanged: 0, tablesUnchanged: 0, tablesNotCompared: 2, rowDelta: null, rowsAdded: null, tables: [] });

      const liveHints = [
        { name: "big", rowCount: 50, checksum: 1 },
        { name: "small", rowCount: 2, checksum: 5 },
      ];
      const stagingHints = [
        { name: "big", rowCount: 50, checksum: 2 },
        { name: "small", rowCount: 2, checksum: 5 },
      ];
      const hinted = await measureSyncChanges(p.live, p.staging, { limits: WIDE, budget: { deadline: Date.now() - 1 }, hints: { live: liveHints, staging: stagingHints } });
      expect(hinted).toMatchObject({ tablesChanged: 1, tablesUnchanged: 1, tablesNotCompared: 0, rowDelta: 0 });
      expect(table(hinted, "big")).toMatchObject({ method: "net", rowsBefore: 50, rowsAfter: 50, reason: "time" });

      const off = await measureSyncChanges(p.live, p.staging, { limits: { maxRows: 2_000_000, maxSeconds: 0 } });
      expect(off).toMatchObject({ exactTables: 0, tablesChanged: 0, tablesNotCompared: 2 });
      const offHinted = await measureSyncChanges(p.live, p.staging, { limits: { maxRows: 2_000_000, maxSeconds: 0 }, hints: { live: liveHints, staging: stagingHints } });
      expect(offHinted).toMatchObject({ exactTables: 0, tablesChanged: 1, tablesUnchanged: 1, tablesNotCompared: 0 });
      expect(table(offHinted, "big")).toMatchObject({ method: "net", reason: "off" });
      const quiet = await measureSyncChanges(p.live, p.staging, {
        limits: { maxRows: 2_000_000, maxSeconds: 0 },
        hints: { live: stagingHints, staging: stagingHints },
      });
      expect(quiet).toMatchObject({ tablesChanged: 0, tablesUnchanged: 2, tablesNotCompared: 0, rowDelta: 0 });

      const noRows = await measureSyncChanges(p.live, p.staging, { limits: { maxRows: 0, maxSeconds: 30 } });
      expect(noRows).toMatchObject({ exactTables: 0, tablesChanged: 2, tablesNotCompared: 0 });
      expect(table(noRows, "small")).toMatchObject({ method: "net", reason: "off", rowsBefore: 2, rowsAfter: 2 });

      const budget = changeBudget({ maxRows: 2_000_000, maxSeconds: 30 });
      expect(budget.deadline).toBeGreaterThan(Date.now());
    } finally {
      await drop(p);
    }
  }, 60_000);

  test("case-only and trailing-space edits under a case-insensitive collation count as changed", async () => {
    const ddl = "CREATE TABLE $S.names (id INT PRIMARY KEY, label VARCHAR(20) NOT NULL) COLLATE utf8mb4_unicode_ci";
    const p = await pair({
      live: [ddl, "INSERT INTO $S.names VALUES (1, 'alpha'), (2, 'beta'), (3, 'gamma')"],
      staging: [ddl, "INSERT INTO $S.names VALUES (1, 'Alpha'), (2, 'beta '), (3, 'gamma')"],
    });
    try {
      const s = await measureSyncChanges(p.live, p.staging, { limits: WIDE });
      expect(counts(table(s, "names"))).toEqual({ added: 0, removed: 0, changed: 2, method: "exact" });
    } finally {
      await drop(p);
    }
  }, 60_000);

  test("matching checksums from the sync skip the row-by-row comparison", async () => {
    const ddl = "CREATE TABLE $S.t (id INT PRIMARY KEY, v INT)";
    const p = await pair({
      live: [ddl, "INSERT INTO $S.t VALUES (1, 1)"],
      staging: [ddl, "INSERT INTO $S.t VALUES (1, 2)"],
    });
    try {
      const hint = [{ name: "t", rowCount: 1, checksum: 42 }];
      const s = await measureSyncChanges(p.live, p.staging, { limits: WIDE, hints: { live: hint, staging: hint } });
      expect(s.tablesChanged).toBe(0);
      expect(s.exactTables).toBe(1);
      expect(s.rowsChanged).toBe(0);
      const real = await measureSyncChanges(p.live, p.staging, { limits: WIDE, hints: { live: [{ name: "t", rowCount: 1, checksum: 1 }], staging: hint } });
      expect(counts(table(real, "t"))).toEqual({ added: 0, removed: 0, changed: 1, method: "exact" });
    } finally {
      await drop(p);
    }
  }, 60_000);

  test("hostile table names are quoted", async () => {
    const name = "we`ird; DROP TABLE x; -- name";
    const quoted = "`" + name.replaceAll("`", "``") + "`";
    const p = await pair({
      live: [`CREATE TABLE $S.${quoted} (id INT PRIMARY KEY, v INT)`, `INSERT INTO $S.${quoted} VALUES (1, 1)`],
      staging: [`CREATE TABLE $S.${quoted} (id INT PRIMARY KEY, v INT)`, `INSERT INTO $S.${quoted} VALUES (1, 1), (2, 2)`],
    });
    try {
      const s = await measureSyncChanges(p.live, p.staging, { limits: WIDE });
      expect(counts(table(s, name))).toEqual({ added: 1, removed: 0, changed: 0, method: "exact" });
    } finally {
      await drop(p);
    }
  }, 60_000);
});
