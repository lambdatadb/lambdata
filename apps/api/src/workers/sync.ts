import type { SyncStatus } from "@kilndb/shared";
import { databases, syncJobs } from "../db/queries";
import { decryptSecret } from "../util/crypto";
import { env } from "../env";
import { getMariaDbBinaries, getRootPassword } from "../mariadb/controller";
import { withRootConnection } from "../mariadb/controller";
import { collectMetricsFor } from "./metrics";

const running = new Set<string>();

export async function runSyncJob(databaseId: string): Promise<{ status: SyncStatus; error?: string }> {
  if (running.has(databaseId)) {
    return { status: "error", error: "sync already in progress" };
  }
  running.add(databaseId);
  // Poll metrics while the dump/load runs so the UI's size-over-time chart
  // visibly moves during a sync instead of jumping once at completion.
  const ticker = setInterval(() => {
    collectMetricsFor(databaseId).catch(() => {});
  }, 5_000);
  try {
    const job = syncJobs.byDatabaseId(databaseId);
    if (!job) throw new Error("no sync job");
    const dbRow = databases.byId(databaseId);
    if (!dbRow) throw new Error("database not found");
    const enriched = syncJobs.listEnabled().find((j) => j.databaseId === databaseId);
    if (!enriched) throw new Error("sync job missing credentials");
    const password = await decryptSecret(enriched.passwordEnc);

    if (job.sourceKind === "mysql") {
      await runMysqlMirror({
        sourceHost: job.sourceHost,
        sourcePort: job.sourcePort,
        sourceUser: job.sourceUser,
        sourcePassword: password,
        sourceDatabase: job.sourceDatabase,
        targetSchema: dbRow.name,
      });
    } else {
      await runPostgresMirror({
        sourceHost: job.sourceHost,
        sourcePort: job.sourcePort,
        sourceUser: job.sourceUser,
        sourcePassword: password,
        sourceDatabase: job.sourceDatabase,
        targetSchema: dbRow.name,
      });
    }
    syncJobs.recordRun(databaseId, "ok", null);
    return { status: "ok" };
  } catch (err) {
    const msg = String((err as Error).message ?? err);
    syncJobs.recordRun(databaseId, "error", msg);
    return { status: "error", error: msg };
  } finally {
    clearInterval(ticker);
    await collectMetricsFor(databaseId).catch(() => {});
    running.delete(databaseId);
  }
}

async function runMysqlMirror(p: {
  sourceHost: string;
  sourcePort: number;
  sourceUser: string;
  sourcePassword: string;
  sourceDatabase: string;
  targetSchema: string;
}): Promise<void> {
  const b = await getMariaDbBinaries();
  const rootPw = await getRootPassword();

  await withRootConnection(async (c) => {
    await c.query(`DROP DATABASE IF EXISTS \`${p.targetSchema}\``);
    await c.query(
      `CREATE DATABASE \`${p.targetSchema}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
    );
  });

  const dump = Bun.spawn(
    [
      b.dump,
      `--host=${p.sourceHost}`,
      `--port=${p.sourcePort}`,
      `--user=${p.sourceUser}`,
      // MariaDB 11.4+ defaults to requiring TLS; many MySQL/MariaDB sources
      // don't have TLS configured, so opt out of the new strict default.
      "--skip-ssl",
      "--single-transaction",
      "--quick",
      "--routines",
      "--triggers",
      "--no-tablespaces",
      p.sourceDatabase,
    ],
    { stdout: "pipe", stderr: "pipe", env: { ...process.env, MYSQL_PWD: p.sourcePassword } },
  );
  const load = Bun.spawn(
    [
      b.client,
      `--host=${env.mariadbBind}`,
      `--port=${env.mariadbPort}`,
      `--user=${env.rootUser}`,
      "--skip-ssl",
      p.targetSchema,
    ],
    {
      stdin: dump.stdout,
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, MYSQL_PWD: rootPw },
    },
  );

  const [dumpExit, loadExit, dumpErr, loadErr] = await Promise.all([
    dump.exited,
    load.exited,
    new Response(dump.stderr).text(),
    new Response(load.stderr).text(),
  ]);
  if (dumpExit !== 0) throw new Error(`mysqldump exited ${dumpExit}: ${dumpErr}`);
  if (loadExit !== 0) throw new Error(`mysql load exited ${loadExit}: ${loadErr}`);
}

async function runPostgresMirror(p: {
  sourceHost: string;
  sourcePort: number;
  sourceUser: string;
  sourcePassword: string;
  sourceDatabase: string;
  targetSchema: string;
}): Promise<void> {
  // Minimal: dump schema+data with pg_dump --inserts --no-owner, then translate types and load.
  // For v1 we keep this strict: require pg_dump on PATH.
  const pgDump = Bun.which("pg_dump");
  if (!pgDump) throw new Error("pg_dump not found on PATH; install postgresql-client");

  await withRootConnection(async (c) => {
    await c.query(`DROP DATABASE IF EXISTS \`${p.targetSchema}\``);
    await c.query(
      `CREATE DATABASE \`${p.targetSchema}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
    );
  });

  const dump = Bun.spawn(
    [
      pgDump,
      `--host=${p.sourceHost}`,
      `--port=${p.sourcePort}`,
      `--username=${p.sourceUser}`,
      "--inserts",
      "--no-owner",
      "--no-acl",
      p.sourceDatabase,
    ],
    {
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, PGPASSWORD: p.sourcePassword },
    },
  );

  const b = await getMariaDbBinaries();
  const rootPw = await getRootPassword();
  const load = Bun.spawn(
    [
      b.client,
      `--host=${env.mariadbBind}`,
      `--port=${env.mariadbPort}`,
      `--user=${env.rootUser}`,
      "--skip-ssl",
      "--force",
      p.targetSchema,
    ],
    {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, MYSQL_PWD: rootPw },
    },
  );

  function translatePgLine(line: string): string | null {
    const trimmed = line.trim();
    if (
      trimmed.startsWith("SET ") ||
      trimmed.startsWith("SELECT pg_catalog") ||
      trimmed.startsWith("CREATE SEQUENCE ") ||
      trimmed.startsWith("ALTER SEQUENCE ") ||
      trimmed.includes("OWNED BY ") ||
      trimmed.includes("pg_catalog.setval") ||
      trimmed.includes("nextval(")
    ) {
      return null;
    }

    let result = line
      .replace(/\bpublic\./g, "")
      .replace(/"public"\./g, "")
      .replace(/\bpublic\b\./g, "")
      .replace(/\bALTER TABLE ONLY\b/gi, "ALTER TABLE")
      .replace(/\bdouble precision\b/gi, "double")
      .replace(/\btimestamp(?:\(\d+\))? with time zone\b/gi, "datetime")
      .replace(/\btimestamp(?:\(\d+\))? without time zone\b/gi, "datetime")
      .replace(/\bbytea\b/gi, "longblob")
      .replace(/\buuid\b/gi, "varchar(36)")
      .replace(/\bjsonb\b/gi, "json")
      .replace(/\bUSING\s+btree\s*\(([^)]+)\)/gi, "($1)");

    return result;
  }

  // Stream translation loop
  const decoder = new TextDecoder();
  let remaining = "";

  const writer = load.stdin;
  writer.write("SET FOREIGN_KEY_CHECKS = 0;\n");
  writer.write("SET SQL_MODE = 'ANSI_QUOTES';\n");

  const reader = dump.stdout.getReader();

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const chunk = decoder.decode(value, { stream: true });
      const lines = (remaining + chunk).split("\n");
      remaining = lines.pop() ?? "";

      for (const line of lines) {
        const translated = translatePgLine(line);
        if (translated !== null) {
          writer.write(translated + "\n");
        }
      }
    }

    if (remaining) {
      const translated = translatePgLine(remaining);
      if (translated !== null) {
        writer.write(translated + "\n");
      }
    }
  } finally {
    writer.end();
  }

  const [dumpExit, loadExit, dumpErr, loadErr] = await Promise.all([
    dump.exited,
    load.exited,
    new Response(dump.stderr).text(),
    new Response(load.stderr).text(),
  ]);
  if (dumpExit !== 0) throw new Error(`pg_dump exited ${dumpExit}: ${dumpErr}`);
  if (loadExit !== 0) throw new Error(`mysql load exited ${loadExit}: ${loadErr}`);
}

let timer: ReturnType<typeof setInterval> | null = null;

export function startSyncScheduler(): void {
  if (timer) return;
  timer = setInterval(async () => {
    const now = Date.now();
    for (const j of syncJobs.listEnabled()) {
      const due = !j.lastRunAt || now - j.lastRunAt >= j.intervalSeconds * 1000;
      if (due) {
        runSyncJob(j.databaseId).catch((err) => console.error("[sync]", err));
      }
    }
  }, 30_000);
}

export function stopSyncScheduler(): void {
  if (timer) clearInterval(timer);
  timer = null;
}

export function syncSchedulerRunning(): boolean {
  return timer !== null;
}
