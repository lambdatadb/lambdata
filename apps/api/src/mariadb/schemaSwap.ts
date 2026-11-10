import type { Connection, RowDataPacket } from "mysql2/promise";
import { audit } from "../db/queries";
import { randAlphaNum } from "../util/id";
import { isSafeIdent, quoteIdent } from "../util/ident";
import {
  captureCodeRecords,
  CodeSession,
  DEFAULT_CODE_LOCK_WAIT_SEC,
  DEFAULT_CODE_TIMEOUT_MS,
  definerResolver,
  existingAccountKeys,
  ownAccountOf,
  quoteName,
  reconcileCode,
  type Account,
  type CodeApplyFailure,
  type CodeKind,
  type CodeRecord,
  type DefinerPolicy,
} from "./codeObjects";
import { mariadbState, openAdminConnection, withRootConnection } from "./controller";
import { readJournals, removeJournal, writeJournal } from "./journal";
import { sanitizeError, sanitizeMariaDbMessage } from "./messages";
import { withScopedAccount } from "./scopedAccount";

export const STAGING_PREFIX = "_ld_stage_";
export const TRASH_PREFIX = "_ld_trash_";
export const QUARANTINE_PREFIX = "_ld_quarantine_";
const PARKED_VIEW_PREFIX = "_ld_oldview_";

export type SwapPhase = "prepared" | "moved-out" | "renamed" | "triggers" | "code" | "done";

export interface SwapOptions {
  live: string;
  staging: string;
  code?: CodeRecord[];
  definers?: DefinerPolicy;
  keepLiveEvents?: boolean;
  schemaDefaults?: { characterSet: string; collation: string } | null;
  lockWaitTimeoutSec?: number;
  codeLockWaitTimeoutSec?: number;
  codeTimeoutMs?: number;
  databaseId?: string | null;
  note?: SwapNote;
  expectLive?: ExpectLive;
  onPhase?: (phase: SwapPhase) => void | Promise<void>;
}

export interface ExpectLive {
  tables: { name: string; rowCount: number | null; checksum: number | null }[];
  capturedAt: number;
}

export type SwapNote = Record<string, string | number | boolean | null>;

export interface SwapHookInfo {
  live: string;
  databaseId: string | null;
  recovered: boolean;
  startedAt: number;
  result: SwapResult | null;
  reason: string | null;
  eventsReplaced: boolean;
}

export type SwapHook = (note: SwapNote | null, info: SwapHookInfo) => void | Promise<void>;

export interface RecoveredSwap {
  live: string;
  databaseId: string | null;
  outcome: "completed" | "rolled-back";
  note: SwapNote | null;
  startedAt: number;
  result: SwapResult | null;
}

export type SwapRecoveryListener = (swap: RecoveredSwap) => void | Promise<void>;

export interface SwapResult {
  outcome: "done" | "done-with-errors";
  warnings: string[];
  failures: CodeApplyFailure[];
  codeApplied: number;
}

export interface SwapBlocker {
  id: number;
  user: string;
  host: string;
  command: string;
  idleSec: number;
  transactionSec: number | null;
  query: string | null;
}

export class SwapBlockedError extends Error {
  readonly blockers: SwapBlocker[];
  readonly errno = 1205;

  constructor(message: string, blockers: SwapBlocker[], cause: unknown) {
    super(message, { cause });
    this.name = "SwapBlockedError";
    this.blockers = blockers;
  }
}

export class SwapRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SwapRefusedError";
  }
}

export class SwapStaleError extends Error {
  readonly changed: string[];

  constructor(live: string, changed: string[]) {
    super(
      `${live} changed after its safety checkpoint was taken (${changed.slice(0, 8).join(", ")}${changed.length > 8 ? `, and ${changed.length - 8} more` : ""}), so nothing was changed`,
    );
    this.name = "SwapStaleError";
    this.changed = changed;
  }
}

export class SwapRollbackIncompleteError extends Error {
  readonly heldIn: string;
  readonly tables: string[];

  constructor(message: string, heldIn: string, tables: string[]) {
    super(message);
    this.name = "SwapRollbackIncompleteError";
    this.heldIn = heldIn;
    this.tables = tables;
  }
}

interface SwapJournal {
  version: 2;
  id: string;
  live: string;
  staging: string;
  trash: string;
  databaseId: string | null;
  createdAt: number;
  phase: "prepared" | "renamed" | "applied";
  outgoing: string[];
  incoming: string[];
  collidingViews: string[];
  parkedViews?: { from: string; to: string }[];
  liveCode: CodeRecord[];
  code: CodeRecord[] | null;
  definers: { account: Account | null; keep: "recorded" | "account" };
  keepKinds: CodeKind[];
  schemaDefaults: { characterSet: string; collation: string } | null;
  codeLockWaitTimeoutSec: number;
  codeTimeoutMs: number;
  lockWaitTimeoutSec?: number;
  note?: SwapNote | null;
  schemaDefaultsDone?: boolean;
}

export interface SwapRecoveryReport {
  completed: string[];
  rolledBack: string[];
  failed: string[];
}

const SUFFIX_LENGTH = 8;
const MAX_IDENT_LENGTH = 64;
const DEFAULT_LOCK_WAIT_TIMEOUT_SEC = 15;
const HANDOFF_WAIT_MS = 10_000;
const STALE_BATCH = 100;
const SYSTEM_SCHEMAS = new Set(["mysql", "information_schema", "performance_schema", "sys"]);
const MOVABLE_TABLE_TYPES = ["BASE TABLE", "SYSTEM VERSIONED", "SEQUENCE"];
const ALL_KINDS: CodeKind[] = ["PACKAGE", "PACKAGE BODY", "FUNCTION", "PROCEDURE", "VIEW", "TRIGGER", "EVENT"];
const ER_LOCK_WAIT_TIMEOUT = 1205;
const SAFE_CHARSET = /^[a-z0-9_]{1,64}$/i;

const inUse = new Set<string>();
const activeJournals = new Set<string>();
const activeSwaps = new Set<Promise<unknown>>();
const recoveryListeners: SwapRecoveryListener[] = [];
const completedHooks: SwapHook[] = [];
const rolledBackHooks: SwapHook[] = [];
const critical = new Map<string, number>();
const PERMANENT_DEFAULTS_ERRNOS = new Set([1115, 1253, 1273, 1302]);
let holdForShutdown = false;
let recoveryChain: Promise<unknown> = Promise.resolve();

function errorMessage(err: unknown): string {
  return sanitizeMariaDbMessage(err instanceof Error ? err.message : String(err));
}

function enterCritical(keys: string[]): () => void {
  for (const k of keys) critical.set(k, (critical.get(k) ?? 0) + 1);
  let left = false;
  return () => {
    if (left) return;
    left = true;
    for (const k of keys) {
      const n = (critical.get(k) ?? 1) - 1;
      if (n > 0) critical.set(k, n);
      else critical.delete(k);
    }
  };
}

export function swapInProgress(databaseIdOrSchema: string): boolean {
  return critical.has(databaseIdOrSchema);
}

function addHook(list: SwapHook[], hook: SwapHook): () => void {
  list.push(hook);
  return () => {
    const i = list.indexOf(hook);
    if (i >= 0) list.splice(i, 1);
  };
}

export function onSwapCompleted(hook: SwapHook): () => void {
  return addHook(completedHooks, hook);
}

export function onSwapRolledBack(hook: SwapHook): () => void {
  return addHook(rolledBackHooks, hook);
}

async function runHooks(list: SwapHook[], j: SwapJournal, info: Omit<SwapHookInfo, "live" | "databaseId" | "startedAt">): Promise<void> {
  for (const hook of [...list]) {
    try {
      await hook(j.note ?? null, { live: j.live, databaseId: j.databaseId, startedAt: j.createdAt, ...info });
    } catch (err) {
      console.error(`[mariadb] a swap hook for ${j.live} failed:`, errorMessage(err));
    }
  }
}

function isManagedSchema(name: string): boolean {
  return name.startsWith(STAGING_PREFIX) || name.startsWith(TRASH_PREFIX);
}

function assertLiveSchema(name: string): void {
  if (!isSafeIdent(name)) throw new Error("invalid schema name");
  if (SYSTEM_SCHEMAS.has(name.toLowerCase())) throw new Error(`refusing to replace system schema ${name}`);
  if (isManagedSchema(name)) throw new Error(`${name} is a staging or trash schema, not a live schema`);
}

function assertManagedSchema(name: string): void {
  if (!isSafeIdent(name) || !isManagedSchema(name)) {
    throw new Error("refusing to drop a schema that is not a staging or trash schema");
  }
}

function quoteCharset(name: unknown, fallback: string): string {
  const s = typeof name === "string" ? name : "";
  return SAFE_CHARSET.test(s) ? s : fallback;
}

function managedName(prefix: string, live: string): string {
  const room = MAX_IDENT_LENGTH - prefix.length - SUFFIX_LENGTH - 1;
  const slug = live.toLowerCase().replace(/[^a-z0-9_]/g, "_").slice(0, room);
  return `${prefix}${randAlphaNum(SUFFIX_LENGTH)}_${slug}`;
}

function pendingJournals(): SwapJournal[] {
  return readJournals<SwapJournal>("swap")
    .map((j) => j.data)
    .filter((j): j is SwapJournal => j !== null && j.version === 2);
}

export function swapRecoveryPending(live?: string): boolean {
  return pendingJournals().some((j) => live === undefined || j.live === live);
}

export function stagingSchemaName(liveSchema: string): string {
  assertLiveSchema(liveSchema);
  return managedName(STAGING_PREFIX, liveSchema);
}

export async function createStagingSchema(liveSchema: string): Promise<string> {
  const name = stagingSchemaName(liveSchema);
  await recoverPendingFor(liveSchema);
  inUse.add(name);
  try {
    await withRootConnection(async (c) => {
      const [rows] = await c.query<RowDataPacket[]>(
        `SELECT DEFAULT_CHARACTER_SET_NAME AS cs, DEFAULT_COLLATION_NAME AS coll
           FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = ?`,
        [liveSchema],
      );
      const cs = quoteCharset(rows[0]?.cs, "utf8mb4");
      const coll = quoteCharset(rows[0]?.coll, "utf8mb4_unicode_ci");
      await c.query(`CREATE DATABASE ${quoteIdent(name)} CHARACTER SET ${cs} COLLATE ${coll}`);
    });
  } catch (err) {
    inUse.delete(name);
    throw err;
  }
  return name;
}

export async function dropSchemaIfExists(name: string): Promise<void> {
  assertManagedSchema(name);
  await withRootConnection(async (c) => {
    await c.query(`DROP DATABASE IF EXISTS ${quoteIdent(name)}`);
  });
  inUse.delete(name);
}

async function scalar(conn: Connection, sql: string, values: unknown[]): Promise<number> {
  const [rows] = await conn.query<RowDataPacket[]>(sql, values);
  return Number(rows[0]?.n ?? 0);
}

async function requireSchema(conn: Connection, name: string): Promise<void> {
  const n = await scalar(conn, `SELECT COUNT(*) AS n FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = ?`, [name]);
  if (n === 0) throw new Error(`schema ${name} does not exist`);
}

async function schemaExists(conn: Connection, name: string): Promise<boolean> {
  return (await scalar(conn, `SELECT COUNT(*) AS n FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = ?`, [name])) > 0;
}

async function assertStagingHasOnlyTables(conn: Connection, staging: string): Promise<void> {
  const found: string[] = [];
  const [other] = await conn.query<RowDataPacket[]>(
    `SELECT TABLE_NAME AS name, TABLE_TYPE AS type FROM information_schema.TABLES
      WHERE TABLE_SCHEMA = ? AND TABLE_TYPE NOT IN (?)`,
    [staging, MOVABLE_TABLE_TYPES],
  );
  if (other.length > 0) found.push(`${other.length} view(s)`);
  const checks: [string, string][] = [
    ["trigger(s)", `SELECT COUNT(*) AS n FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = ?`],
    ["routine(s)", `SELECT COUNT(*) AS n FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA = ?`],
    ["event(s)", `SELECT COUNT(*) AS n FROM information_schema.EVENTS WHERE EVENT_SCHEMA = ?`],
  ];
  for (const [label, sql] of checks) {
    const n = await scalar(conn, sql, [staging]);
    if (n > 0) found.push(`${n} ${label}`);
  }
  if (found.length > 0) {
    throw new Error(
      `staging schema ${staging} must contain base tables only but has ${found.join(", ")}; pass code objects as code records`,
    );
  }
}

async function assertNoInboundForeignKeys(conn: Connection, live: string): Promise<void> {
  const [rows] = await conn.query<RowDataPacket[]>(
    `SELECT CONSTRAINT_SCHEMA AS s, TABLE_NAME AS t, CONSTRAINT_NAME AS c
       FROM information_schema.REFERENTIAL_CONSTRAINTS
      WHERE UNIQUE_CONSTRAINT_SCHEMA = ? AND CONSTRAINT_SCHEMA <> ?`,
    [live, live],
  );
  if (rows.length > 0) {
    const list = rows
      .slice(0, 5)
      .map((r) => `${r.s}.${r.t} (${r.c})`)
      .join(", ");
    throw new Error(
      `tables outside ${live} reference it through foreign keys (${list}); they would follow the old tables out of ${live}`,
    );
  }
}

async function listTables(conn: Connection, schema: string): Promise<string[]> {
  const [rows] = await conn.query<RowDataPacket[]>(
    `SELECT TABLE_NAME AS name FROM information_schema.TABLES
      WHERE TABLE_SCHEMA = ? AND TABLE_TYPE IN (?) ORDER BY TABLE_NAME`,
    [schema, MOVABLE_TABLE_TYPES],
  );
  return rows.map((r) => String(r.name));
}

async function listAllNames(conn: Connection, schema: string): Promise<{ name: string; type: string }[]> {
  const [rows] = await conn.query<RowDataPacket[]>(
    `SELECT TABLE_NAME AS name, TABLE_TYPE AS type FROM information_schema.TABLES WHERE TABLE_SCHEMA = ?`,
    [schema],
  );
  return rows.map((r) => ({ name: String(r.name), type: String(r.type) }));
}

async function dropQuietly(conn: Connection | null, schema: string): Promise<void> {
  try {
    if (conn) await conn.query(`DROP DATABASE IF EXISTS ${quoteIdent(schema)}`);
    else await withRootConnection((c) => c.query(`DROP DATABASE IF EXISTS ${quoteIdent(schema)}`));
  } catch (err) {
    console.warn(`[mariadb] could not drop ${schema}; it will be removed at next startup:`, errorMessage(err));
  }
}

function hostOnly(host: string): string {
  const m = /^\[?([^\]]+?)\]?(?::\d+)?$/.exec(host);
  return m?.[1] ?? host;
}

export async function findBlockingSessions(conn: Connection, schemas: string[]): Promise<SwapBlocker[]> {
  let holders: Set<number> | null = null;
  try {
    const [mdl] = await conn.query<RowDataPacket[]>(
      `SELECT DISTINCT THREAD_ID AS id FROM information_schema.METADATA_LOCK_INFO
        WHERE TABLE_SCHEMA IN (?) AND THREAD_ID <> CONNECTION_ID()`,
      [schemas],
    );
    holders = new Set(mdl.map((r) => Number(r.id)));
  } catch {
    holders = null;
  }
  const [rows] = await conn.query<RowDataPacket[]>(
    `SELECT p.ID AS id, p.USER AS user, p.HOST AS host, p.DB AS db, p.COMMAND AS command, p.TIME AS time,
            p.STATE AS state, LEFT(p.INFO, 160) AS info,
            TIMESTAMPDIFF(SECOND, t.trx_started, NOW()) AS trxAge, t.trx_id AS trx
       FROM information_schema.PROCESSLIST p
       LEFT JOIN information_schema.INNODB_TRX t ON t.trx_mysql_thread_id = p.ID
      WHERE p.ID <> CONNECTION_ID() AND p.COMMAND NOT IN ('Daemon', 'Binlog Dump')
      ORDER BY p.ID`,
  );
  const lower = new Set(schemas.map((s) => s.toLowerCase()));
  return rows
    .filter((r) => {
      if (String(r.state ?? "").startsWith("Waiting for table metadata lock")) return false;
      if (holders) return holders.has(Number(r.id));
      return r.trx !== null || lower.has(String(r.db ?? "").toLowerCase());
    })
    .map((r) => ({
      id: Number(r.id),
      user: String(r.user ?? ""),
      host: hostOnly(String(r.host ?? "")),
      command: String(r.command ?? ""),
      idleSec: Number(r.time ?? 0),
      transactionSec: r.trxAge === null || r.trxAge === undefined ? null : Number(r.trxAge),
      query: r.info === null || r.info === undefined ? null : String(r.info),
    }));
}

function describeBlocker(b: SwapBlocker): string {
  const where = `${b.user || "unknown user"} from ${b.host || "an unknown host"}`;
  if (b.command === "Sleep") {
    const trx = b.transactionSec !== null ? ` inside a transaction open for ${b.transactionSec}s` : "";
    return `session ${b.id} (${where}, idle ${b.idleSec}s${trx})`;
  }
  return `session ${b.id} (${where}, running for ${b.idleSec}s${b.query ? `: ${b.query}` : ""})`;
}

function blockedMessage(live: string, waitSec: number, blockers: SwapBlocker[]): string {
  const who =
    blockers.length > 0
      ? `Blocking: ${blockers.slice(0, 5).map(describeBlocker).join("; ")}${blockers.length > 5 ? `; and ${blockers.length - 5} more` : ""}.`
      : "The sessions holding them could not be identified.";
  return `Could not swap the new tables into ${live}: other sessions kept its tables in use for more than ${waitSec}s, so nothing was changed. ${who} Retry when they finish, or end those sessions.`;
}

function isLockWait(err: unknown): boolean {
  return (err as { errno?: number } | null)?.errno === ER_LOCK_WAIT_TIMEOUT;
}

function track<T>(p: Promise<T>): Promise<T> {
  activeSwaps.add(p);
  p.then(
    () => activeSwaps.delete(p),
    () => activeSwaps.delete(p),
  );
  return p;
}

export function holdSwapsForShutdown(timeoutMs: number): Promise<number> {
  holdForShutdown = true;
  const pending = [...activeSwaps];
  if (pending.length === 0) return Promise.resolve(0);
  return Promise.race([
    Promise.allSettled(pending).then(() => 0),
    Bun.sleep(timeoutMs).then(() => activeSwaps.size),
  ]);
}

export function releaseSwapHold(): void {
  holdForShutdown = false;
}

export function swapsInProgress(): number {
  return activeSwaps.size;
}

export function swapStagingIntoLive(opts: SwapOptions): Promise<SwapResult> {
  return track(
    runSwap(opts).catch((err: unknown) => {
      throw err instanceof SwapRollbackIncompleteError || (err instanceof SwapRefusedError && /kept, untouched/.test(err.message)) ? err : sanitizeError(err);
    }),
  );
}

function chunks<T>(list: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

async function staleTables(conn: Connection, live: string, locked: string[], expect: ExpectLive): Promise<string[]> {
  const changed = new Set<string>();
  const now = await listTables(conn, live);
  const expected = new Map(expect.tables.map((t) => [t.name, t]));
  const present = new Set(now);
  const out: string[] = [];
  for (const t of expect.tables) if (!present.has(t.name)) out.push(`${t.name} (removed)`);
  for (const name of now) if (!expected.has(name)) out.push(`${name} (added)`);
  const lockedSet = new Set(locked);
  const comparable = now.filter((name) => expected.has(name) && lockedSet.has(name));
  const counted = comparable.filter((name) => expected.get(name)!.rowCount !== null);
  for (const group of chunks(counted, STALE_BATCH)) {
    const sql = group.map(() => "SELECT ? AS name, COUNT(*) AS n FROM ").map((head, i) => `${head}${quoteIdent(live)}.${quoteName(group[i]!)}`).join(" UNION ALL ");
    const [rows] = await conn.query<RowDataPacket[]>(sql, group);
    for (const r of rows) if (Number(r.n) !== expected.get(String(r.name))!.rowCount) changed.add(String(r.name));
  }
  const summed = comparable.filter((name) => !changed.has(name) && expected.get(name)!.checksum !== null);
  for (const group of chunks(summed, STALE_BATCH)) {
    const [rows] = await conn.query<RowDataPacket[]>(`CHECKSUM TABLE ${group.map((t) => `${quoteIdent(live)}.${quoteName(t)}`).join(", ")}`);
    const prefix = `${live}.`;
    for (const r of rows) {
      const full = String(r.Table ?? "");
      const name = full.startsWith(prefix) ? full.slice(prefix.length) : full;
      const want = expected.get(name);
      if (!want) continue;
      if (r.Checksum === null || r.Checksum === undefined || Number(r.Checksum) !== want.checksum) changed.add(name);
    }
  }
  for (const name of now) if (changed.has(name)) out.push(name);
  return out;
}

async function runSwap(opts: SwapOptions): Promise<SwapResult> {
  const { live, staging } = opts;
  assertLiveSchema(live);
  if (!isSafeIdent(staging) || !staging.startsWith(STAGING_PREFIX)) {
    throw new Error("staging schema must be one created by createStagingSchema");
  }
  if (holdForShutdown) {
    await dropSchemaIfExists(staging).catch(() => {});
    throw new SwapRefusedError("LambData is shutting down, so the swap was not started and nothing was changed");
  }
  try {
    await recoverPendingFor(live);
  } catch (err) {
    await dropSchemaIfExists(staging).catch(() => {});
    throw err;
  }
  const trash = managedName(TRASH_PREFIX, live);
  inUse.add(staging);
  inUse.add(trash);
  const leave = enterCritical([live, ...(opts.databaseId ? [opts.databaseId] : [])]);
  try {
    return await runSwapLocked(opts, trash);
  } finally {
    leave();
  }
}

async function runSwapLocked(opts: SwapOptions, trash: string): Promise<SwapResult> {
  const { live, staging } = opts;
  let conn: Connection | null = null;
  let journal: SwapJournal | null = null;
  let changed = false;
  const lockWait = Math.max(1, Math.round(opts.lockWaitTimeoutSec ?? DEFAULT_LOCK_WAIT_TIMEOUT_SEC));
  try {
    conn = await openAdminConnection();
    await conn.query(`SET SESSION max_statement_time = 0`);
    await requireSchema(conn, live);
    await requireSchema(conn, staging);
    await assertStagingHasOnlyTables(conn, staging);
    await assertNoInboundForeignKeys(conn, live);
    const liveTables = await listTables(conn, live);
    const stagingTables = await listTables(conn, staging);
    const liveNames = await listAllNames(conn, live);
    const incoming = new Set(stagingTables.map((t) => t.toLowerCase()));
    const collidingViews = liveNames.filter((n) => n.type === "VIEW" && incoming.has(n.name.toLowerCase())).map((n) => n.name);
    const takenNames = new Set([...liveNames.map((n) => n.name.toLowerCase()), ...incoming]);
    const parkedViews = collidingViews.map((v, i) => {
      let to = "";
      do to = `${PARKED_VIEW_PREFIX}${randAlphaNum(SUFFIX_LENGTH).toLowerCase()}_${i}`;
      while (takenNames.has(to));
      return { from: v, to };
    });
    const liveCode = await captureCodeRecords(conn, live);
    await conn.query(`CREATE DATABASE ${quoteIdent(trash)}`);
    journal = {
      version: 2,
      id: `${Date.now().toString(36)}_${randAlphaNum(10).toLowerCase()}`,
      live,
      staging,
      trash,
      databaseId: opts.databaseId ?? null,
      createdAt: Date.now(),
      phase: "prepared",
      outgoing: liveTables,
      incoming: stagingTables,
      collidingViews,
      parkedViews,
      liveCode,
      code: opts.code ?? [],
      definers: { account: opts.definers?.account ?? null, keep: opts.definers?.keep ?? "recorded" },
      keepKinds: opts.keepLiveEvents ? ["EVENT"] : [],
      schemaDefaults: opts.schemaDefaults ?? null,
      codeLockWaitTimeoutSec: Math.max(1, Math.round(opts.codeLockWaitTimeoutSec ?? DEFAULT_CODE_LOCK_WAIT_SEC)),
      codeTimeoutMs: opts.codeTimeoutMs ?? DEFAULT_CODE_TIMEOUT_MS,
      lockWaitTimeoutSec: lockWait,
      note: opts.note ?? null,
    };
    activeJournals.add(journal.id);
    writeJournal("swap", journal.id, journal);
    await opts.onPhase?.("prepared");
    await conn.query(`SET SESSION lock_wait_timeout = ?`, [lockWait]);
    const moves = [
      ...liveTables.map((t) => `${quoteIdent(live)}.${quoteName(t)} TO ${quoteIdent(trash)}.${quoteName(t)}`),
      ...parkedViews.map((v) => `${quoteIdent(live)}.${quoteName(v.from)} TO ${quoteIdent(live)}.${quoteName(v.to)}`),
      ...stagingTables.map((t) => `${quoteIdent(staging)}.${quoteName(t)} TO ${quoteIdent(live)}.${quoteName(t)}`),
    ];
    if (liveTables.length > 0) {
      try {
        await conn.query(`LOCK TABLES ${liveTables.map((t) => `${quoteIdent(live)}.${quoteName(t)} WRITE`).join(", ")}`);
      } catch (err) {
        if (!isLockWait(err)) throw err;
        const blockers = await findBlockingSessions(conn, [live]).catch(() => []);
        throw new SwapBlockedError(blockedMessage(live, lockWait, blockers), blockers, err);
      }
      const known = new Set(liveCode.filter((r) => r.kind === "TRIGGER").map((r) => r.name.toLowerCase()));
      const [now] = await conn.query<RowDataPacket[]>(`SELECT TRIGGER_NAME AS name FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = ?`, [live]);
      if (now.some((r) => !known.has(String(r.name).toLowerCase()))) {
        await conn.query("UNLOCK TABLES").catch(() => {});
        throw new SwapRefusedError(`the triggers of ${live} changed while the swap was starting, so nothing was changed; try again`);
      }
      if (opts.expectLive) {
        const stale = await staleTables(conn, live, liveTables, opts.expectLive);
        if (stale.length > 0) {
          await conn.query("UNLOCK TABLES").catch(() => {});
          throw new SwapStaleError(live, stale);
        }
      }
      changed = true;
      let renameError: unknown = null;
      try {
        for (const t of liveCode.filter((r) => r.kind === "TRIGGER")) {
          await conn.query(`DROP TRIGGER IF EXISTS ${quoteIdent(live)}.${quoteName(t.name)}`);
        }
        await opts.onPhase?.("moved-out");
        renameError = await renameBehindLock(conn, moves, lockWait);
      } finally {
        await conn.query("UNLOCK TABLES").catch(() => {});
      }
      if (renameError !== null) await settleFailedRename(conn, journal, renameError);
    } else {
      if (opts.expectLive) {
        const stale = await staleTables(conn, live, [], opts.expectLive);
        if (stale.length > 0) throw new SwapStaleError(live, stale);
      }
      await opts.onPhase?.("moved-out");
      if (moves.length > 0) {
        changed = true;
        try {
          await conn.query(`RENAME TABLE ${moves.join(", ")}`);
        } catch (err) {
          await settleFailedRename(conn, journal, err);
        }
      }
    }
  } catch (err) {
    let rollbackProblem: unknown = null;
    let report: RollbackReport | null = null;
    if (journal && changed) {
      try {
        report = await rollBack(journal);
      } catch (problem) {
        rollbackProblem = problem;
      }
    }
    const keepStaging = err instanceof SwapStaleError;
    if (!rollbackProblem) {
      if (!keepStaging) await dropQuietly(conn, staging);
      await dropTrashIfEmpty(trash).catch((problem) => {
        rollbackProblem = problem;
      });
      if (journal && changed && !rollbackProblem) {
        await runHooks(rolledBackHooks, journal, { recovered: false, result: null, reason: errorMessage(err), eventsReplaced: false });
      }
      if (journal && !rollbackProblem) removeJournal("swap", journal.id);
    }
    if (journal) activeJournals.delete(journal.id);
    if (!keepStaging) inUse.delete(staging);
    inUse.delete(trash);
    await conn?.end().catch(() => conn?.destroy());
    if (journal && rollbackProblem) retryRecoverySoon(live);
    if (rollbackProblem) {
      if (rollbackProblem instanceof SwapRollbackIncompleteError) {
        throw new SwapRollbackIncompleteError(`${errorMessage(err)}; ${rollbackProblem.message}`, rollbackProblem.heldIn, rollbackProblem.tables);
      }
      throw new Error(
        `${errorMessage(err)}; putting ${live} back as it was did not finish either (${errorMessage(rollbackProblem)}); it is retried automatically when MariaDB is available again or at the next start`,
        { cause: err },
      );
    }
    if (journal && changed && err instanceof Error) {
      err.message = `${errorMessage(err)}; the swap was undone and ${live} was left exactly as it was${report?.quarantine ? `, except that ${report.note}` : ""}`;
    }
    if (report?.quarantine) console.warn(`[mariadb] ${report.note}`);
    throw err;
  }
  await conn.end().catch(() => conn?.destroy());
  journal.phase = "renamed";
  try {
    writeJournal("swap", journal.id, journal);
  } catch (err) {
    console.warn(`[mariadb] could not record the swap of ${live} as renamed; recovery detects it anyway:`, errorMessage(err));
  }
  try {
    await opts.onPhase?.("renamed");
    return await completeSwap(journal, opts.onPhase, false);
  } catch (err) {
    retryRecoverySoon(live);
    throw new Error(
      `the new tables are in place in ${live}, but finishing the swap failed (${errorMessage(err)}); it is completed automatically when MariaDB is available again or at the next start`,
      { cause: err },
    );
  } finally {
    activeJournals.delete(journal.id);
    inUse.delete(staging);
    inUse.delete(trash);
  }
}

async function renameBehindLock(holder: Connection, moves: string[], lockWait: number): Promise<unknown> {
  const mover = await openAdminConnection();
  try {
    await mover.query(`SET SESSION max_statement_time = 0, lock_wait_timeout = ?`, [lockWait]);
    const [ids] = await mover.query<RowDataPacket[]>("SELECT CONNECTION_ID() AS id");
    const moverId = Number(ids[0]?.id);
    let settled = false;
    const pending = mover.query(`RENAME TABLE ${moves.join(", ")}`).then(
      () => null,
      (err: unknown) => err ?? new Error("the rename failed"),
    );
    void pending.then(() => {
      settled = true;
    });
    const stopMover = (): Promise<unknown> => withRootConnection((c) => c.query(`KILL CONNECTION ${moverId}`)).catch(() => {});
    let failure: unknown = null;
    try {
      const deadline = Date.now() + HANDOFF_WAIT_MS;
      let queued = false;
      while (!settled && Date.now() < deadline) {
        const [rows] = await holder.query<RowDataPacket[]>("SELECT STATE AS state FROM information_schema.PROCESSLIST WHERE ID = ?", [moverId]);
        if (String(rows[0]?.state ?? "").startsWith("Waiting for")) {
          queued = true;
          break;
        }
        await Bun.sleep(2);
      }
      if (!queued && !settled) {
        failure = new Error(`the new tables could not be queued for the swap within ${HANDOFF_WAIT_MS / 1000}s`);
        await stopMover();
      } else {
        await holder.query("UNLOCK TABLES").catch(() => {});
      }
    } catch (err) {
      failure = err;
      if (!settled) await stopMover();
    }
    const outcome = await pending;
    return outcome === null ? null : (failure ?? outcome);
  } finally {
    await mover.end().catch(() => mover.destroy());
  }
}

async function settleFailedRename(conn: Connection, j: SwapJournal, err: unknown): Promise<void> {
  if (j.incoming.length > 0 && (await swapCommitted(j).catch(() => false))) {
    console.warn(`[mariadb] the rename into ${j.live} reported an error but completed; the swap continues:`, errorMessage(err));
    return;
  }
  if (isLockWait(err)) {
    const blockers = await findBlockingSessions(conn, [j.live]).catch(() => []);
    throw new SwapBlockedError(blockedMessage(j.live, Number(j.lockWaitTimeoutSec ?? DEFAULT_LOCK_WAIT_TIMEOUT_SEC), blockers), blockers, err);
  }
  throw err;
}

async function namesPresent(conn: Connection, schemas: string[], names: string[]): Promise<{ schema: string; name: string }[]> {
  if (names.length === 0) return [];
  const [rows] = await conn.query<RowDataPacket[]>(
    `SELECT TABLE_SCHEMA AS s, TABLE_NAME AS n FROM information_schema.TABLES WHERE TABLE_SCHEMA IN (?) AND TABLE_NAME IN (?)`,
    [schemas, names],
  );
  return rows.map((r) => ({ schema: String(r.s), name: String(r.n) }));
}

interface RollbackReport {
  quarantine: string | null;
  quarantined: string[];
  note: string;
}

async function quarantineSchema(c: Connection, live: string): Promise<string> {
  const name = managedName(QUARANTINE_PREFIX, live);
  await c.query(`CREATE DATABASE ${quoteIdent(name)}`);
  return name;
}

async function rollBack(j: SwapJournal): Promise<RollbackReport> {
  const report: RollbackReport = { quarantine: null, quarantined: [], note: "" };
  await withRootConnection(async (c) => {
    await c.query(`SET SESSION lock_wait_timeout = ?`, [j.codeLockWaitTimeoutSec]);
    const inTrash = (await namesPresent(c, [j.trash], j.outgoing)).map((r) => r.name);
    const liveNames = await listAllNames(c, j.live);
    const occupied = new Map(liveNames.map((n) => [n.name, n.type]));
    const intruders = inTrash.filter((t) => occupied.has(t));
    const stuck: string[] = [];
    for (const t of intruders) {
      if (!MOVABLE_TABLE_TYPES.includes(occupied.get(t)!)) {
        stuck.push(t);
        continue;
      }
      report.quarantine ??= await quarantineSchema(c, j.live);
      try {
        await c.query(`RENAME TABLE ${quoteIdent(j.live)}.${quoteName(t)} TO ${quoteIdent(report.quarantine)}.${quoteName(t)}`);
        report.quarantined.push(t);
      } catch {
        stuck.push(t);
      }
    }
    for (const v of j.parkedViews ?? []) {
      if (occupied.get(v.to) === "VIEW" && !occupied.has(v.from)) {
        await c.query(`RENAME TABLE ${quoteIdent(j.live)}.${quoteName(v.to)} TO ${quoteIdent(j.live)}.${quoteName(v.from)}`);
      }
    }
    const back = inTrash.filter((t) => !stuck.includes(t));
    if (back.length > 0) {
      await c.query(`RENAME TABLE ${back.map((t) => `${quoteIdent(j.trash)}.${quoteName(t)} TO ${quoteIdent(j.live)}.${quoteName(t)}`).join(", ")}`);
    }
    if (stuck.length > 0) {
      const list = stuck.map((t) => `\`${t}\``).join(", ");
      throw new SwapRollbackIncompleteError(
        `${list} could not be put back into ${j.live}, because something else now uses that name there; the original ${stuck.length === 1 ? "table is" : "tables are"} kept, untouched, in the schema ${j.trash}. Rename or remove the new object in ${j.live}, then move the table back with RENAME TABLE`,
        j.trash,
        stuck,
      );
    }
  });
  if (report.quarantine) {
    const list = report.quarantined.map((t) => `\`${t}\``).join(", ");
    report.note = `another session created ${list} in ${j.live} while the swap ran; ${report.quarantined.length === 1 ? "it was" : "they were"} moved to the schema ${report.quarantine} so the original could be put back, and nothing was lost`;
    try {
      audit.log(null, "database.swap.quarantined", j.databaseId, { schema: j.live, quarantine: report.quarantine, tables: report.quarantined });
    } catch {
      console.warn(`[mariadb] could not record the quarantined tables of ${j.live} in the audit log`);
    }
  }
  const result = await restoreLiveCode(j);
  if (result.failures.length > 0) {
    throw new Error(`could not re-create ${result.failures.map((f) => `${f.kind.toLowerCase()} ${f.name}`).join(", ")}`);
  }
  return report;
}

async function dropTrashIfEmpty(trash: string): Promise<void> {
  const left = await withRootConnection(async (c) => {
    if (!(await schemaExists(c, trash))) return [];
    return listAllNames(c, trash);
  });
  if (left.length > 0) {
    throw new SwapRollbackIncompleteError(
      `the schema ${trash} still holds ${left.map((n) => `\`${n.name}\``).join(", ")}, so it was kept; nothing in it was removed`,
      trash,
      left.map((n) => n.name),
    );
  }
  await dropQuietly(null, trash);
}

async function restoreLiveCode(j: SwapJournal): Promise<{ failures: CodeApplyFailure[] }> {
  if (j.liveCode.length === 0) return { failures: [] };
  const definerFor = definerResolver({ account: ownAccountOf(j.live), keep: "recorded" }, await existingAccountKeys(), []);
  return withScopedAccount({ schemas: [j.live], setUser: true }, async (account) => {
    const session = await CodeSession.open(account.target, j.live, {
      lockWaitTimeoutSec: j.codeLockWaitTimeoutSec,
      deadline: Date.now() + j.codeTimeoutMs,
    });
    try {
      const current = await captureCodeRecords(session.conn, j.live);
      const present = new Set(current.map((r) => `${r.kind}:${r.name.toLowerCase()}`));
      const missing = j.liveCode.filter((r) => !present.has(`${r.kind}:${r.name.toLowerCase()}`));
      if (missing.length === 0) return { failures: [] };
      const kinds = [...new Set(missing.map((r) => r.kind))];
      const desired = j.liveCode.filter((r) => kinds.includes(r.kind));
      const result = await reconcileCode({ session, current, desired, kinds, dropExtras: false, definerFor });
      return { failures: result.failures };
    } finally {
      await session.close();
    }
  });
}

async function completeSwap(j: SwapJournal, onPhase: ((phase: SwapPhase) => void | Promise<void>) | undefined, recovered: boolean): Promise<SwapResult> {
  const warnings: string[] = [];
  const failures: CodeApplyFailure[] = [];
  let codeApplied = 0;
  const deadline = Date.now() + j.codeTimeoutMs;
  const policy: DefinerPolicy = { account: j.definers.account ?? ownAccountOf(j.live), keep: j.definers.keep };
  const keep = new Set(j.keepKinds);
  const definerWarnings: string[] = [];
  const definerFor = definerResolver(policy, await existingAccountKeys(), definerWarnings);

  await withRootConnection(async (c) => {
    const stranded = await namesPresent(c, [j.staging], j.incoming);
    if (stranded.length > 0) {
      await c.query(
        `RENAME TABLE ${stranded.map((r) => `${quoteIdent(j.staging)}.${quoteName(r.name)} TO ${quoteIdent(j.live)}.${quoteName(r.name)}`).join(", ")}`,
      );
    }
    for (const v of j.parkedViews ?? []) {
      await c.query(`DROP VIEW IF EXISTS ${quoteIdent(j.live)}.${quoteName(v.to)}`);
    }
  });

  await withScopedAccount({ schemas: [j.live], setUser: true }, async (account) => {
    const session = await CodeSession.open(account.target, j.live, { lockWaitTimeoutSec: j.codeLockWaitTimeoutSec, deadline });
    try {
      if (j.code && !keep.has("TRIGGER")) {
        const current = (await captureCodeRecords(session.conn, j.live)).filter((r) => r.kind === "TRIGGER");
        const triggers = await reconcileCode({
          session,
          current,
          desired: j.code.filter((r) => r.kind === "TRIGGER"),
          kinds: ["TRIGGER"],
          dropExtras: true,
          definerFor,
        });
        codeApplied += triggers.applied;
        failures.push(...triggers.failures);
        warnings.push(...triggers.warnings);
      }
      await onPhase?.("triggers");
      const kinds = ALL_KINDS.filter((k) => k !== "TRIGGER" && !keep.has(k));
      const current = await captureCodeRecords(session.conn, j.live);
      if (j.code) {
        const rest = await reconcileCode({ session, current, desired: j.code, kinds, dropExtras: true, definerFor });
        codeApplied += rest.applied;
        failures.push(...rest.failures);
        warnings.push(...rest.warnings);
      } else {
        const dropKinds = new Set<CodeKind>([...kinds, ...(keep.has("TRIGGER") ? [] : (["TRIGGER"] as CodeKind[]))]);
        for (const r of current.filter((o) => dropKinds.has(o.kind))) {
          try {
            await session.drop(r.kind, r.name);
          } catch (err) {
            warnings.push(`could not remove ${r.kind.toLowerCase()} ${r.name}: ${errorMessage(err)}`);
          }
        }
      }
    } finally {
      await session.close();
    }
  });
  await onPhase?.("code");

  if (j.schemaDefaults && !j.schemaDefaultsDone) {
    const cs = j.schemaDefaults.characterSet;
    const coll = j.schemaDefaults.collation;
    if (SAFE_CHARSET.test(cs) && SAFE_CHARSET.test(coll)) {
      try {
        await withRootConnection((c) => c.query(`ALTER DATABASE ${quoteIdent(j.live)} CHARACTER SET ${cs} COLLATE ${coll}`));
      } catch (err) {
        const errno = (err as { errno?: number } | null)?.errno;
        if (errno === undefined || !PERMANENT_DEFAULTS_ERRNOS.has(errno)) throw err;
        warnings.push(`could not put back the database's default character set ${cs} and collation ${coll}: ${errorMessage(err)}`);
      }
    }
    j.schemaDefaultsDone = true;
  }
  j.phase = "applied";
  writeJournal("swap", j.id, j);

  for (const schema of [j.trash, j.staging]) {
    try {
      await withRootConnection((c) => c.query(`DROP DATABASE IF EXISTS ${quoteIdent(schema)}`));
    } catch (err) {
      warnings.push(`could not drop ${schema}; it will be removed at next startup: ${errorMessage(err)}`);
    }
  }
  const allWarnings = [...definerWarnings, ...warnings].map(sanitizeMariaDbMessage);
  const result: SwapResult = { outcome: failures.length > 0 ? "done-with-errors" : "done", warnings: allWarnings, failures, codeApplied };
  await runHooks(completedHooks, j, { recovered, result, reason: null, eventsReplaced: !keep.has("EVENT") });
  removeJournal("swap", j.id);
  await onPhase?.("done");
  return result;
}

export function onSwapRecovered(listener: SwapRecoveryListener): () => void {
  recoveryListeners.push(listener);
  return () => {
    const i = recoveryListeners.indexOf(listener);
    if (i >= 0) recoveryListeners.splice(i, 1);
  };
}

async function notifyRecovered(swap: RecoveredSwap): Promise<void> {
  for (const listener of [...recoveryListeners]) {
    try {
      await listener(swap);
    } catch (err) {
      console.error(`[mariadb] a listener for the recovered swap of ${swap.live} failed:`, errorMessage(err));
    }
  }
}

async function swapCommitted(j: SwapJournal): Promise<boolean> {
  if (j.phase !== "prepared") return true;
  if (j.incoming.length === 0) return false;
  return withRootConnection(async (c) => {
    const inLive = await namesPresent(c, [j.live], j.incoming);
    const outgoing = new Set(j.outgoing.map((t) => t.toLowerCase()));
    const arrived = inLive.filter((r) => !outgoing.has(r.name.toLowerCase()));
    if (arrived.length > 0) return true;
    if (!(await schemaExists(c, j.staging))) return inLive.length > 0;
    const stillStaged = await namesPresent(c, [j.staging], j.incoming);
    return stillStaged.length === 0;
  });
}

async function recoverOne(j: SwapJournal): Promise<{ outcome: "completed" | "rolled-back"; result: SwapResult | null }> {
  if (!(await swapCommitted(j))) {
    const report = await rollBack(j);
    if (report.quarantine) console.warn(`[mariadb] ${report.note}`);
    await dropQuietly(null, j.staging);
    await dropTrashIfEmpty(j.trash);
    await runHooks(rolledBackHooks, j, {
      recovered: true,
      result: null,
      reason: `LambData stopped before the swap of ${j.live} finished, so it was put back as it was${report.quarantine ? `; ${report.note}` : ""}`,
      eventsReplaced: false,
    });
    removeJournal("swap", j.id);
    return { outcome: "rolled-back", result: null };
  }
  const result = await completeSwap(j, undefined, true);
  for (const w of result.warnings) console.warn(`[mariadb] swap recovery for ${j.live}: ${w}`);
  return { outcome: "completed", result };
}

function runRecovery(filter: (j: SwapJournal) => boolean): Promise<SwapRecoveryReport> {
  const run = recoveryChain.then(async () => {
    const report: SwapRecoveryReport = { completed: [], rolledBack: [], failed: [] };
    for (const j of pendingJournals()) {
      if (activeJournals.has(j.id) || !filter(j)) continue;
      activeJournals.add(j.id);
      inUse.add(j.staging);
      inUse.add(j.trash);
      try {
        const { outcome, result } = await recoverOne(j);
        lastRecoveryProblem.delete(j.live);
        if (outcome === "completed") report.completed.push(j.live);
        else report.rolledBack.push(j.live);
        console.log(
          outcome === "completed"
            ? `[mariadb] completed a swap of ${j.live} that was interrupted after its tables were moved`
            : `[mariadb] rolled back a swap of ${j.live} that was interrupted before anything changed`,
        );
        try {
          audit.log(null, "database.swap.recovered", j.databaseId, {
            schema: j.live,
            outcome,
            startedAt: j.createdAt,
            failures: result?.failures.length ?? 0,
          });
        } catch (err) {
          console.warn(`[mariadb] could not record the recovered swap of ${j.live} in the audit log:`, errorMessage(err));
        }
        await notifyRecovered({ live: j.live, databaseId: j.databaseId, outcome, note: j.note ?? null, startedAt: j.createdAt, result });
      } catch (err) {
        report.failed.push(j.live);
        const reason = err instanceof SwapRollbackIncompleteError ? err.message : errorMessage(err);
        lastRecoveryProblem.set(j.live, reason);
        console.error(`[mariadb] could not recover the interrupted swap of ${j.live}; it is retried later:`, reason);
      } finally {
        activeJournals.delete(j.id);
        inUse.delete(j.staging);
        inUse.delete(j.trash);
      }
    }
    return report;
  });
  recoveryChain = run.catch(() => {});
  return run;
}

const RECOVERY_RETRY_MS = [2_000, 5_000, 10_000, 30_000, 60_000];
const lastRecoveryProblem = new Map<string, string>();
const retrying = new Set<string>();

function retryRecoverySoon(live: string, attempt = 0): void {
  if (attempt === 0 && retrying.has(live)) return;
  retrying.add(live);
  const delay = RECOVERY_RETRY_MS[Math.min(attempt, RECOVERY_RETRY_MS.length - 1)]!;
  setTimeout(() => {
    const again = (): void => {
      if (attempt + 1 < RECOVERY_RETRY_MS.length * 2) retryRecoverySoon(live, attempt + 1);
      else retrying.delete(live);
    };
    if (!swapRecoveryPending(live)) {
      retrying.delete(live);
      return;
    }
    if (mariadbState() !== "running") {
      again();
      return;
    }
    runRecovery((j) => j.live === live).then(
      () => (swapRecoveryPending(live) ? again() : retrying.delete(live)),
      () => again(),
    );
  }, delay).unref?.();
}

export function recoverInterruptedSwaps(): Promise<SwapRecoveryReport> {
  return runRecovery(() => true);
}

async function recoverPendingFor(live: string): Promise<void> {
  if (!pendingJournals().some((j) => j.live === live && !activeJournals.has(j.id))) {
    if (pendingJournals().some((j) => j.live === live)) {
      throw new SwapRefusedError(`another swap of ${live} is still being completed; try again shortly`);
    }
    return;
  }
  await runRecovery((j) => j.live === live);
  if (swapRecoveryPending(live)) {
    const problem = lastRecoveryProblem.get(live);
    throw new SwapRefusedError(
      `an earlier swap of ${live} was interrupted and could not be completed yet, so nothing new was started${problem ? `: ${problem}` : " (see the server log)"}`,
    );
  }
}

export function schemasHeldByJournals(): Set<string> {
  const out = new Set<string>();
  for (const j of pendingJournals()) {
    out.add(j.staging);
    out.add(j.trash);
  }
  return out;
}

export async function cleanupOrphanSchemas(): Promise<string[]> {
  const held = schemasHeldByJournals();
  const names = await withRootConnection(async (c) => {
    const [rows] = await c.query<RowDataPacket[]>(`SELECT SCHEMA_NAME AS name FROM information_schema.SCHEMATA`);
    return rows.map((r) => String(r.name));
  });
  const dropped: string[] = [];
  for (const name of names) {
    if (!isManagedSchema(name) || !isSafeIdent(name) || inUse.has(name) || held.has(name)) continue;
    try {
      await withRootConnection(async (c) => {
        await c.query(`DROP DATABASE IF EXISTS ${quoteIdent(name)}`);
      });
      dropped.push(name);
    } catch (err) {
      console.warn(`[mariadb] could not drop orphan schema ${name}:`, errorMessage(err));
    }
  }
  return dropped;
}
