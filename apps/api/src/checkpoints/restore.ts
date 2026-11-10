import type { RowDataPacket } from "mysql2/promise";
import type { Checkpoint, CheckpointRestoreJobResult, CodeObjectFailure } from "@lambdata/shared";
import { audit, checkpoints, databases } from "../db/queries";
import type { CheckpointEntryRecord } from "../db/queries/checkpoints";
import {
  applyCodeRecords,
  captureCodeRecords,
  ownAccountOf,
  parseRenderedCode,
  type Account,
  type CodeKind,
  type CodeRecord,
} from "../mariadb/codeObjects";
import { openAdminConnection, withRootConnection } from "../mariadb/controller";
import { sanitizeMariaDbMessage } from "../mariadb/messages";
import { loadStream, runSql } from "../mariadb/process";
import { createStagingSchema, dropSchemaIfExists, type SwapResult } from "../mariadb/schemaSwap";
import { IMPORT_USER_PREFIX, SCOPED_USER_PREFIX, withScopedAccount, type ScopedAccount } from "../mariadb/scopedAccount";
import { withWriteFence } from "../mariadb/writeFence";
import { JobFailure } from "../jobs";
import { quoteIdent } from "../util/ident";
import { invalidViewNames, LOCAL_TOOL_TIMEOUT_MS, type ProgressHooks } from "./capture";
import { filterLines, LOAD_PREAMBLE, schemaHash } from "./sql";
import { gunzipObject, hasObject, readObjectText } from "./store";
import { displayName, OBJECT_HEADER, openCaptureConnection, quoteTableName, type SchemaDefaults } from "./tables";
import {
  changedNothing,
  checkpointSwap,
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
} from "./fencedSwap";

export class CheckpointDataMissingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CheckpointDataMissingError";
  }
}

export class RestoreVerificationError extends Error {
  readonly problems: string[];

  constructor(subject: string, problems: string[], reason = "after loading the checkpoint into a staging copy, it did not match what the checkpoint recorded") {
    const shown = problems.slice(0, 8).join("; ");
    const more = problems.length > 8 ? `; and ${problems.length - 8} more` : "";
    super(`${subject} was stopped before anything changed: ${reason}, so the live database was left exactly as it was. ${shown}${more}.`);
    this.name = "RestoreVerificationError";
    this.problems = problems;
  }
}

export class CodeRestoreRefusedError extends RestoreVerificationError {
  readonly failures: CodeObjectFailure[];

  constructor(subject: string, failures: CodeObjectFailure[]) {
    super(
      subject,
      [`these could not be re-created: ${describeFailures(failures)}`],
      "a trial run in the staging copy showed that some of its views, triggers or routines cannot be re-created here",
    );
    this.message = `${this.message} You can roll back anyway: the tables come back without these objects, and the current state is saved in a safety checkpoint first.`;
    this.name = "CodeRestoreRefusedError";
    this.failures = failures;
  }
}

export class RestoreBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RestoreBlockedError";
  }
}

const encoder = new TextEncoder();
const LEGACY_DROP = /^(?:CREATE DATABASE\b|USE\s+`)/i;
const HEAD_LIMIT = 4 * 1024 * 1024;
const HEAD_END = /\n(?:INSERT INTO |DO SETVAL|SELECT SETVAL|LOCK TABLES |\/\*!40000 ALTER TABLE )/;
const QUALIFIED = String.raw`\`((?:[^\`]|\`\`)+)\`\.\`((?:[^\`]|\`\`)+)\``;
const FK_TARGET = new RegExp(String.raw`REFERENCES ${QUALIFIED}`, "g");
const SEQUENCE_TARGET = new RegExp(String.raw`nextval\(${QUALIFIED}\)`, "gi");
const SAFE_CHARSET = /^[a-z0-9_]{1,64}$/i;
const DRY_RUN_KINDS: CodeKind[] = ["EVENT"];
const OUTSIDE_ACCESS = /\bcommand denied\b|\bAccess denied\b|\bERROR (?:1044|1142|1143|1370)\b/i;
const OUTSIDE_EXPLAINED = /^(reads|writes to|calls|uses) (.+), which is outside this database$/;
const OUTSIDE_TABLE = /\bfor table ((?:`(?:[^`]|``)+`\.)?`(?:[^`]|``)+`)/;
const ACCOUNT_NOTE = / (?:to|for) user '[^']*'@'[^']*'/g;
const DROP_ORDER: CodeKind[] = ["TRIGGER", "VIEW", "EVENT", "PACKAGE BODY", "PACKAGE", "FUNCTION", "PROCEDURE"];

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function unquote(token: string): string {
  return token.replaceAll("``", "`");
}

export function toReadable(
  iter: AsyncGenerator<Uint8Array>,
  onError: (err: unknown) => void,
  onClose?: () => void,
): ReadableStream<Uint8Array> {
  let closed = false;
  const close = (): void => {
    if (closed) return;
    closed = true;
    onClose?.();
  };
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await iter.next();
        if (done) {
          close();
          controller.close();
        } else {
          controller.enqueue(value);
        }
      } catch (err) {
        close();
        onError(err);
        controller.error(err);
      }
    },
    async cancel() {
      close();
      await iter.return(undefined).catch(() => {});
    },
  });
}

export function assertObjectsPresent(databaseId: string, entries: CheckpointEntryRecord[]): void {
  const missing = entries.filter((e) => !hasObject(databaseId, e.objectHash));
  if (missing.length > 0) {
    throw new CheckpointDataMissingError(
      `checkpoint data is missing for ${missing
        .slice(0, 5)
        .map((e) => e.name)
        .join(", ")}${missing.length > 5 ? ` and ${missing.length - 5} more` : ""}`,
    );
  }
}

function startsWith(bytes: Uint8Array, prefix: Uint8Array): boolean {
  if (bytes.length < prefix.length) return false;
  for (let i = 0; i < prefix.length; i++) if (bytes[i] !== prefix[i]) return false;
  return true;
}

export async function* withoutStagingDrop(chunks: AsyncIterable<Uint8Array>, name: string): AsyncGenerator<Uint8Array> {
  const header = encoder.encode(`${OBJECT_HEADER} ${displayName(name)}\n`);
  const expected = encoder.encode(`${OBJECT_HEADER} ${displayName(name)}\nDROP TABLE IF EXISTS ${quoteTableName(name)};\n`);
  let head: Uint8Array = new Uint8Array(0);
  let decided = false;
  for await (const chunk of chunks) {
    if (decided) {
      yield chunk;
      continue;
    }
    head = head.length > 0 ? Buffer.concat([head, chunk]) : chunk.slice();
    if (head.length < expected.length && startsWith(expected, head)) continue;
    decided = true;
    if (startsWith(head, expected)) {
      yield header;
      if (head.length > expected.length) yield head.subarray(expected.length);
    } else {
      yield head;
    }
  }
  if (!decided && head.length > 0) yield head;
}

async function* tableInput(databaseId: string, tables: CheckpointEntryRecord[], hooks: ProgressHooks) {
  yield encoder.encode(LOAD_PREAMBLE);
  const total = tables.reduce((n, t) => n + t.logicalBytes, 0) || 1;
  let done = 0;
  for (const t of tables) {
    for await (const chunk of withoutStagingDrop(gunzipObject(databaseId, t.objectHash), t.name)) {
      done += chunk.length;
      hooks.progress?.(0.05 + Math.min(0.45, (done / total) * 0.45));
      yield chunk;
    }
    yield encoder.encode("\n");
  }
}

async function* legacyInput(databaseId: string, entry: CheckpointEntryRecord, hooks: ProgressHooks) {
  const total = entry.logicalBytes || 1;
  let done = 0;
  const counted = (async function* () {
    for await (const chunk of gunzipObject(databaseId, entry.objectHash)) {
      done += chunk.length;
      hooks.progress?.(0.05 + Math.min(0.45, (done / total) * 0.45));
      yield chunk;
    }
  })();
  yield encoder.encode(LOAD_PREAMBLE);
  yield* filterLines(counted, (line) => LEGACY_DROP.test(line));
}

async function readHead(databaseId: string, hash: string): Promise<string> {
  const decoder = new TextDecoder();
  let text = "";
  const iter = gunzipObject(databaseId, hash);
  try {
    for await (const chunk of iter) {
      const from = Math.max(0, text.length - 32);
      text += decoder.decode(chunk, { stream: true });
      const end = HEAD_END.exec(text.slice(from));
      if (end) return text.slice(0, from + end.index);
      if (text.length >= HEAD_LIMIT) return text;
    }
  } finally {
    await iter.return(undefined).catch(() => {});
  }
  return text + decoder.decode();
}

async function otherSchemaReferences(live: string, staging: string): Promise<ExtraGrant[]> {
  const names = await withRootConnection(async (c) => {
    const [rows] = await c.query<RowDataPacket[]>("SELECT SCHEMA_NAME AS n FROM information_schema.SCHEMATA");
    return rows.map((r) => String(r.n));
  });
  const skip = new Set(["mysql", "information_schema", "performance_schema", "sys", live.toLowerCase(), staging.toLowerCase()]);
  return names
    .filter((n) => !skip.has(n.toLowerCase()) && !n.startsWith("_ld_"))
    .map((schema) => ({ schema, table: null, privileges: "REFERENCES" }));
}

interface ExtraGrant {
  schema: string;
  table: string | null;
  privileges: string;
}

async function loadRequirements(databaseId: string, tables: CheckpointEntryRecord[], live: string): Promise<ExtraGrant[]> {
  const local = new Set(tables.map((t) => t.name));
  const grants = new Map<string, ExtraGrant>();
  for (const t of tables) {
    const head = await readHead(databaseId, t.objectHash);
    for (const m of head.matchAll(FK_TARGET)) {
      const schema = unquote(m[1]!);
      if (schema === live) continue;
      grants.set(`ref:${schema}`, { schema, table: null, privileges: "REFERENCES" });
    }
    for (const m of head.matchAll(SEQUENCE_TARGET)) {
      const schema = unquote(m[1]!);
      const table = unquote(m[2]!);
      if (schema === live && !local.has(table)) continue;
      grants.set(`seq:${schema}.${table}`, { schema, table, privileges: "SELECT, INSERT" });
    }
  }
  return [...grants.values()];
}

async function missingSequences(live: string, grants: ExtraGrant[]): Promise<string[]> {
  const needed = grants.filter((g) => g.table !== null);
  if (needed.length === 0) return [];
  const present = await withRootConnection(async (c) => {
    const [rows] = await c.query<RowDataPacket[]>(
      `SELECT TABLE_SCHEMA AS s, TABLE_NAME AS t FROM information_schema.TABLES WHERE TABLE_TYPE = 'SEQUENCE' AND TABLE_SCHEMA IN (?)`,
      [[...new Set(needed.map((g) => g.schema))]],
    );
    return new Set(rows.map((r) => `${String(r.s)}.${String(r.t)}`));
  });
  return needed
    .filter((g) => !present.has(`${g.schema}.${g.table}`))
    .map((g) => (g.schema === live ? displayName(g.table!) : `${displayName(g.schema)}.${displayName(g.table!)}`));
}

async function grantExtras(account: ScopedAccount, grants: ExtraGrant[]): Promise<void> {
  if (grants.length === 0) return;
  await withRootConnection(async (c) => {
    for (const g of grants) {
      const target = `${quoteTableName(g.schema)}.${g.table === null ? "*" : quoteTableName(g.table)}`;
      for (const host of account.hosts) await c.query(`GRANT ${g.privileges} ON ${target} TO ?@?`, [account.user, host]);
    }
  });
}

function friendlyLoadError(err: unknown, account: ScopedAccount): Error {
  const message = sanitizeMariaDbMessage(errorMessage(err).replaceAll(account.user, "the loading account"));
  return new Error(`loading the checkpoint into a staging copy failed: ${message}`, { cause: err });
}

async function loadAsScoped(
  staging: string,
  input: AsyncGenerator<Uint8Array>,
  opts: { setUser: boolean; grants?: ExtraGrant[] },
): Promise<void> {
  return withScopedAccount({ schemas: [staging], setUser: opts.setUser }, async (account) => {
    await grantExtras(account, opts.grants ?? []);
    let streamError: unknown = null;
    const stream = toReadable(input, (err) => {
      streamError = err;
    });
    try {
      await loadStream(account.target, staging, stream, { timeoutMs: LOCAL_TOOL_TIMEOUT_MS });
    } catch (err) {
      throw streamError ?? friendlyLoadError(err, account);
    }
    if (streamError) throw streamError;
  });
}

async function runCodeTextInStaging(staging: string, text: string): Promise<void> {
  await withScopedAccount({ schemas: [staging], setUser: true }, async (account) => {
    try {
      await runSql(account.target, staging, text, { timeoutMs: LOCAL_TOOL_TIMEOUT_MS });
    } catch (err) {
      throw friendlyLoadError(err, account);
    }
  });
}

async function verifyStaging(staging: string, tables: CheckpointEntryRecord[]): Promise<string[]> {
  const problems: string[] = [];
  const conn = await openCaptureConnection();
  try {
    const [present] = await conn.query<RowDataPacket[]>(
      `SELECT TABLE_NAME AS name FROM information_schema.TABLES WHERE TABLE_SCHEMA = ?`,
      [staging],
    );
    const loaded = new Set(present.map((r) => String(r.name)));
    for (const t of tables) {
      const label = displayName(t.name);
      if (!loaded.has(t.name)) {
        problems.push(`table ${label} is missing after loading`);
        continue;
      }
      const ref = `${quoteIdent(staging)}.${quoteTableName(t.name)}`;
      if (t.schemaHash !== null) {
        const [create] = await conn.query<RowDataPacket[]>(`SHOW CREATE TABLE ${ref}`);
        const ddl = create[0]?.["Create Table"];
        if (typeof ddl !== "string" || schemaHash(ddl) !== t.schemaHash) {
          problems.push(`table ${label} has a different structure after loading`);
          continue;
        }
      }
      const [count] = await conn.query<RowDataPacket[]>(`SELECT COUNT(*) AS n FROM ${ref}`);
      const rows = Number(count[0]?.n ?? -1);
      if (t.rowCount !== null && rows !== t.rowCount) {
        problems.push(`table ${label} has ${rows} row(s) after loading, the checkpoint recorded ${t.rowCount}`);
        continue;
      }
      if (t.checksum === null) continue;
      const [sum] = await conn.query<RowDataPacket[]>(`CHECKSUM TABLE ${ref}`);
      const checksum = sum[0]?.Checksum === null || sum[0]?.Checksum === undefined ? null : Number(sum[0].Checksum);
      if (checksum !== t.checksum) {
        problems.push(`the contents of table ${label} differ from what the checkpoint recorded (checksum ${t.checksum} recorded, ${checksum ?? "none"} after loading)`);
      }
    }
  } finally {
    await conn.end().catch(() => conn.destroy());
  }
  return problems;
}

async function dropAllCode(schema: string): Promise<void> {
  const conn = await openAdminConnection();
  try {
    const records = await captureCodeRecords(conn, schema);
    for (const kind of DROP_ORDER) {
      for (const r of records.filter((o) => o.kind === kind)) {
        await conn.query(`DROP ${kind} IF EXISTS ${quoteIdent(schema)}.${quoteTableName(r.name)}`);
      }
    }
  } finally {
    await conn.end().catch(() => conn.destroy());
  }
}

function isTemporaryAccount(a: Account | null): boolean {
  return a !== null && (a.user.startsWith(SCOPED_USER_PREFIX) || a.user.startsWith(IMPORT_USER_PREFIX));
}

export async function takeStagingCode(staging: string, owner: Account | null): Promise<CodeRecord[]> {
  const conn = await openAdminConnection();
  let records: CodeRecord[];
  try {
    records = await captureCodeRecords(conn, staging);
  } finally {
    await conn.end().catch(() => conn.destroy());
  }
  if (records.length === 0) return [];
  await dropAllCode(staging);
  return records.map((r) => (isTemporaryAccount(r.definer) && owner ? { ...r, definer: owner } : r));
}

function sameRecord(a: CodeRecord, b: CodeRecord): boolean {
  if (a.kind !== b.kind) return false;
  const nameMatches = a.kind === "VIEW" ? a.name === b.name : a.name.toLowerCase() === b.name.toLowerCase();
  if (!nameMatches || a.createSql !== b.createSql || (a.sqlMode ?? "") !== (b.sqlMode ?? "")) return false;
  if (!a.definer || !b.definer || a.definer.user !== b.definer.user || a.definer.host.toLowerCase() !== b.definer.host.toLowerCase()) return false;
  if (a.kind === "TRIGGER" && (a.trigger?.order ?? 0) !== (b.trigger?.order ?? 0)) return false;
  return true;
}

async function changedCode(live: string, records: CodeRecord[]): Promise<CodeRecord[]> {
  const conn = await openAdminConnection();
  let current: CodeRecord[];
  try {
    current = await captureCodeRecords(conn, live);
  } finally {
    await conn.end().catch(() => conn.destroy());
  }
  return records.filter((r) => !current.some((c) => sameRecord(c, r)));
}

async function dryRunCode(staging: string, live: string, records: CodeRecord[], owner: Account | null): Promise<CodeObjectFailure[]> {
  const changed = await changedCode(live, records);
  if (!changed.some((r) => !DRY_RUN_KINDS.includes(r.kind))) return [];
  const trial = records.filter((r) => !DRY_RUN_KINDS.includes(r.kind));
  const willCreate = (f: { kind: CodeKind; name: string }) =>
    changed.some((r) => r.kind === f.kind && (r.kind === "VIEW" ? r.name === f.name : r.name.toLowerCase() === f.name.toLowerCase()));
  try {
    const result = await applyCodeRecords(staging, trial, { definers: { account: owner, keep: "recorded" }, replace: true });
    return result.failures.filter(willCreate).map(failureRecord);
  } finally {
    await dropAllCode(staging);
  }
}

export interface PreparedStaging {
  staging: string;
  code: CodeRecord[];
  schemaDefaults: SchemaDefaults | null;
  legacy: boolean;
  tolerated: Set<string>;
  forced: CodeObjectFailure[];
}

function schemaDefaultsOf(cp: Checkpoint): SchemaDefaults | null {
  const cs = cp.schemaCharset ?? null;
  const coll = cp.schemaCollation ?? null;
  if (!cs || !coll || !SAFE_CHARSET.test(cs) || !SAFE_CHARSET.test(coll)) return null;
  return { characterSet: cs, collation: coll };
}

export function cleanFailure(f: CodeObjectFailure): CodeObjectFailure {
  return { kind: f.kind, name: f.name, error: sanitizeMariaDbMessage(f.error.replace(ACCOUNT_NOTE, "")) };
}

export function failureRecord(f: { kind: string; name: string; error: string; explanation?: string }): CodeObjectFailure {
  const cleaned = cleanFailure({ kind: f.kind, name: f.name, error: f.error });
  return f.explanation ? { ...cleaned, error: sanitizeMariaDbMessage(f.explanation.replace(ACCOUNT_NOTE, "")) } : cleaned;
}

function describeFailure(f: CodeObjectFailure): string {
  const what = `${f.kind.toLowerCase()} ${displayName(f.name)}`;
  const explained = OUTSIDE_EXPLAINED.exec(f.error);
  if (explained) return `${what} (it ${explained[1]} ${explained[2]} outside this database, which LambData does not re-create automatically)`;
  if (!OUTSIDE_ACCESS.test(f.error)) return `${what} (${f.error})`;
  const target = OUTSIDE_TABLE.exec(f.error)?.[1];
  return `${what} (it reads ${target ?? "something"} outside this database, which LambData does not re-create automatically)`;
}

export function describeFailures(failures: CodeObjectFailure[]): string {
  const shown = failures.slice(0, 6).map(describeFailure).join("; ");
  return `${shown}${failures.length > 6 ? `; and ${failures.length - 6} more` : ""}`;
}

function failureKey(f: { kind: string; name: string }): string {
  return f.kind === "VIEW" ? `${f.kind}:${f.name}` : `${f.kind}:${f.name.toLowerCase()}`;
}

export async function prepareStaging(
  databaseId: string,
  cp: Checkpoint,
  entries: CheckpointEntryRecord[],
  hooks: ProgressHooks,
  subject: string,
  opts: { allowCodeFailures?: boolean } = {},
): Promise<PreparedStaging> {
  const row = databases.byId(databaseId);
  if (!row) throw new Error("database not found");
  const live = row.name;
  const owner = ownAccountOf(live);
  const tolerated = invalidViewNames(cp.limitations ?? []);
  hooks.stage?.(`Loading ${cp.shortHash} into a staging copy`);
  hooks.progress?.(0.05);
  if (cp.format === "legacy") {
    const legacy = entries.find((e) => e.kind === "legacy");
    if (!legacy) throw new CheckpointDataMissingError("the imported snapshot has no data entry");
    const staging = await createStagingSchema(live);
    try {
      const grants = await otherSchemaReferences(live, staging);
      await loadAsScoped(staging, legacyInput(databaseId, legacy, hooks), { setUser: true, grants });
      hooks.stage?.("Separating views, triggers and routines");
      const code = await takeStagingCode(staging, owner);
      return { staging, code, schemaDefaults: null, legacy: true, tolerated, forced: [] };
    } catch (err) {
      await dropSchemaIfExists(staging).catch(() => {});
      throw err;
    }
  }
  const tables = entries.filter((e) => e.kind === "table").sort((a, b) => compare(a.name, b.name));
  const codeEntry = entries.find((e) => e.kind === "code");
  const codeText = codeEntry ? await readObjectText(databaseId, codeEntry.objectHash) : "";
  const parsed = codeText.trim() ? parseRenderedCode(codeText) : [];
  const grants = await loadRequirements(databaseId, tables, live);
  const missing = await missingSequences(live, grants);
  if (missing.length > 0) {
    throw new RestoreBlockedError(
      `${subject} was not started: table definitions in this checkpoint use the sequence(s) ${missing.join(", ")} as a column default, and MariaDB can only load such a table while that sequence exists. Re-create the sequence (for example CREATE SEQUENCE ${missing[0]}) and try again; nothing was changed.`,
    );
  }
  const staging = await createStagingSchema(live);
  try {
    await loadAsScoped(staging, tableInput(databaseId, tables, hooks), { setUser: false, grants });
    hooks.stage?.("Verifying the loaded tables");
    hooks.progress?.(0.55);
    const problems = await verifyStaging(staging, tables);
    if (problems.length > 0) throw new RestoreVerificationError(subject, problems);
    let code: CodeRecord[];
    if (parsed === null) {
      hooks.stage?.("Reading views, triggers and routines stored in the older format");
      await runCodeTextInStaging(staging, codeText);
      code = await takeStagingCode(staging, owner);
    } else {
      code = parsed;
    }
    hooks.stage?.("Checking that every view, trigger and routine can be re-created");
    hooks.progress?.(0.6);
    const failures = (await dryRunCode(staging, live, code, owner))
      .filter((f) => !(f.kind === "VIEW" && tolerated.has(displayName(f.name))));
    if (failures.length > 0 && !opts.allowCodeFailures) throw new CodeRestoreRefusedError(subject, failures);
    const skip = new Set(failures.map(failureKey));
    return {
      staging,
      code: skip.size > 0 ? code.filter((r) => !skip.has(failureKey(r))) : code,
      schemaDefaults: schemaDefaultsOf(cp),
      legacy: false,
      tolerated,
      forced: failures,
    };
  } catch (err) {
    await dropSchemaIfExists(staging).catch(() => {});
    throw err;
  }
}

export function splitSwapOutcome(
  swap: SwapResult,
  tolerated: Set<string>,
): { failures: CodeObjectFailure[]; warnings: string[] } {
  const failures: CodeObjectFailure[] = [];
  const warnings: string[] = [];
  const expected = new Set<string>();
  for (const f of swap.failures) {
    if (f.kind === "VIEW" && tolerated.has(displayName(f.name))) {
      expected.add(f.name);
      warnings.push(`view ${displayName(f.name)} was already broken when the checkpoint was taken and could not be re-created: ${failureRecord(f).error}`);
    } else {
      failures.push(failureRecord(f));
    }
  }
  for (const w of swap.warnings) {
    const kept = /^view (.+) is kept as recorded but cannot be queried/.exec(w);
    if (kept && tolerated.has(displayName(kept[1]!))) continue;
    const failed = /^could not re-create view (.+?): /.exec(w);
    if (failed && expected.has(failed[1]!)) continue;
    warnings.push(w);
  }
  return { failures, warnings };
}

export async function verifyCheckpointLoads(databaseId: string, checkpointId: string, hooks: ProgressHooks = {}): Promise<void> {
  const cp = checkpoints.byId(checkpointId);
  if (!cp || cp.databaseId !== databaseId) throw new Error("checkpoint not found");
  const entries = checkpoints.entries(cp.id);
  assertObjectsPresent(databaseId, entries);
  const prepared = await prepareStaging(databaseId, cp, entries, hooks, `Verifying checkpoint ${cp.shortHash}`);
  await dropSchemaIfExists(prepared.staging);
  checkpoints.setVerified(cp.id, Date.now());
}

export async function restoreLocked(
  databaseId: string,
  checkpointId: string,
  opts: {
    userId: string | null;
    hooks?: ProgressHooks;
    safety: (signal?: AbortSignal) => Promise<string | null>;
    allowCodeFailures?: boolean;
  },
): Promise<CheckpointRestoreJobResult> {
  const hooks = opts.hooks ?? {};
  const row = databases.byId(databaseId);
  if (!row) throw new Error("database not found");
  const cp = checkpoints.byId(checkpointId);
  if (!cp || cp.databaseId !== databaseId) throw new Error("checkpoint not found");
  const entries = checkpoints.entries(cp.id);
  assertObjectsPresent(databaseId, entries);
  const schema = row.name;
  const subject = `Rolling back to ${cp.shortHash}`;
  const previousBase = row.baseCheckpointId;

  let prepared: PreparedStaging;
  try {
    prepared = await prepareStaging(databaseId, cp, entries, hooks, subject, { allowCodeFailures: opts.allowCodeFailures === true });
  } catch (err) {
    if (err instanceof RestoreVerificationError || err instanceof RestoreBlockedError) {
      audit.log(opts.userId, "checkpoint.restore.refused", databaseId, { checkpointId: cp.id, hash: cp.shortHash, reason: err.message.slice(0, 2000) });
    }
    if (err instanceof CodeRestoreRefusedError) {
      throw new JobFailure(err.message, "restore.code-unrestorable", { codeFailures: err.failures, checkpointId: cp.id }, { cause: err });
    }
    throw err;
  }
  const phase = new PhaseTracker();
  let safety: SafetyPoint | null = null;
  let closed = 0;
  let swap: SwapResult | null = null;
  for (let attempt = 0; swap === null; attempt++) {
    if (attempt > 0 && !(await stagingExists(prepared.staging).catch(() => false))) {
      prepared = await prepareStaging(databaseId, cp, entries, hooks, subject, { allowCodeFailures: opts.allowCodeFailures === true });
    }
    phase.reset();
    safety = null;
    let swapStarted = false;
    try {
      swap = await withWriteFence(databaseId, async (fence) => {
        closed += fence.sessionsEnded;
        hooks.stage?.("Saving a safety checkpoint of the current data");
        hooks.progress?.(0.65);
        safety = await safetyPoint(databaseId, () => opts.safety(fence.signal));
        hooks.stage?.("Swapping the checkpoint's tables in");
        hooks.progress?.(0.9);
        swapStarted = true;
        return checkpointSwap.run({
          live: schema,
          staging: prepared.staging,
          code: prepared.code,
          definers: { account: ownAccountOf(schema), keep: "recorded" },
          keepLiveEvents: prepared.legacy,
          schemaDefaults: prepared.schemaDefaults,
          databaseId,
          expectLive: safety.expectLive,
          onPhase: phase.onPhase,
          note: {
            kind: "checkpoint.restore",
            checkpointId: cp.id,
            safetyCheckpointId: safety.checkpointId,
            userId: opts.userId,
            jobId: hooks.jobId ?? null,
          },
        });
      });
    } catch (err) {
      const nothing = !swapStarted || changedNothing(err, phase.phase);
      if (nothing) await discardSafetyPoint(databaseId, safety);
      if (isStale(err) && attempt < STALE_RETRIES) {
        hooks.warn?.(staleRetryNote(err.changed));
        continue;
      }
      if (nothing) await dropSchemaIfExists(prepared.staging).catch(() => {});
      if (isStale(err)) throw staleFailure(subject, err.changed);
      throw phase.explain(err);
    }
  }
  const safetyCheckpointId: string | null = (safety as SafetyPoint | null)?.created ? (safety as SafetyPoint | null)!.checkpointId : null;
  databases.setBaseCheckpoint(databaseId, cp.id);
  const outcome = splitSwapOutcome(swap, prepared.tolerated);
  const warnings = outcome.warnings;
  const forced = prepared.forced;
  const forcedKeys = new Set(forced.map(failureKey));
  const failures = [...forced, ...outcome.failures.filter((f) => !forcedKeys.has(failureKey(f)))];
  const savedIn = beforeRollbackCheckpoint(safetyCheckpointId, previousBase);
  if (outcome.failures.length > 0) {
    warnings.unshift(
      `The tables of ${cp.shortHash} are back, but ${outcome.failures.length} view(s), trigger(s), routine(s) or event(s) could not be re-created: ${describeFailures(outcome.failures)}.${savedIn ? ` The state before this rollback is saved in checkpoint ${savedIn}.` : ""}`,
    );
  }
  if (forced.length > 0) {
    warnings.unshift(
      `Rolled back anyway: the tables of ${cp.shortHash} are back, but ${forced.length} view(s), trigger(s) or routine(s) could not be re-created and are now missing from the live database: ${describeFailures(forced)}.${savedIn ? ` Their previous definitions are in checkpoint ${savedIn}, saved before this rollback.` : ""}`,
    );
  }
  const closedNote = connectionsClosedWarning(closed, "while the safety checkpoint was taken and the tables were swapped");
  if (closedNote) warnings.push(closedNote);
  for (const w of warnings) hooks.warn?.(w);
  audit.log(opts.userId, "checkpoint.restore", databaseId, {
    checkpointId: cp.id,
    hash: cp.shortHash,
    safetyCheckpointId,
    outcome: failures.length > 0 ? "done-with-errors" : "done",
    codeFailures: failures.length,
    ...(forced.length > 0 ? { forced: true, objects: forced.map((f) => `${f.kind.toLowerCase()} ${f.name}`) } : {}),
  });
  hooks.progress?.(1);
  return {
    restoredCheckpointId: cp.id,
    safetyCheckpointId,
    outcome: failures.length > 0 ? "done-with-errors" : "done",
    codeFailures: failures,
  };
}

function beforeRollbackCheckpoint(safetyCheckpointId: string | null, previousBase: string | null): string | null {
  const id = safetyCheckpointId ?? previousBase;
  if (!id) return null;
  return checkpoints.byId(id)?.shortHash ?? null;
}

