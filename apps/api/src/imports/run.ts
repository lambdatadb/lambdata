import { writeFile } from "node:fs/promises";
import { HTTPException } from "hono/http-exception";
import type { RowDataPacket } from "mysql2/promise";
import type {
  CodeObjectFailure,
  ImportCreateDatabaseResponse,
  ImportJobResult,
  ImportMode,
  ImportPlan,
  ImportRecord,
  Job,
  SqlImportPlan,
  User,
} from "@lambdata/shared";
import { audit, checkpoints, databases, imports } from "../db/queries";
import { importRuns, publicUpload, type StoredUpload } from "../db/queries/imports";
import { provisionDatabase } from "../databases/provision";
import { startJob, sanitizeErrorMessage, type JobContext } from "../jobs";
import { applyCodeRecords, objectsDefinedBy, type CodeRecord } from "../mariadb/codeObjects";
import { mariadbState, withRootConnection } from "../mariadb/controller";
import { createStagingSchema, dropSchemaIfExists, swapStagingIntoLive, type SwapOptions, type SwapResult } from "../mariadb/schemaSwap";
import { withWriteFence } from "../mariadb/writeFence";
import { captureLiveCode } from "../checkpoints/capture";
import { describeFailures, failureRecord, takeStagingCode } from "../checkpoints/restore";
import {
  changedNothing,
  connectionsClosedWarning,
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
import { newId } from "../util/id";
import { quoteIdent } from "../util/ident";
import { readHead } from "./detect";
import { DumpRewriter, rewriteSummaryWarnings } from "./dumpRewrite";
import { afterImport, beforeReplace } from "./hooks";
import { loadSqlDumpIntoSchema } from "./sqlLoad";
import { loadSqliteIntoSchema, type LoadReporter } from "./sqliteLoad";
import { BLUEPRINT_VERSION, PlanError, buildSqliteBlueprint, type SqliteBlueprint } from "./sqlitePlan";
import { deleteUpload, markUploadInUse, planCachePath, uploadPath } from "./uploads";

const PREFERRED_NOCASE = "utf8mb4_uca1400_nopad_as_ci";
const FALLBACK_NOCASE = "utf8mb4_unicode_nopad_ci";
const SQL_SCAN_BYTES = 8 * 1024 * 1024;
const ER_UNKNOWN_COLLATION = 1273;

export const importSwap = {
  run(opts: SwapOptions): Promise<SwapResult> {
    return swapStagingIntoLive(opts);
  },
};

let nocaseCached: string | null = null;
const blueprintBuilds = new Map<string, Promise<SqliteBlueprint>>();

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export async function nocaseCollation(): Promise<string> {
  if (nocaseCached) return nocaseCached;
  if (mariadbState() !== "running") return FALLBACK_NOCASE;
  try {
    await withRootConnection(async (c) => {
      await c.query(`SELECT _utf8mb4'a' COLLATE ${PREFERRED_NOCASE} AS probe`);
    });
    nocaseCached = PREFERRED_NOCASE;
  } catch (err) {
    if ((err as { errno?: number }).errno !== ER_UNKNOWN_COLLATION) return FALLBACK_NOCASE;
    nocaseCached = FALLBACK_NOCASE;
  }
  return nocaseCached;
}

async function readCachedBlueprint(upload: StoredUpload, collation: string): Promise<SqliteBlueprint | null> {
  try {
    const file = Bun.file(planCachePath(upload.id));
    if (!(await file.exists())) return null;
    const data = JSON.parse(await file.text()) as SqliteBlueprint;
    if (data.version !== BLUEPRINT_VERSION) return null;
    if (data.plan?.upload?.sha256 !== upload.sha256 || data.plan.upload.id !== upload.id) return null;
    if (data.nocaseCollation !== collation) return null;
    return data;
  } catch {
    return null;
  }
}

export async function getSqliteBlueprint(upload: StoredUpload): Promise<SqliteBlueprint> {
  if (upload.format !== "sqlite") throw new HTTPException(400, { message: "this upload is not a SQLite database" });
  const collation = await nocaseCollation();
  const cached = await readCachedBlueprint(upload, collation);
  if (cached) return cached;
  const key = `${upload.id}:${collation}`;
  let build = blueprintBuilds.get(key);
  if (!build) {
    build = (async () => {
      try {
        const bp = await buildSqliteBlueprint(uploadPath(upload.id), publicUpload(upload), { nocaseCollation: collation });
        await writeFile(planCachePath(upload.id), JSON.stringify(bp), { mode: 0o600 }).catch(() => {});
        return bp;
      } finally {
        blueprintBuilds.delete(key);
      }
    })();
    blueprintBuilds.set(key, build);
  }
  try {
    return await build;
  } catch (err) {
    if (err instanceof PlanError) throw new HTTPException(422, { message: err.message });
    throw err;
  }
}

async function buildSqlPlan(upload: StoredUpload): Promise<SqlImportPlan> {
  const head = await readHead(uploadPath(upload.id), SQL_SCAN_BYTES, upload.compressed);
  const analyzer = new DumpRewriter({ collectRejections: true });
  analyzer.push(head);
  analyzer.finish();
  const mysql8 = /utf8mb4_0900_/i.test(Buffer.from(head.buffer, head.byteOffset, head.byteLength).toString("latin1"));
  return {
    format: "sql",
    upload: publicUpload(upload),
    compressed: upload.compressed,
    warnings: rewriteSummaryWarnings(analyzer.summary, analyzer.rejections, mysql8),
  };
}

export async function getImportPlan(upload: StoredUpload): Promise<ImportPlan> {
  if (upload.format === "sqlite") return (await getSqliteBlueprint(upload)).plan;
  return buildSqlPlan(upload);
}

function countingReporter(ctx: JobContext): LoadReporter & { count: number } {
  const r = {
    count: 0,
    stage: (label: string) => ctx.stage(label),
    progress: (f: number | null) => ctx.progress(f),
    warn: (m: string) => {
      r.count++;
      ctx.warn(m);
    },
  };
  return r;
}

async function baseTableCount(schema: string): Promise<number> {
  return withRootConnection(async (c) => {
    const [rows] = await c.query<RowDataPacket[]>(
      "SELECT COUNT(*) AS n FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_TYPE = 'BASE TABLE'",
      [schema],
    );
    return Number(rows[0]?.n ?? 0);
  });
}

async function codeObjectCount(schema: string): Promise<number> {
  return withRootConnection(async (c) => {
    const [rows] = await c.query<RowDataPacket[]>(
      `SELECT (SELECT COUNT(*) FROM information_schema.VIEWS WHERE TABLE_SCHEMA = ?)
            + (SELECT COUNT(*) FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = ?)
            + (SELECT COUNT(*) FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA = ?)
            + (SELECT COUNT(*) FROM information_schema.EVENTS WHERE EVENT_SCHEMA = ?) AS n`,
      [schema, schema, schema, schema],
    );
    return Number(rows[0]?.n ?? 0);
  });
}

export async function resetSchema(schema: string): Promise<void> {
  const ident = quoteIdent(schema);
  await withRootConnection(async (c) => {
    await c.query(`DROP DATABASE IF EXISTS ${ident}`);
    await c.query(`CREATE DATABASE ${ident} CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
  });
}

function failuresOf(list: { kind: string; name: string; error: string; explanation?: string }[]): CodeObjectFailure[] {
  return list.map(failureRecord);
}

async function moveDefinersToOwner(
  schema: string,
  importUser: string,
  owner: { user: string; host: string },
  reporter: LoadReporter,
): Promise<CodeObjectFailure[]> {
  if ((await objectsDefinedBy(schema, importUser)) === 0) return [];
  const mine = (await captureLiveCode(schema)).filter((r) => r.definer?.user === importUser);
  const result = await applyCodeRecords(schema, mine, { definers: { account: owner, keep: "account" } });
  for (const w of result.warnings) reporter.warn(w);
  const failures = failuresOf(result.failures);
  if (failures.length > 0) {
    reporter.warn(
      `The data was imported, but ${failures.length} view(s), trigger(s), routine(s) or event(s) from the file could not be re-created as the database's own user and will not work until they are re-created: ${describeFailures(failures)}.`,
    );
  }
  return failures;
}

async function extractStagingCode(staging: string, owner: { user: string; host: string }): Promise<CodeRecord[] | undefined> {
  if ((await codeObjectCount(staging)) === 0) return undefined;
  return takeStagingCode(staging, owner);
}

function reportSwap(swap: SwapResult, reporter: LoadReporter, safetyCheckpointId: string | null): CodeObjectFailure[] {
  for (const w of swap.warnings) reporter.warn(w);
  const failures = failuresOf(swap.failures);
  if (failures.length > 0) {
    const saved = safetyCheckpointId ? checkpoints.byId(safetyCheckpointId)?.shortHash : null;
    reporter.warn(
      `The data was replaced, but ${failures.length} view(s), trigger(s), routine(s) or event(s) from the file could not be created and are missing from the database: ${describeFailures(failures)}.${saved ? ` The previous contents are saved in checkpoint ${saved}.` : ""}`,
    );
  }
  return failures;
}

interface ImportTarget {
  databaseId: string;
  schema: string;
  displayName: string;
  owner: { user: string; host: string };
}

async function finishImport(p: {
  target: ImportTarget;
  upload: StoredUpload;
  mode: ImportMode;
  user: User;
  tableCount: number | null;
  rowCount: number | null;
  warningCount: number;
  safetyCheckpointId: string | null;
  reporter: LoadReporter;
  durationMs: number;
  codeFailures: CodeObjectFailure[];
}): Promise<ImportJobResult & { durationMs: number }> {
  const record: Omit<ImportRecord, "importedByDisplayName"> = {
    id: newId("imp"),
    databaseId: p.target.databaseId,
    fileName: p.upload.fileName,
    sizeBytes: p.upload.sizeBytes,
    sha256: p.upload.sha256,
    format: p.upload.format,
    mode: p.mode,
    tableCount: p.tableCount,
    rowCount: p.rowCount,
    warningCount: p.warningCount,
    importedByUserId: p.user.id,
    importedAt: Date.now(),
  };
  imports.insertRecord(record);
  const stored = imports.recordById(record.id) ?? { ...record, importedByDisplayName: p.user.displayName };
  let checkpointId: string | null = null;
  try {
    p.reporter.stage("Recording a checkpoint");
    checkpointId = await afterImport(p.target.databaseId, stored);
  } catch (err) {
    p.reporter.warn(`The import finished, but the checkpoint after it could not be created: ${sanitizeErrorMessage(err)}`);
  }
  await deleteUpload(p.upload.id).catch(() => {});
  audit.log(p.user.id, "db.import", p.target.databaseId, {
    importId: record.id,
    mode: p.mode,
    fileName: p.upload.fileName,
    format: p.upload.format,
    tables: p.tableCount,
    rows: p.rowCount,
  });
  return {
    importId: record.id,
    tableCount: p.tableCount,
    rowCount: p.rowCount,
    safetyCheckpointId: p.safetyCheckpointId,
    checkpointId,
    durationMs: p.durationMs,
    outcome: p.codeFailures.length > 0 ? "done-with-errors" : "done",
    codeFailures: p.codeFailures,
  };
}

async function runCreate(ctx: JobContext, target: ImportTarget, upload: StoredUpload, user: User, blueprint: SqliteBlueprint | null) {
  const reporter = countingReporter(ctx);
  const started = performance.now();
  const path = uploadPath(upload.id);
  let tableCount: number | null;
  let rowCount: number | null;
  let planWarnings = 0;
  let codeFailures: CodeObjectFailure[] = [];
  try {
    if (blueprint) {
      planWarnings = blueprint.plan.totals.warnings;
      const result = await loadSqliteIntoSchema({ blueprint, path, schema: target.schema, reporter, dropTablesOnFailure: true });
      tableCount = result.tableCount;
      rowCount = result.rowCount;
    } else {
      const loaded = await loadSqlDumpIntoSchema({
        path,
        compressed: upload.compressed,
        sizeBytes: upload.sizeBytes,
        schema: target.schema,
        reporter,
        afterLoad: async (importUser) => {
          codeFailures = await moveDefinersToOwner(target.schema, importUser, target.owner, reporter);
        },
      });
      planWarnings = rewriteSummaryWarnings(loaded.summary, [], false).length;
      tableCount = await baseTableCount(target.schema);
      rowCount = null;
    }
  } catch (err) {
    if (!blueprint) await resetSchema(target.schema).catch(() => {});
    throw new Error(
      `Import failed. The new database "${target.displayName}" (${target.schema}) was kept and is empty, so you can retry with "Replace data from file" or delete it. Cause: ${errorMessage(err)}`,
    );
  }
  return finishImport({
    target,
    upload,
    mode: "create",
    user,
    tableCount,
    rowCount,
    warningCount: planWarnings + reporter.count,
    safetyCheckpointId: null,
    reporter,
    durationMs: performance.now() - started,
    codeFailures,
  });
}

interface ReplaceStaging {
  staging: string;
  code: CodeRecord[] | undefined;
  tableCount: number | null;
  rowCount: number | null;
  planWarnings: number;
}

async function loadReplaceStaging(
  ctx: JobContext,
  target: ImportTarget,
  upload: StoredUpload,
  blueprint: SqliteBlueprint | null,
  reporter: LoadReporter,
): Promise<ReplaceStaging> {
  const path = uploadPath(upload.id);
  ctx.stage("Preparing a staging copy");
  const staging = await createStagingSchema(target.schema);
  try {
    if (blueprint) {
      const result = await loadSqliteIntoSchema({ blueprint, path, schema: staging, reporter, dropTablesOnFailure: false });
      return { staging, code: undefined, tableCount: result.tableCount, rowCount: result.rowCount, planWarnings: blueprint.plan.totals.warnings };
    }
    let code: CodeRecord[] | undefined;
    const loaded = await loadSqlDumpIntoSchema({
      path,
      compressed: upload.compressed,
      sizeBytes: upload.sizeBytes,
      schema: staging,
      reporter,
      afterLoad: async () => {
        code = await extractStagingCode(staging, target.owner);
      },
    });
    return {
      staging,
      code,
      tableCount: await baseTableCount(staging),
      rowCount: null,
      planWarnings: rewriteSummaryWarnings(loaded.summary, [], false).length,
    };
  } catch (err) {
    await dropSchemaIfExists(staging).catch(() => {});
    throw err;
  }
}

async function runReplace(ctx: JobContext, target: ImportTarget, upload: StoredUpload, user: User, blueprint: SqliteBlueprint | null) {
  const reporter = countingReporter(ctx);
  const started = performance.now();
  const subject = `Replacing the data of ${target.schema}`;
  let prepared: ReplaceStaging;
  try {
    prepared = await loadReplaceStaging(ctx, target, upload, blueprint, reporter);
  } catch (err) {
    throw new Error(`Import failed and ${target.schema} was not changed. Cause: ${errorMessage(err)}`);
  }
  const phase = new PhaseTracker();
  let safety: SafetyPoint | null = null;
  let closed = 0;
  let swap: SwapResult | null = null;
  for (let attempt = 0; swap === null; attempt++) {
    if (attempt > 0 && !(await stagingExists(prepared.staging).catch(() => false))) {
      try {
        prepared = await loadReplaceStaging(ctx, target, upload, blueprint, reporter);
      } catch (err) {
        throw new Error(`Import failed and ${target.schema} was not changed. Cause: ${errorMessage(err)}`);
      }
    }
    phase.reset();
    safety = null;
    let swapStarted = false;
    const current = prepared;
    try {
      swap = await withWriteFence(target.databaseId, async (fence) => {
        closed += fence.sessionsEnded;
        ctx.stage("Taking a safety checkpoint");
        ctx.progress(0.97);
        safety = await safetyPoint(target.databaseId, () => beforeReplace(target.databaseId, fence.signal));
        const oldCode = await codeObjectCount(target.schema);
        if (oldCode > 0 && current.code === undefined && attempt === 0) {
          reporter.warn(
            `${oldCode} view(s), trigger(s), routine(s) or event(s) from the previous contents were removed with the old tables; the imported file does not define them.`,
          );
        }
        ctx.stage("Swapping the new data into place");
        swapStarted = true;
        return importSwap.run({
          live: target.schema,
          staging: current.staging,
          code: current.code ?? [],
          definers: { account: target.owner, keep: "account" },
          databaseId: target.databaseId,
          expectLive: safety.expectLive,
          onPhase: phase.onPhase,
          note: { kind: "import.replace", jobId: ctx.jobId, safetyCheckpointId: safety.checkpointId },
        });
      });
    } catch (err) {
      const nothing = !swapStarted || changedNothing(err, phase.phase);
      if (nothing) await discardSafetyPoint(target.databaseId, safety);
      if (isStale(err) && attempt < STALE_RETRIES) {
        reporter.warn(staleRetryNote(err.changed));
        continue;
      }
      if (nothing) await dropSchemaIfExists(current.staging).catch(() => {});
      if (isStale(err)) throw staleFailure(subject, err.changed);
      if (nothing) throw new Error(`Import failed and ${target.schema} was not changed. Cause: ${errorMessage(err)}`);
      throw new Error(`Import did not finish cleanly: ${phase.explain(err).message}`);
    }
  }
  const safetyCheckpointId = (safety as SafetyPoint | null)?.checkpointId ?? null;
  const codeFailures = reportSwap(swap, reporter, safetyCheckpointId);
  const closedNote = connectionsClosedWarning(closed, "while the safety checkpoint was taken and the new data was swapped in");
  if (closedNote) reporter.warn(closedNote);
  return finishImport({
    target,
    upload,
    mode: "replace",
    user,
    tableCount: prepared.tableCount,
    rowCount: prepared.rowCount,
    warningCount: prepared.planWarnings + reporter.count,
    safetyCheckpointId,
    reporter,
    durationMs: performance.now() - started,
    codeFailures,
  });
}

export async function createDatabaseFromUpload(p: {
  user: User;
  upload: StoredUpload;
  displayName: string;
  connectionsFrom?: string;
  tailnetOnly?: boolean;
  versioned?: boolean;
}): Promise<ImportCreateDatabaseResponse> {
  const blueprint = p.upload.format === "sqlite" ? await getSqliteBlueprint(p.upload) : null;
  const release = markUploadInUse(p.upload.id);
  try {
    const { database, credentials } = await provisionDatabase({
      displayName: p.displayName,
      ownerUserId: p.user.id,
      connectionsFrom: p.connectionsFrom,
      tailnetOnly: p.tailnetOnly,
      versioned: p.versioned,
    });
    audit.log(p.user.id, "db.create", database.id, { name: database.name, kind: database.kind, importFrom: p.upload.fileName });
    const target: ImportTarget = {
      databaseId: database.id,
      schema: database.name,
      displayName: database.displayName,
      owner: { user: database.mysqlUser, host: database.connectionsFrom },
    };
    const job = startJob(
      { kind: blueprint ? "import.sqlite" : "import.sql", databaseId: database.id, userId: p.user.id },
      async (ctx) => {
        try {
          return await runCreate(ctx, target, p.upload, p.user, blueprint);
        } finally {
          importRuns.finish(ctx.jobId);
          release();
        }
      },
    );
    importRuns.start({ jobId: job.id, databaseId: database.id, mode: "create", schemaName: database.name, startedAt: Date.now() });
    return { database, credentials, job };
  } catch (err) {
    release();
    throw err;
  }
}

export async function replaceDatabaseFromUpload(p: { user: User; databaseId: string; upload: StoredUpload }): Promise<Job> {
  const row = databases.byId(p.databaseId);
  if (!row) throw new HTTPException(404, { message: "database not found" });
  const blueprint = p.upload.format === "sqlite" ? await getSqliteBlueprint(p.upload) : null;
  const target: ImportTarget = {
    databaseId: row.id,
    schema: row.name,
    displayName: row.displayName,
    owner: { user: row.mysqlUser, host: row.connectionsFrom },
  };
  const release = markUploadInUse(p.upload.id);
  try {
    const job = startJob({ kind: blueprint ? "import.sqlite" : "import.sql", databaseId: row.id, userId: p.user.id }, async (ctx) => {
      try {
        return await runReplace(ctx, target, p.upload, p.user, blueprint);
      } finally {
        importRuns.finish(ctx.jobId);
        release();
      }
    });
    importRuns.start({ jobId: job.id, databaseId: row.id, mode: "replace", schemaName: row.name, startedAt: Date.now() });
    return job;
  } catch (err) {
    release();
    throw err;
  }
}
