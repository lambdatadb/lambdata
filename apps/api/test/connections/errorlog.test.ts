import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, renameSync, truncateSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { seedUser, useTempMetadata, type TempMetadata } from "../harness/sqlite";
import { testRoot } from "../harness/isolate";
import { databases } from "../../src/db/queries";
import { LogTail, pollRejections, setCapture, stopRejectionCapture } from "../../src/connections/capture";
import { allRejections, clearRejections, rejectionGroupCount, rejectionLimits } from "../../src/connections/store";

let md: TempMetadata;

beforeAll(() => {
  md = useTempMetadata();
  databases.insert({
    id: "db_arcade",
    name: "arcade",
    displayName: "Arcade",
    ownerUserId: seedUser("db_owner").id,
    kind: "standard",
    mysqlUser: "arcade_u",
    mysqlPasswordEnc: "unused",
    connectionsFrom: "%",
    tailscaleExposed: false,
    lanExposed: true,
  });
});

afterAll(() => {
  stopRejectionCapture();
  md.cleanup();
});

function stamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function denied(user: string, address: string, id = 7): string {
  return `${stamp()} ${id} [Warning] Access denied for user '${user}'@'${address}' (using password: YES)\n`;
}

function probeAddress(i: number): string {
  return `198.51.${100 + Math.floor(i / 250) % 4}.${i % 250}`;
}

function tempLog(): string {
  const dir = mkdtempSync(join(testRoot(), "errlog-"));
  const path = join(dir, "mariadb.log");
  writeFileSync(path, "2026-11-11 21:36:49 0 [Note] mariadbd: ready for connections.\n");
  return path;
}

function totalCount(): number {
  return allRejections(Date.now(), 100_000).reduce((n, r) => n + r.count, 0);
}

describe("reading the error log while it is rotated or truncated", () => {
  test("a rename followed by late writes to the old file loses and repeats nothing", () => {
    const path = tempLog();
    const tail = new LogTail(path);
    tail.start();
    appendFileSync(path, "a1\na2\n");
    expect(tail.readLines()).toEqual(["a1", "a2"]);
    appendFileSync(path, "a3\n");
    renameSync(path, `${path}.1`);
    expect(tail.readLines()).toEqual(["a3"]);
    appendFileSync(`${path}.1`, "a4 written before MariaDB reopened its log\n");
    writeFileSync(path, "b1\n");
    expect(tail.readLines()).toEqual(["a4 written before MariaDB reopened its log", "b1"]);
    appendFileSync(path, "b2\n");
    expect(tail.readLines()).toEqual(["b2"]);
    expect(tail.readLines()).toEqual([]);
  });

  test("truncation restarts at the beginning without re-reading", () => {
    const path = tempLog();
    const tail = new LogTail(path);
    tail.start();
    appendFileSync(path, "x1\nx2\n");
    expect(tail.readLines()).toEqual(["x1", "x2"]);
    truncateSync(path, 0);
    expect(tail.readLines()).toEqual([]);
    appendFileSync(path, "y1\n");
    expect(tail.readLines()).toEqual(["y1"]);
    expect(tail.position()?.offset).toBe(3);
  });

  test("a missing file, a second rotation and a replaced previous file do not crash or stall", () => {
    const path = tempLog();
    const tail = new LogTail(path);
    tail.start();
    renameSync(path, `${path}.1`);
    expect(tail.readLines()).toEqual([]);
    writeFileSync(path, "n1\n");
    expect(tail.readLines()).toEqual(["n1"]);
    renameSync(path, `${path}.1`);
    writeFileSync(path, "m1\n");
    expect(tail.readLines()).toEqual(["m1"]);
    writeFileSync(`${path}.other`, "unrelated older file\n");
    renameSync(`${path}.other`, `${path}.1`);
    appendFileSync(path, "m2\n");
    expect(tail.readLines()).toEqual(["m2"]);
  });
});

describe("a flood of refusals on the error-log path", () => {
  const before = { ...rejectionLimits };

  beforeEach(() => {
    clearRejections();
    Object.assign(rejectionLimits, before);
  });

  afterAll(() => {
    Object.assign(rejectionLimits, before);
    clearRejections();
  });

  test("20,000 refusals from 1,000 addresses stay within the row cap and each poll is cheap", () => {
    rejectionLimits.maxGroups = 500;
    const path = tempLog();
    setCapture({ mode: "errorlog", path });
    const timings: number[] = [];
    let written = 0;
    for (let round = 0; round < 20; round++) {
      let chunk = "";
      for (let i = 0; i < 1000; i++) {
        const n = round * 1000 + i;
        chunk += denied(n % 3 === 0 ? "arcade_u" : `probe_${n % 7}`, probeAddress(n % 1000));
        if (n % 5 === 0) chunk += `${stamp()} 0 [Note] unrelated line ${n}\n`;
      }
      appendFileSync(path, chunk);
      written += 1000;
      const t = performance.now();
      pollRejections();
      timings.push(performance.now() - t);
      expect(rejectionGroupCount()).toBeLessThanOrEqual(500);
    }
    expect(written).toBe(20_000);
    const sorted = [...timings].sort((a, b) => a - b);
    console.log(`[errorlog flood] polls of ~110 KB: median ${sorted[10]!.toFixed(1)} ms, max ${sorted[19]!.toFixed(1)} ms`);
    expect(sorted[10]!).toBeLessThan(100);
    expect(rejectionGroupCount()).toBe(500);
  });

  test("rotation in the middle of a flood counts every refusal exactly once", () => {
    const path = tempLog();
    setCapture({ mode: "errorlog", path });
    const write = (n: number) => {
      let chunk = "";
      for (let i = 0; i < n; i++) chunk += denied("arcade_u", probeAddress(i % 40));
      appendFileSync(path, chunk);
    };
    write(300);
    pollRejections();
    write(200);
    renameSync(path, `${path}.1`);
    appendFileSync(`${path}.1`, denied("arcade_u", probeAddress(1)));
    pollRejections();
    writeFileSync(path, "");
    write(150);
    pollRejections();
    pollRejections();
    expect(totalCount()).toBe(651);
    expect(rejectionGroupCount()).toBe(40);
    expect(allRejections()[0]!.reason).toBe("wrong-password");
  });
});
