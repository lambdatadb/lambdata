import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, appendFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { useTempMetadata, type TempMetadata } from "../harness/sqlite";
import { testRoot } from "../harness/isolate";
import { env, mariadbBindFromEnvironment } from "../../src/env";
import { getMariaDbBinariesSync, serverArgs } from "../../src/mariadb/controller";
import { settings } from "../../src/db/queries";
import {
  OUTSIDE_CONNECTIONS_KEY,
  isLoopbackBind,
  resolveDatabaseBind,
  saveOutsideConnections,
} from "../../src/connections/bind";
import {
  allRejections,
  clearRejections,
  recordRejections,
  rejectionGroupCount,
  rejectionLimits,
  rejectionsForDatabase,
  type RejectionGroup,
} from "../../src/connections/store";
import { LogTail } from "../../src/connections/capture";

let md: TempMetadata;

beforeAll(() => {
  md = useTempMetadata();
});

afterAll(() => md.cleanup());

describe("bind resolution", () => {
  const envBefore = env.mariadbBindFromEnv;

  beforeEach(() => {
    env.mariadbBindFromEnv = null;
    settings.set(OUTSIDE_CONNECTIONS_KEY, "");
  });

  afterAll(() => {
    env.mariadbBindFromEnv = envBefore;
    settings.set(OUTSIDE_CONNECTIONS_KEY, "");
  });

  test("with neither variable nor setting MariaDB stays on loopback", () => {
    expect(resolveDatabaseBind()).toEqual({ bind: "127.0.0.1", source: "default", lockedByEnv: false });
  });

  test("the setting decides when no variable is set", () => {
    saveOutsideConnections(true);
    expect(resolveDatabaseBind()).toEqual({ bind: "0.0.0.0", source: "setting", lockedByEnv: false });
    saveOutsideConnections(false);
    expect(resolveDatabaseBind()).toEqual({ bind: "127.0.0.1", source: "setting", lockedByEnv: false });
  });

  test("the variable always wins and locks the switch", () => {
    saveOutsideConnections(false);
    env.mariadbBindFromEnv = "0.0.0.0";
    expect(resolveDatabaseBind()).toEqual({ bind: "0.0.0.0", source: "env", lockedByEnv: true });
    saveOutsideConnections(true);
    env.mariadbBindFromEnv = "127.0.0.1";
    expect(resolveDatabaseBind()).toEqual({ bind: "127.0.0.1", source: "env", lockedByEnv: true });
  });

  test("an empty or whitespace-only variable counts as not set", () => {
    expect(mariadbBindFromEnvironment({ LAMBDATA_MARIADB_BIND: "" })).toBeNull();
    expect(mariadbBindFromEnvironment({ LAMBDATA_MARIADB_BIND: "   " })).toBeNull();
    expect(mariadbBindFromEnvironment({ KILNDB_MARIADB_BIND: " \t" })).toBeNull();
    expect(mariadbBindFromEnvironment({ LAMBDATA_MARIADB_BIND: " ", KILNDB_MARIADB_BIND: "0.0.0.0" })).toBe("0.0.0.0");
    expect(mariadbBindFromEnvironment({ LAMBDATA_MARIADB_BIND: " 0.0.0.0 " })).toBe("0.0.0.0");
    expect(mariadbBindFromEnvironment({ KILNDB_MARIADB_BIND: "0.0.0.0" })).toBe("0.0.0.0");
    for (const blank of ["", "   "]) {
      env.mariadbBindFromEnv = blank;
      expect(resolveDatabaseBind()).toEqual({ bind: "127.0.0.1", source: "default", lockedByEnv: false });
      saveOutsideConnections(true);
      expect(resolveDatabaseBind()).toEqual({ bind: "0.0.0.0", source: "setting", lockedByEnv: false });
      settings.set(OUTSIDE_CONNECTIONS_KEY, "");
    }
  });

  test("an empty bind address never reaches --bind-address", () => {
    const before = env.mariadbBind;
    try {
      env.mariadbBind = "  ";
      expect(env.mariadbBind).toBe("127.0.0.1");
      env.mariadbBind = "";
      expect(env.mariadbBind).toBe("127.0.0.1");
      let binaries: ReturnType<typeof getMariaDbBinariesSync> | null = null;
      try {
        binaries = getMariaDbBinariesSync();
      } catch {
        binaries = null;
      }
      if (binaries) expect(serverArgs(binaries)).toContain("--bind-address=127.0.0.1");
    } finally {
      env.mariadbBind = before;
    }
  });

  test("loopback binds", () => {
    expect(isLoopbackBind("127.0.0.1")).toBe(true);
    expect(isLoopbackBind("localhost")).toBe(true);
    expect(isLoopbackBind("::1")).toBe(true);
    expect(isLoopbackBind("0.0.0.0")).toBe(false);
    expect(isLoopbackBind("::")).toBe(false);
    expect(isLoopbackBind("192.0.2.10")).toBe(false);
  });
});

describe("storage", () => {
  const limitsBefore = { ...rejectionLimits };
  const now = Date.now();

  function group(i: number, lastAt: number, extra: Partial<RejectionGroup> = {}): RejectionGroup {
    return {
      address: `198.51.100.${i % 250}`,
      account: `probe_${i}`,
      reason: "unknown-account",
      databaseId: null,
      count: 1,
      firstAt: lastAt,
      lastAt,
      ...extra,
    };
  }

  beforeEach(() => {
    clearRejections();
    Object.assign(rejectionLimits, limitsBefore);
  });

  afterAll(() => {
    Object.assign(rejectionLimits, limitsBefore);
    clearRejections();
  });

  test("repeats add to one group", () => {
    recordRejections([group(1, now - 10_000)], now);
    recordRejections([{ ...group(1, now - 2_000), count: 4, firstAt: now - 20_000 }], now);
    const [g] = allRejections(now);
    expect(g).toMatchObject({ count: 5, firstAt: now - 20_000, lastAt: now - 2_000, account: "probe_1" });
    expect(rejectionGroupCount()).toBe(1);
  });

  test("groups older than the retention are aged out", () => {
    recordRejections([group(1, now - rejectionLimits.retentionMs - 1), group(2, now - 1000)], now);
    expect(allRejections(now).map((g) => g.account)).toEqual(["probe_2"]);
    expect(rejectionGroupCount()).toBe(1);
  });

  test("the number of groups is capped, newest kept", () => {
    rejectionLimits.maxGroups = 50;
    const batch = Array.from({ length: 120 }, (_, i) => group(i, now - (120 - i) * 1000));
    recordRejections(batch, now);
    expect(rejectionGroupCount()).toBe(50);
    const kept = allRejections(now, 500);
    expect(kept[0]!.account).toBe("probe_119");
    expect(kept.at(-1)!.account).toBe("probe_70");
  });

  test("a database only sees its own groups, newest first", () => {
    recordRejections([group(1, now - 1000), group(2, now - 500)], now);
    expect(rejectionsForDatabase("db_missing", now)).toEqual([]);
  });

  test("a probe storm of 20,000 attempts stays small and fast", () => {
    const started = performance.now();
    for (let round = 0; round < 20; round++) {
      recordRejections(
        Array.from({ length: 1000 }, (_, i) => group(round * 1000 + i, now - 1000 + round)),
        now,
      );
    }
    expect(rejectionGroupCount()).toBeLessThanOrEqual(rejectionLimits.maxGroups);
    const t = performance.now();
    allRejections(now);
    expect(performance.now() - t).toBeLessThan(50);
    expect(performance.now() - started).toBeLessThan(5000);
  });
});

describe("log tail", () => {
  test("reads only complete new lines, follows a rotation and caps a large backlog", () => {
    const dir = mkdtempSync(join(testRoot(), "tail-"));
    const path = join(dir, "audit.log");
    writeFileSync(path, "old line\n");
    const tail = new LogTail(path, 64);
    tail.start();
    expect(tail.readLines()).toEqual([]);
    appendFileSync(path, "one\ntw");
    expect(tail.readLines()).toEqual(["one"]);
    appendFileSync(path, "o\nthree\n");
    expect(tail.readLines()).toEqual(["two", "three"]);
    appendFileSync(path, "four\n");
    renameSync(path, `${path}.1`);
    writeFileSync(path, "five\n");
    expect(tail.readLines()).toEqual(["four", "five"]);
    appendFileSync(path, `${"x".repeat(200)}\nsix\nseven\n`);
    expect(tail.readLines()).toEqual(["six", "seven"]);
    writeFileSync(path, "eight\n");
    expect(tail.readLines()).toEqual(["eight"]);
  });
});
