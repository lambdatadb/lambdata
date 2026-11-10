import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import mysql, { type RowDataPacket } from "mysql2/promise";
import type { CodeObjectFailure, SyncJob } from "@lambdata/shared";
import { checkpoints, databases, syncJobs } from "../db/queries";
import { decryptSecret } from "../util/crypto";
import { DiskSpaceError } from "../util/disk";
import { captureCodeRecords, type CodeRecord } from "../mariadb/codeObjects";
import { dumpStream, loadStream, sanitizeToolOutput, type DumpHandle, type DumpOptions, type Target } from "../mariadb/process";
import { createStagingSchema, dropSchemaIfExists, type ExpectLive, type SwapResult } from "../mariadb/schemaSwap";
import { withScopedAccount, type ScopedAccount } from "../mariadb/scopedAccount";
import { withWriteFence } from "../mariadb/writeFence";
import { isDatabaseBusy, JobConflictError, sanitizeErrorMessage, startJob, type JobContext } from "../jobs";
import { intervalService, registerService } from "../lifecycle";
import { createCheckpoint, invalidateWorkingCopyStatus } from "../checkpoints";
import { collectLiveStats, liveCodeHash, TABLE_TYPES } from "../checkpoints/capture";
import { failureRecord, toReadable } from "../checkpoints/restore";
import {
  changedNothing,
  checkpointSwap,
  discardSafetyPoint,
  isStale,
  PhaseTracker,
  safetyPoint,
  stagingExists,
  STALE_RETRIES,
  staleFailure,
  staleRetryNote,
  type SafetyPoint,
} from "../checkpoints/fencedSwap";
import { noteSkippedForDisk } from "../checkpoints/scheduler";
import { diffAgainstLive } from "../checkpoints/status";
import { collectMetricsFor } from "./metrics";

export const SYNC_TIMEOUT_MS = 2 * 60 * 60 * 1000;
const CONNECT_TIMEOUT_MS = 15_000;
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;
const MAX_ERROR_LENGTH = 1000;

export interface SyncSourceFields {
  sourceKind: "mysql" | "postgres";
  sourceHost: string;
  sourceUser: string;
  sourceDatabase: string;
}

export function syncSourceProblem(f: SyncSourceFields): string | null {
  const checks: [string, string, number][] = [
    ["sourceHost", f.sourceHost, 255],
    ["sourceUser", f.sourceUser, 128],
    ["sourceDatabase", f.sourceDatabase, 64],
  ];
  for (const [label, value, max] of checks) {
    if (!value || value.length > max) return `${label} must be 1 to ${max} characters`;
    if (value.startsWith("-")) return `${label} must not start with "-"`;
    if (CONTROL_CHARS.test(value)) return `${label} must not contain control characters`;
  }
  if (/\s/.test(f.sourceHost)) return "sourceHost must not contain spaces";
  if (f.sourceKind === "postgres" && (/[=]/.test(f.sourceDatabase) || /^postgres(?:ql)?:/i.test(f.sourceDatabase))) {
    return "sourceDatabase must be a database name, not a connection string";
  }
  return null;
}

export const SYNC_DUMP_ARGS = [
  "--single-transaction",
  "--quick",
  "--skip-triggers",
  "--skip-add-locks",
  "--no-tablespaces",
  "--skip-dump-date",
  "--hex-blob",
  "--default-character-set=utf8mb4",
];

export const syncSource = {
  dump(target: Target, schema: string, args: string[], opts: DumpOptions): DumpHandle {
    return dumpStream(target, schema, args, opts);
  },
};

export interface SyncRunResult {
  status: "ok";
  tables: number;
  preSyncCheckpointId: string | null;
  checkpointId: string | null;
  unchanged: boolean | null;
  outcome: "done" | "done-with-errors";
  codeFailures: CodeObjectFailure[];
}

interface Source {
  kind: "mysql" | "postgres";
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
}

function cleanError(err: unknown, secrets: string[]): string {
  const text = sanitizeToolOutput(sanitizeErrorMessage(err), secrets);
  return text.length > MAX_ERROR_LENGTH ? `${text.slice(0, MAX_ERROR_LENGTH)}...` : text;
}

async function listSourceTables(source: Source): Promise<string[]> {
  const conn = await mysql.createConnection({
    host: source.host,
    port: source.port,
    user: source.user,
    password: source.password,
    connectTimeout: CONNECT_TIMEOUT_MS,
  });
  try {
    const [rows] = await conn.query<RowDataPacket[]>(
      `SELECT TABLE_NAME AS name FROM information_schema.TABLES
        WHERE TABLE_SCHEMA = ? AND TABLE_TYPE IN (?) ORDER BY TABLE_NAME`,
      [source.database, TABLE_TYPES],
    );
    const [schemas] = await conn.query<RowDataPacket[]>(
      `SELECT COUNT(*) AS n FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = ?`,
      [source.database],
    );
    if (Number(schemas[0]?.n ?? 0) === 0) throw new Error(`source database ${source.database} was not found`);
    return rows.map((r) => String(r.name));
  } finally {
    await conn.end().catch(() => conn.destroy());
  }
}

function scopedLoadError(err: unknown, account: ScopedAccount, secrets: string[]): Error {
  const text = sanitizeToolOutput(err instanceof Error ? err.message : String(err), secrets).replaceAll(account.user, "the loading account");
  const outside = /ERROR (1044|1045|1142|1143|1227|1370|1410|1396|1211)\b/.test(text) || /Access denied|command denied/i.test(text);
  return new Error(
    outside
      ? `${text}. The source's dump tried to reach something outside the mirror's staging copy; mirrors are loaded with access to that copy only, so nothing was changed.`
      : text,
    { cause: err },
  );
}

async function mysqlIntoStaging(source: Source, staging: string, ctx: JobContext): Promise<{ tables: number; code: CodeRecord[] }> {
  const target: Target = { host: source.host, port: source.port, user: source.user, password: source.password };
  ctx.stage(`Listing tables in ${source.host}/${source.database}`);
  const tables = await listSourceTables(source);
  if (tables.length > 0) {
    ctx.stage(`Copying ${tables.length} table(s) into staging`);
    await withScopedAccount({ schemas: [staging] }, async (account) => {
      const abort = new AbortController();
      const dump = syncSource.dump(target, source.database, SYNC_DUMP_ARGS, {
        tables,
        timeoutMs: SYNC_TIMEOUT_MS,
        signal: abort.signal,
      });
      const load = loadStream(account.target, staging, dump.stdout, { timeoutMs: SYNC_TIMEOUT_MS });
      try {
        await Promise.all([dump.done, load]);
      } catch (err) {
        abort.abort();
        await Promise.allSettled([dump.done, load]);
        throw scopedLoadError(err, account, [source.password]);
      }
    });
  }
  ctx.stage("Copying views, triggers and routines");
  const code = await captureCodeRecords(target, source.database);
  return { tables: tables.length, code };
}

function pgPassFile(password: string): { dir: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), "ld-pg-"));
  const path = join(dir, "pgpass");
  const escaped = password.replaceAll("\\", "\\\\").replaceAll(":", "\\:");
  writeFileSync(path, `*:*:*:*:${escaped}\n`, { mode: 0o600, flag: "wx" });
  return { dir, path };
}

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
  return line
    .replace(/\bpublic\./g, "")
    .replace(/"public"\./g, "")
    .replace(/\bALTER TABLE ONLY\b/gi, "ALTER TABLE")
    .replace(/\bdouble precision\b/gi, "double")
    .replace(/\btimestamp(?:\(\d+\))? with time zone\b/gi, "datetime")
    .replace(/\btimestamp(?:\(\d+\))? without time zone\b/gi, "datetime")
    .replace(/\bbytea\b/gi, "longblob")
    .replace(/\buuid\b/gi, "varchar(36)")
    .replace(/\bjsonb\b/gi, "json")
    .replace(/\bUSING\s+btree\s*\(([^)]+)\)/gi, "($1)");
}

async function* translatedPgDump(stdout: ReadableStream<Uint8Array>): AsyncGenerator<Uint8Array> {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  yield encoder.encode("SET FOREIGN_KEY_CHECKS = 0;\nSET SQL_MODE = 'ANSI_QUOTES';\n");
  let remaining = "";
  const reader = stdout.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const lines = (remaining + decoder.decode(value, { stream: true })).split("\n");
      remaining = lines.pop() ?? "";
      const out: string[] = [];
      for (const line of lines) {
        const t = translatePgLine(line);
        if (t !== null) out.push(t);
      }
      if (out.length > 0) yield encoder.encode(out.join("\n") + "\n");
    }
    remaining += decoder.decode();
    if (remaining) {
      const t = translatePgLine(remaining);
      if (t !== null) yield encoder.encode(t + "\n");
    }
  } finally {
    reader.releaseLock();
  }
}

async function postgresIntoStaging(source: Source, staging: string, ctx: JobContext): Promise<{ tables: number }> {
  const pgDump = Bun.which("pg_dump");
  if (!pgDump) throw new Error("pg_dump not found on PATH; install postgresql-client");
  ctx.stage(`Copying ${source.host}/${source.database} into staging`);
  const pass = pgPassFile(source.password);
  try {
    const proc = Bun.spawn(
      [
        pgDump,
        `--host=${source.host}`,
        `--port=${source.port}`,
        `--username=${source.user}`,
        "--no-password",
        "--inserts",
        "--no-owner",
        "--no-acl",
        "--",
        source.database,
      ],
      {
        stdout: "pipe",
        stderr: "pipe",
        env: { PATH: process.env.PATH ?? "", PGPASSFILE: pass.path, PGCONNECT_TIMEOUT: "15" },
      },
    );
    const timer = setTimeout(() => proc.kill("SIGKILL"), SYNC_TIMEOUT_MS);
    try {
      let streamError: unknown = null;
      const input = toReadable(translatedPgDump(proc.stdout as ReadableStream<Uint8Array>), (err) => {
        streamError = err;
      });
      const stderr = new Response(proc.stderr as ReadableStream<Uint8Array>).text();
      const [exit] = await withScopedAccount({ schemas: [staging] }, async (account) => {
        const load = loadStream(account.target, staging, input, { args: ["--force"], timeoutMs: SYNC_TIMEOUT_MS }).catch((err) => {
          throw scopedLoadError(err, account, [source.password]);
        });
        return Promise.all([proc.exited, load]);
      });
      if (streamError) throw streamError;
      if (exit !== 0) {
        const lines = sanitizeToolOutput(await stderr, [source.password])
          .split(/\r?\n/)
          .filter((l) => l.trim())
          .slice(-3)
          .join(" | ");
        throw new Error(`pg_dump failed (exit ${exit})${lines ? `: ${lines}` : ""}`);
      }
    } finally {
      clearTimeout(timer);
      if (proc.exitCode === null) proc.kill("SIGKILL");
    }
  } finally {
    rmSync(pass.dir, { recursive: true, force: true });
  }
  return { tables: 0 };
}

async function resolveSource(job: SyncJob): Promise<Source> {
  const enc = syncJobs.passwordEncFor(job.databaseId);
  if (!enc) throw new Error("sync job is missing its source password");
  const problem = syncSourceProblem(job);
  if (problem) throw new Error(`sync source is invalid: ${problem}`);
  return {
    kind: job.sourceKind,
    host: job.sourceHost,
    port: job.sourcePort,
    user: job.sourceUser,
    password: await decryptSecret(enc),
    database: job.sourceDatabase,
  };
}

interface LocalCheck {
  changed: boolean;
  expectLive: ExpectLive;
}

async function checkLocalChanges(databaseId: string): Promise<LocalCheck> {
  const capturedAt = Date.now();
  const row = databases.byId(databaseId);
  if (!row) return { changed: true, expectLive: { tables: [], capturedAt } };
  const stats = await collectLiveStats(row.name, false);
  const expectLive: ExpectLive = {
    tables: stats.tables.map((t) => ({ name: t.name, rowCount: t.rowCount, checksum: t.checksum })),
    capturedAt,
  };
  const base = row.baseCheckpointId ? checkpoints.byId(row.baseCheckpointId) : null;
  if (base && base.databaseId === databaseId && base.format !== "legacy") {
    const codeHash = stats.codeObjects > 0 ? await liveCodeHash(row.name) : null;
    const diff = diffAgainstLive(base.id, checkpoints.entries(base.id), { stats, codeHash, computedAt: Date.now() });
    return { changed: diff.tables.length > 0 || diff.codeChanged, expectLive };
  }
  if (checkpoints.countForDatabase(databaseId) > 0) return { changed: true, expectLive };
  return { changed: stats.tables.length > 0 || stats.codeObjects > 0, expectLive };
}

export async function runSync(databaseId: string, ctx: JobContext): Promise<SyncRunResult> {
  const job = syncJobs.byDatabaseId(databaseId);
  if (!job) throw new Error("no sync is configured for this database");
  const row = databases.byId(databaseId);
  if (!row) throw new Error("database not found");
  let secrets: string[] = [];
  const ticker = setInterval(() => {
    collectMetricsFor(databaseId).catch(() => {});
  }, 5_000);
  try {
    const source = await resolveSource(job);
    secrets = [source.password];
    const policyOn = row.versioned && checkpoints.policy(databaseId).checkpointOnSync;
    const staging = await createStagingSchema(row.name);
    let tables = 0;
    let code: CodeRecord[] = [];
    try {
      if (source.kind === "mysql") {
        const loaded = await mysqlIntoStaging(source, staging, ctx);
        tables = loaded.tables;
        code = loaded.code;
      } else {
        await postgresIntoStaging(source, staging, ctx);
      }
    } catch (err) {
      await dropSchemaIfExists(staging).catch(() => {});
      throw err;
    }
    let preSyncCheckpointId: string | null = null;
    const subject = `The sync of ${row.name}`;
    const phase = new PhaseTracker();
    let currentStaging = staging;
    const reload = async (): Promise<void> => {
      if (await stagingExists(currentStaging).catch(() => false)) return;
      currentStaging = await createStagingSchema(row.name);
      try {
        if (source.kind === "mysql") code = (await mysqlIntoStaging(source, currentStaging, ctx)).code;
        else await postgresIntoStaging(source, currentStaging, ctx);
      } catch (err) {
        await dropSchemaIfExists(currentStaging).catch(() => {});
        throw err;
      }
    };
    const swapIn = (expectLive: ExpectLive | undefined, safetyCheckpointId: string | null): Promise<SwapResult> => {
      ctx.stage("Swapping the new data in");
      phase.reset();
      return checkpointSwap.run({
        live: row.name,
        staging: currentStaging,
        code,
        definers: { account: { user: row.mysqlUser, host: row.connectionsFrom }, keep: "account" },
        databaseId,
        ...(expectLive ? { expectLive } : {}),
        onPhase: phase.onPhase,
        note: { kind: "sync.run", jobId: ctx.jobId, safetyCheckpointId },
      });
    };
    const fencedSwap = async (): Promise<SwapResult> => {
      for (let attempt = 0; ; attempt++) {
        if (attempt > 0) await reload();
        let safety: SafetyPoint | null = null;
        try {
          return await withWriteFence(databaseId, async (fence) => {
            ctx.stage("Checking the mirror for local changes again");
            const check = await checkLocalChanges(databaseId);
            let expectLive = check.expectLive;
            if (check.changed) {
              ctx.stage("Saving a pre-sync checkpoint");
              safety = await safetyPoint(databaseId, async () =>
                (
                  await createCheckpoint(databaseId, {
                    trigger: "pre-sync",
                    message: `Before sync from ${source.host}/${source.database}`,
                    hooks: { warn: (m) => ctx.warn(m) },
                    signal: fence.signal,
                  })
                ).checkpointId,
              );
              preSyncCheckpointId = safety.created ? safety.checkpointId : null;
              expectLive = safety.expectLive;
            }
            if (fence.sessionsEnded > 0) {
              ctx.warn(
                check.changed
                  ? `${fence.sessionsEnded} connection(s) to this mirror were closed while its local changes were saved`
                  : `${fence.sessionsEnded} connection(s) to this mirror were closed while it was checked for local changes`,
              );
            }
            return swapIn(expectLive, safety?.checkpointId ?? null);
          });
        } catch (err) {
          if (changedNothing(err, phase.phase) && (await discardSafetyPoint(databaseId, safety))) preSyncCheckpointId = null;
          if (isStale(err) && attempt < STALE_RETRIES) {
            ctx.warn(staleRetryNote(err.changed));
            continue;
          }
          throw err;
        }
      }
    };
    let swap: SwapResult;
    try {
      if (!policyOn) {
        swap = await swapIn(undefined, null);
      } else {
        ctx.stage("Checking the mirror for local changes");
        const check = await checkLocalChanges(databaseId);
        if (check.changed) {
          swap = await fencedSwap();
        } else {
          try {
            swap = await swapIn(check.expectLive, null);
          } catch (err) {
            if (!isStale(err)) throw err;
            ctx.warn(`The mirror was written to while it was being checked (${err.changed.slice(0, 5).join(", ")}), so its local changes are saved in a pre-sync checkpoint first.`);
            await reload();
            swap = await fencedSwap();
          }
        }
      }
    } catch (err) {
      if (changedNothing(err, phase.phase)) await dropSchemaIfExists(currentStaging).catch(() => {});
      if (isStale(err)) throw staleFailure(subject, err.changed);
      throw phase.explain(err);
    }
    const codeFailures: CodeObjectFailure[] = swap.failures.map(failureRecord);
    for (const w of swap.warnings) ctx.warn(w);
    invalidateWorkingCopyStatus(databaseId);
    syncJobs.recordRun(databaseId, "ok", null);
    let checkpointId: string | null = null;
    let unchanged: boolean | null = null;
    if (policyOn) {
      ctx.stage("Recording a sync checkpoint");
      try {
        const after = await createCheckpoint(databaseId, {
          trigger: "sync",
          message: `Synced from ${source.host}/${source.database}`,
          hooks: { warn: (m) => ctx.warn(m) },
        });
        checkpointId = after.checkpointId;
        unchanged = after.unchanged;
      } catch (err) {
        ctx.warn(`the sync succeeded but its checkpoint failed: ${cleanError(err, secrets)}`);
      }
    }
    return {
      status: "ok",
      tables,
      preSyncCheckpointId,
      checkpointId,
      unchanged,
      outcome: codeFailures.length > 0 ? "done-with-errors" : "done",
      codeFailures,
    };
  } catch (err) {
    const message = cleanError(err, secrets);
    syncJobs.recordRun(databaseId, "error", message);
    throw new Error(message);
  } finally {
    clearInterval(ticker);
    invalidateWorkingCopyStatus(databaseId);
    await collectMetricsFor(databaseId).catch(() => {});
  }
}

export function startSyncJob(databaseId: string, userId: string | null) {
  return startJob({ kind: "sync.run", databaseId, userId }, (ctx) => runSync(databaseId, ctx));
}

export function runDueSyncs(now: number = Date.now()): string[] {
  const started: string[] = [];
  for (const j of syncJobs.listEnabled()) {
    try {
      const due = !j.lastRunAt || now - j.lastRunAt >= j.intervalSeconds * 1000;
      if (!due || isDatabaseBusy(j.databaseId)) continue;
      started.push(startSyncJob(j.databaseId, null).id);
    } catch (err) {
      if (err instanceof JobConflictError) continue;
      if (err instanceof DiskSpaceError) {
        noteSkippedForDisk("sync", err, now);
        break;
      }
      console.error("[sync] could not start a scheduled sync:", sanitizeErrorMessage(err));
    }
  }
  return started;
}

export const syncService = registerService(
  intervalService({
    name: "sync",
    intervalMs: 30_000,
    tick() {
      runDueSyncs();
    },
  }),
);
