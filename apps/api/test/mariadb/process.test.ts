import { createTestDatabase, mariadbAvailable, rootQuery, startTestInstance, type TestInstance } from "../harness/instance";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { env } from "../../src/env";
import { processCommand } from "../../src/util/processes";
import {
  MariaDbToolError,
  dumpStream,
  loadStream,
  localAdminTarget,
  runSql,
  sanitizeToolOutput,
  type Target,
} from "../../src/mariadb/process";

type Spawned = { argv: string[]; env: Record<string, string>; proc: ReturnType<typeof Bun.spawn> };

async function captureSpawns<T>(fn: (spawned: Spawned[]) => Promise<T>): Promise<T> {
  const original = Bun.spawn;
  const spawned: Spawned[] = [];
  const patched = (cmd: string[], opts: { env?: Record<string, string> }) => {
    const proc = (original as unknown as (c: string[], o: unknown) => ReturnType<typeof Bun.spawn>)(cmd, opts);
    spawned.push({ argv: cmd, env: opts?.env ?? {}, proc });
    return proc;
  };
  (Bun as unknown as { spawn: unknown }).spawn = patched;
  try {
    return await fn(spawned);
  } finally {
    (Bun as unknown as { spawn: unknown }).spawn = original;
  }
}

function processEnvironment(pid: number): string | null {
  if (process.platform === "linux") {
    try {
      return readFileSync(`/proc/${pid}/environ`, "utf8").replaceAll("\u0000", "\n");
    } catch {
      return null;
    }
  }
  const out = Bun.spawnSync(["ps", "-wwE", "-o", "command=", "-p", String(pid)]).stdout.toString();
  return out.includes("PATH=") ? out : null;
}

function processArgs(pid: number): string {
  return processCommand(pid) ?? "";
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function readAll(stream: ReadableStream<Uint8Array>): Promise<number> {
  const reader = stream.getReader();
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return total;
    total += value.byteLength;
  }
}

const BIG_ROWS = 40_000;
const BIG_PAD = 1_000;

describe.skipIf(!mariadbAvailable())("mariadb process helpers", () => {
  let instance: TestInstance | null = null;
  let admin: Target;
  let bigDb: { schema: string; user: string; password: string };

  beforeAll(async () => {
    instance = await startTestInstance();
    admin = await localAdminTarget();
    bigDb = await createTestDatabase();
    await rootQuery(`CREATE TABLE \`${bigDb.schema}\`.big (id INT PRIMARY KEY, pad VARCHAR(${BIG_PAD})) ENGINE=InnoDB`);
    const digits = "(SELECT 0 AS n UNION ALL SELECT 1 UNION ALL SELECT 2 UNION ALL SELECT 3 UNION ALL SELECT 4 UNION ALL SELECT 5 UNION ALL SELECT 6 UNION ALL SELECT 7 UNION ALL SELECT 8 UNION ALL SELECT 9)";
    await rootQuery(
      `INSERT INTO \`${bigDb.schema}\`.big
       SELECT id, REPEAT('x', ${BIG_PAD}) FROM (
         SELECT a.n * 10000 + b.n * 1000 + c.n * 100 + d.n * 10 + e.n + 1 AS id
           FROM ${digits} a, ${digits} b, ${digits} c, ${digits} d, ${digits} e
       ) s WHERE id <= ${BIG_ROWS}`,
    );
  }, 180_000);

  afterAll(async () => {
    await instance?.stop();
  }, 60_000);

  test("credentials stay out of argv and the environment; the defaults file is 0600 and removed", async () => {
    await captureSpawns(async (spawned) => {
      const running = runSql(admin, null, "SELECT SLEEP(1.5)");
      await Bun.sleep(400);
      expect(spawned.length).toBe(1);
      const s = spawned[0]!;
      const cnfArg = s.argv[1]!;
      expect(cnfArg.startsWith("--defaults-extra-file=")).toBe(true);
      const cnf = cnfArg.slice("--defaults-extra-file=".length);
      expect(statSync(cnf).mode & 0o777).toBe(0o600);
      expect(statSync(dirname(cnf)).mode & 0o777).toBe(0o700);
      expect(readFileSync(cnf, "utf8")).toContain(admin.password);
      expect(s.argv.join(" ")).not.toContain(admin.password);
      expect(Object.keys(s.env).some((k) => k.startsWith("MYSQL") || k.startsWith("MARIADB"))).toBe(false);
      expect(Object.keys(s.env)).not.toContain("HOME");
      expect(Object.values(s.env).join("\n")).not.toContain(admin.password);
      const args = processArgs(s.proc.pid);
      expect(args).toContain("--defaults-extra-file=");
      expect(args).not.toContain(admin.password);
      const childEnv = processEnvironment(s.proc.pid);
      if (childEnv !== null) {
        expect(childEnv).not.toContain(admin.password);
        expect(childEnv).not.toContain("MYSQL_PWD");
      }
      await running;
      expect(existsSync(cnf)).toBe(false);
      expect(existsSync(dirname(cnf))).toBe(false);

      const failing = runSql(admin, null, "SELECT * FROM no_such_db.no_such_table");
      await expect(failing).rejects.toBeInstanceOf(MariaDbToolError);
      const failedCnf = spawned[1]!.argv[1]!.slice("--defaults-extra-file=".length);
      expect(existsSync(failedCnf)).toBe(false);
    });
  });

  test("errors are sanitised and keep the useful line", async () => {
    let err: unknown = null;
    await runSql(admin, null, `SELECT \`${admin.password}\``).catch((e) => {
      err = e;
    });
    expect(err).toBeInstanceOf(MariaDbToolError);
    const e = err as MariaDbToolError;
    expect(e.message).toContain("Unknown column");
    expect(e.message).not.toContain(admin.password);
    expect(e.stderr).not.toContain(admin.password);
    expect(e.exitCode).toBe(1);

    const wrong = { ...admin, password: `wrong-${admin.password}` };
    let denied: unknown = null;
    await runSql(wrong, null, "SELECT 1").catch((e2) => {
      denied = e2;
    });
    expect((denied as Error).message).toContain("Access denied");
    expect((denied as Error).message).not.toContain(wrong.password);

    expect(sanitizeToolOutput("x hunter22 y password=abc", ["hunter22"])).toBe("x *** y password=***");
  });

  test("passwords with option-file special characters work", async () => {
    const password = `p#a"s's w\\o;r=d[x]\ttab`;
    await rootQuery(`CREATE USER 'special_pw'@'%' IDENTIFIED BY ?`, [password]);
    await rootQuery(`GRANT SELECT ON *.* TO 'special_pw'@'%'`);
    try {
      await runSql({ host: "127.0.0.1", port: env.mariadbPort, user: "special_pw", password }, null, "SELECT 1");
    } finally {
      await rootQuery(`DROP USER 'special_pw'@'%'`);
    }
  });

  test("a wall-clock timeout kills the process", async () => {
    await captureSpawns(async (spawned) => {
      const started = Date.now();
      let err: unknown = null;
      await runSql(admin, null, "SELECT SLEEP(30)", { timeoutMs: 500 }).catch((e) => {
        err = e;
      });
      expect(Date.now() - started).toBeLessThan(5_000);
      expect(err).toBeInstanceOf(MariaDbToolError);
      expect((err as MariaDbToolError).timedOut).toBe(true);
      expect((err as Error).message).toContain("timed out");
      expect(isAlive(spawned[0]!.proc.pid)).toBe(false);
    });
  });

  test("an AbortSignal cancels the process", async () => {
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 300);
    let err: unknown = null;
    await runSql(admin, null, "SELECT SLEEP(30)", { signal: ac.signal }).catch((e) => {
      err = e;
    });
    expect((err as MariaDbToolError).aborted).toBe(true);
    await expect(runSql(admin, null, "SELECT 1", { signal: ac.signal })).rejects.toThrow(/cancelled/);
  });

  test("dump output is streamed with backpressure instead of buffered", async () => {
    const { stdout, done } = dumpStream(admin, bigDb.schema, ["--single-transaction", "--quick", "--skip-dump-date"], {
      tables: ["big"],
    });
    let settled = false;
    done.then(
      () => (settled = true),
      () => (settled = true),
    );
    const reader = stdout.getReader();
    const first = await reader.read();
    expect(first.done).toBe(false);
    await Bun.sleep(1_500);
    expect(settled).toBe(false);
    let total = first.value!.byteLength;
    for (;;) {
      const { done: end, value } = await reader.read();
      if (end) break;
      total += value.byteLength;
    }
    await done;
    expect(total).toBeGreaterThan(BIG_ROWS * BIG_PAD);
  }, 60_000);

  test("load input is consumed as it arrives", async () => {
    const db = await createTestDatabase();
    const encoder = new TextEncoder();
    let step = 0;
    const input = new ReadableStream<Uint8Array>({
      async pull(controller) {
        if (step === 0) {
          step = 1;
          controller.enqueue(encoder.encode("CREATE TABLE s (id INT PRIMARY KEY);\nINSERT INTO s VALUES (1);\n"));
          return;
        }
        const deadline = Date.now() + 10_000;
        while (Date.now() < deadline) {
          const rows = await rootQuery<{ n: number }>(
            `SELECT COUNT(*) AS n FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 's'`,
            [db.schema],
          );
          if (Number(rows[0]?.n) === 1) {
            const seen = await rootQuery<{ n: number }>(`SELECT COUNT(*) AS n FROM \`${db.schema}\`.s`);
            if (Number(seen[0]?.n) === 1) break;
          }
          await Bun.sleep(50);
        }
        if (Date.now() >= deadline) {
          controller.error(new Error("first statement never reached the server: input was buffered"));
          return;
        }
        controller.enqueue(encoder.encode("INSERT INTO s VALUES (2);\n"));
        controller.close();
      },
    });
    await loadStream(admin, db.schema, input);
    const rows = await rootQuery<{ id: number }>(`SELECT id FROM \`${db.schema}\`.s ORDER BY id`);
    expect(rows).toEqual([{ id: 1 }, { id: 2 }]);
  }, 30_000);

  test("a dump pipes into a load without buffering the whole stream", async () => {
    const target = await createTestDatabase();
    const dump = dumpStream(admin, bigDb.schema, ["--single-transaction", "--quick", "--skip-dump-date"], {
      tables: ["big"],
    });
    const rssBefore = process.memoryUsage().rss;
    await Promise.all([dump.done, loadStream(admin, target.schema, dump.stdout)]);
    const rows = await rootQuery<{ n: number }>(`SELECT COUNT(*) AS n FROM \`${target.schema}\`.big`);
    expect(Number(rows[0]!.n)).toBe(BIG_ROWS);
    expect(process.memoryUsage().rss - rssBefore).toBeLessThan(BIG_ROWS * BIG_PAD);
  }, 60_000);

  test("a non-admin target dumps its own schema", async () => {
    const remote: Target = { host: "127.0.0.1", port: env.mariadbPort, user: bigDb.user, password: bigDb.password };
    const { stdout, done } = dumpStream(remote, bigDb.schema, ["--single-transaction", "--no-tablespaces", "--no-data"]);
    const [bytes] = await Promise.all([readAll(stdout), done]);
    expect(bytes).toBeGreaterThan(0);
  });

  test("a failing load rejects even when the input is still streaming", async () => {
    const wrong = { ...admin, password: "definitely-wrong" };
    const encoder = new TextEncoder();
    let sent = 0;
    const input = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent > 64 * 1024 * 1024) {
          controller.close();
          return;
        }
        const chunk = encoder.encode("SELECT 1;\n".repeat(10_000));
        sent += chunk.byteLength;
        controller.enqueue(chunk);
      },
    });
    await expect(loadStream(wrong, "mysql", input)).rejects.toThrow(/Access denied/);
  }, 30_000);

  test("unsafe arguments and names are rejected before anything runs", () => {
    for (const args of [["--password=x"], ["-p"], ["positional"], ["--host=evil"], ["--defaults-file=/x"], ["--plugin-dir=/x"], ["--ssl"]]) {
      expect(() => dumpStream(admin, bigDb.schema, args)).toThrow();
    }
    expect(() => dumpStream(admin, bigDb.schema, [], { tables: ["line\nbreak"] })).toThrow(/control character/);
    expect(() => dumpStream({ ...admin, host: "a\nplugin-dir=/tmp" }, bigDb.schema, [])).toThrow();
    expect(() => dumpStream({ ...admin, user: "a\nb" }, bigDb.schema, [])).toThrow();
  });

  test("names that start with a dash are passed as names, never as options", async () => {
    await rootQuery(`CREATE TABLE \`${bigDb.schema}\`.\`-archive\` (id INT PRIMARY KEY)`);
    await rootQuery(`INSERT INTO \`${bigDb.schema}\`.\`-archive\` VALUES (7)`);
    const dump = dumpStream(admin, bigDb.schema, ["--skip-comments"], { tables: ["-archive"] });
    const [text] = await Promise.all([new Response(dump.stdout).text(), dump.done]);
    expect(text).toContain("CREATE TABLE `-archive`");
    expect(text).toContain("(7)");
    const bogus = dumpStream(admin, "--all-databases", []);
    const [out] = await Promise.all([new Response(bogus.stdout).text(), bogus.done.catch((err: Error) => err)]);
    expect(out).not.toContain("CREATE DATABASE");
    expect(await bogus.done.catch((err: unknown) => err)).toBeInstanceOf(MariaDbToolError);
    await rootQuery(`DROP TABLE \`${bigDb.schema}\`.\`-archive\``);
  });
});
