import { isUtf8 } from "node:buffer";
import type { Connection, RowDataPacket } from "mysql2/promise";
import { onMariaDbReady, openAdminConnection } from "../mariadb/controller";
import { readTrueMembers, rewriteMembers } from "./members";
import { schemaHash } from "./sql";
import type { ChunkWriter } from "./store";

export const TABLE_TYPES = ["BASE TABLE", "SYSTEM VERSIONED", "SEQUENCE"];
export const MAX_STATEMENT_BYTES = 1024 * 1024 * 1024 - 32 * 1024 * 1024;
export const OBJECT_HEADER = "-- LambData table v2";

const BATCH_BYTES = 1024 * 1024;
const FLUSH_BYTES = 256 * 1024;
const SLICE_BYTES = 1024 * 1024;
const LOCK_WAIT_SEC = 120;
const NET_WRITE_TIMEOUT_SEC = 3600;
const SAFE_CHARSET = /^[a-z0-9_]{1,64}$/;
const TEXT_TYPES = new Set(["char", "varchar", "tinytext", "text", "mediumtext", "longtext", "json"]);
const INDEX_TYPES = new Set(["enum", "set"]);
const WIDE_CHARSETS = new Set(["utf8mb4", "utf16", "utf16le", "utf32"]);
const BINARY_TYPES = new Set(["binary", "varbinary", "tinyblob", "blob", "mediumblob", "longblob", "bit", "vector"]);
const GEOMETRY_TYPES = new Set([
  "geometry",
  "point",
  "linestring",
  "polygon",
  "multipoint",
  "multilinestring",
  "multipolygon",
  "geometrycollection",
]);
const NUMBER_TYPES = new Set(["tinyint", "smallint", "mediumint", "int", "integer", "bigint", "decimal", "numeric"]);
const FLOAT_TYPES = new Set(["float", "double", "real", "double precision"]);
const QUOTED_TYPES = new Set(["date", "datetime", "timestamp", "time", "year", "inet4", "inet6", "uuid"]);
const UTF8_CHARSETS = new Set(["utf8mb4", "utf8mb3", "utf8"]);
const ER_NO_SUCH_TABLE = 1146;

export const captureLimits = { inactivityMs: 120_000 };

const encoder = new TextEncoder();
const HEX = encoder.encode("0123456789ABCDEF");
const ESCAPES: (Uint8Array | null)[] = Array.from({ length: 256 }, () => null);
ESCAPES[0] = encoder.encode("\\0");
ESCAPES[10] = encoder.encode("\\n");
ESCAPES[13] = encoder.encode("\\r");
ESCAPES[26] = encoder.encode("\\Z");
ESCAPES[34] = encoder.encode('\\"');
ESCAPES[39] = encoder.encode("\\'");
ESCAPES[92] = encoder.encode("\\\\");

export class CheckpointCaptureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CheckpointCaptureError";
  }
}

export class CaptureInterruptedError extends CheckpointCaptureError {
  constructor(message: string) {
    super(message);
    this.name = "CaptureInterruptedError";
  }
}

interface RunningCapture {
  abort(reason: string): void;
}

const running = new Set<RunningCapture>();

export function abortRunningCaptures(reason: string): number {
  const all = [...running];
  for (const c of all) c.abort(reason);
  return all.length;
}

export function runningCaptures(): number {
  return running.size;
}

onMariaDbReady((reason) => {
  if (reason !== "restart") return;
  const n = abortRunningCaptures("MariaDB restarted while the checkpoint was being taken");
  if (n > 0) console.warn(`[checkpoints] stopped ${n} checkpoint(s) that were being taken when MariaDB restarted`);
});

export function quoteTableName(name: string): string {
  if (!name || name.includes("\u0000")) throw new CheckpointCaptureError("invalid table name");
  return "`" + name.replaceAll("`", "``") + "`";
}

export function displayName(name: string): string {
  return JSON.stringify(name).slice(1, -1);
}

type Literal = "number" | "float" | "quoted" | "hex" | "text";

interface Column {
  name: string;
  dataType: string;
  charset: string | null;
  literal: Literal;
  select: string;
  insertName: string;
}

interface TableInfo {
  name: string;
  type: string;
  engine: string | null;
  createOptions: string;
  dataBytes: number;
}

export interface TableStats {
  name: string;
  type: string;
  rowCount: number | null;
  checksum: number | null;
  schemaHash: string | null;
  autoIncrement?: number | null;
}

export interface CapturedTable<T> extends TableStats {
  rowCount: number;
  result: T;
  limitation: string | null;
}

export interface SchemaDefaults {
  characterSet: string;
  collation: string;
}

export interface SchemaCapture<T> {
  tables: CapturedTable<T>[];
  schemaDefaults: SchemaDefaults | null;
  limitations: string[];
}

export interface CaptureTablesOptions<T> {
  open(name: string): Promise<ChunkWriter<T>>;
  stage?(label: string): void;
  progress?(fraction: number): void;
  exclude?: ReadonlySet<string>;
  signal?: AbortSignal;
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function toNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

class Sink<T> {
  private parts: Uint8Array[] = [];
  private size = 0;
  written = 0;

  constructor(private readonly writer: ChunkWriter<T>) {}

  push(bytes: Uint8Array): void {
    if (bytes.length === 0) return;
    this.parts.push(bytes);
    this.size += bytes.length;
    this.written += bytes.length;
  }

  text(s: string): void {
    this.push(encoder.encode(s));
  }

  async maybeFlush(): Promise<void> {
    if (this.size >= FLUSH_BYTES) await this.flush();
  }

  async flush(): Promise<void> {
    if (this.size === 0) return;
    const chunk = this.parts.length === 1 ? this.parts[0]! : Buffer.concat(this.parts, this.size);
    this.parts = [];
    this.size = 0;
    await this.writer.write(chunk);
  }
}

function hexOf(bytes: Uint8Array): Uint8Array {
  const out = new Uint8Array(bytes.length * 2);
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i]!;
    out[i * 2] = HEX[b >> 4]!;
    out[i * 2 + 1] = HEX[b & 15]!;
  }
  return out;
}

function escapedLength(bytes: Uint8Array): number {
  let n = bytes.length;
  for (let i = 0; i < bytes.length; i++) if (ESCAPES[bytes[i]!]) n++;
  return n;
}

function escapeInto(bytes: Uint8Array, out: Uint8Array): void {
  let o = 0;
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i]!;
    const e = ESCAPES[b];
    if (e) {
      out[o++] = e[0]!;
      out[o++] = e[1]!;
    } else {
      out[o++] = b;
    }
  }
}

interface Rendered {
  size: number;
  emit(sink: Sink<unknown>): Promise<void>;
}

const NULL_BYTES = encoder.encode("NULL");
const QUOTE = encoder.encode("'");
const HEX_OPEN = encoder.encode("X'");
const E0 = encoder.encode("e0");

function allBelow0x80(bytes: Uint8Array): boolean {
  for (let i = 0; i < bytes.length; i++) if (bytes[i]! >= 0x80) return false;
  return true;
}

function hasExponent(bytes: Uint8Array): boolean {
  for (const b of bytes) if (b === 101 || b === 69) return true;
  return false;
}

function renderValue(col: Column, value: Buffer | null): Rendered {
  if (value === null) {
    return { size: 4, emit: async (s) => s.push(NULL_BYTES) };
  }
  switch (col.literal) {
    case "number":
      return { size: value.length, emit: async (s) => s.push(value) };
    case "float": {
      const exp = hasExponent(value);
      return {
        size: value.length + (exp ? 0 : 2),
        emit: async (s) => {
          s.push(value);
          if (!exp) s.push(E0);
        },
      };
    }
    case "quoted":
      return quoted(value);
    case "hex":
      return hex(value, null);
    case "text":
      if (col.charset === "ascii" ? allBelow0x80(value) : col.charset !== null && UTF8_CHARSETS.has(col.charset) && isUtf8(value)) {
        return quoted(value);
      }
      return hex(value, col.charset);
  }
}

function quoted(value: Buffer): Rendered {
  const len = escapedLength(value);
  return {
    size: len + 2,
    emit: async (s) => {
      s.push(QUOTE);
      if (len === value.length) {
        s.push(value);
      } else if (value.length <= SLICE_BYTES) {
        const out = new Uint8Array(len);
        escapeInto(value, out);
        s.push(out);
      } else {
        for (let i = 0; i < value.length; i += SLICE_BYTES) {
          const slice = value.subarray(i, Math.min(value.length, i + SLICE_BYTES));
          const out = new Uint8Array(escapedLength(slice));
          escapeInto(slice, out);
          s.push(out);
          await s.maybeFlush();
        }
      }
      s.push(QUOTE);
    },
  };
}

function hex(value: Buffer, charset: string | null): Rendered {
  const intro = charset && SAFE_CHARSET.test(charset) ? encoder.encode(`_${charset} `) : null;
  return {
    size: (intro?.length ?? 0) + 3 + value.length * 2,
    emit: async (s) => {
      if (intro) s.push(intro);
      s.push(HEX_OPEN);
      for (let i = 0; i < value.length; i += SLICE_BYTES) {
        s.push(hexOf(value.subarray(i, Math.min(value.length, i + SLICE_BYTES))));
        if (value.length > SLICE_BYTES) await s.maybeFlush();
      }
      s.push(QUOTE);
    },
  };
}

function literalFor(dataType: string, charset: string | null): { literal: Literal; known: boolean } {
  if (NUMBER_TYPES.has(dataType) || INDEX_TYPES.has(dataType)) return { literal: "number", known: true };
  if (FLOAT_TYPES.has(dataType)) return { literal: "float", known: true };
  if (QUOTED_TYPES.has(dataType)) return { literal: "quoted", known: true };
  if (TEXT_TYPES.has(dataType)) return { literal: charset ? "text" : "hex", known: true };
  if (BINARY_TYPES.has(dataType) || GEOMETRY_TYPES.has(dataType)) return { literal: "hex", known: true };
  return { literal: charset ? "text" : "hex", known: false };
}

async function rows<T extends RowDataPacket[]>(conn: Connection, sql: string, values: unknown[] = []): Promise<T> {
  const [result] = await conn.query<T>(sql, values);
  return result;
}

async function listTables(conn: Connection, schema: string): Promise<TableInfo[]> {
  const found = await rows(
    conn,
    `SELECT TABLE_NAME AS name, TABLE_TYPE AS type, ENGINE AS engine, CREATE_OPTIONS AS opts,
            COALESCE(DATA_LENGTH, 0) + COALESCE(INDEX_LENGTH, 0) AS bytes
       FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_TYPE IN (?)`,
    [schema, TABLE_TYPES],
  );
  return found
    .map((t) => ({
      name: String(t.name),
      type: String(t.type),
      engine: t.engine === null || t.engine === undefined ? null : String(t.engine),
      createOptions: String(t.opts ?? ""),
      dataBytes: Number(t.bytes ?? 0),
    }))
    .sort((a, b) => compare(a.name, b.name));
}

async function schemaDefaultsOf(conn: Connection, schema: string): Promise<SchemaDefaults | null> {
  const found = await rows(
    conn,
    `SELECT DEFAULT_CHARACTER_SET_NAME AS cs, DEFAULT_COLLATION_NAME AS coll FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = ?`,
    [schema],
  );
  const r = found[0];
  if (!r || typeof r.cs !== "string" || typeof r.coll !== "string") return null;
  return { characterSet: r.cs, collation: r.coll };
}

async function supportsHistoryInsert(conn: Connection): Promise<boolean> {
  try {
    await conn.query("SELECT @@session.system_versioning_insert_history AS v");
    return true;
  } catch {
    return false;
  }
}

async function showCreate(conn: Connection, ref: string, sequence: boolean): Promise<string> {
  const found = await rows(conn, `SHOW CREATE ${sequence ? "SEQUENCE" : "TABLE"} ${ref}`);
  const ddl = found[0]?.["Create Table"];
  if (typeof ddl !== "string" || !ddl.trim()) throw new CheckpointCaptureError(`could not read the definition of ${ref}`);
  return ddl;
}

async function checksumOf(conn: Connection, ref: string): Promise<number | null> {
  const found = await rows(conn, `CHECKSUM TABLE ${ref}`);
  return toNumber(found[0]?.Checksum);
}

async function countOf(conn: Connection, ref: string): Promise<number> {
  const found = await rows(conn, `SELECT COUNT(*) AS n FROM ${ref}`);
  return Number(found[0]?.n ?? 0);
}

interface SchemaLayout {
  columns: Map<string, RowDataPacket[]>;
  order: Map<string, string[]>;
}

async function schemaLayout(conn: Connection, schema: string): Promise<SchemaLayout> {
  const cols = await rows(
    conn,
    `SELECT TABLE_NAME AS tbl, COLUMN_NAME AS name, DATA_TYPE AS dataType, CHARACTER_SET_NAME AS charset, IS_GENERATED AS gen,
            GENERATION_EXPRESSION AS expr, IS_NULLABLE AS nullable, COLUMN_TYPE AS columnType, COLUMN_DEFAULT AS dflt
       FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME, ORDINAL_POSITION`,
    [schema],
  );
  const columns = new Map<string, RowDataPacket[]>();
  const nullable = new Map<string, Set<string>>();
  for (const c of cols) {
    const t = String(c.tbl);
    const list = columns.get(t) ?? [];
    list.push(c);
    columns.set(t, list);
    if (c.nullable === "YES") {
      const n = nullable.get(t) ?? new Set<string>();
      n.add(String(c.name));
      nullable.set(t, n);
    }
  }
  const stats = await rows(
    conn,
    `SELECT TABLE_NAME AS tbl, INDEX_NAME AS idx, COLUMN_NAME AS col, SUB_PART AS part
       FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = ? AND NON_UNIQUE = 0
      ORDER BY TABLE_NAME, INDEX_NAME = 'PRIMARY' DESC, INDEX_NAME, SEQ_IN_INDEX`,
    [schema],
  );
  const byTable = new Map<string, Map<string, { cols: string[]; usable: boolean }>>();
  for (const r of stats) {
    const t = String(r.tbl);
    const indexes = byTable.get(t) ?? new Map<string, { cols: string[]; usable: boolean }>();
    const key = String(r.idx);
    const entry = indexes.get(key) ?? { cols: [], usable: true };
    const col = String(r.col);
    entry.cols.push(col);
    if (nullable.get(t)?.has(col) || (r.part !== null && r.part !== undefined)) entry.usable = false;
    indexes.set(key, entry);
    byTable.set(t, indexes);
  }
  const order = new Map<string, string[]>();
  for (const [t, indexes] of byTable) {
    for (const entry of indexes.values()) {
      if (entry.usable && entry.cols.length > 0) {
        order.set(t, [...new Set(entry.cols)]);
        break;
      }
    }
  }
  return { columns, order };
}

function stripImplicitPageChecksum(ddl: string, info: TableInfo): string {
  if (info.engine?.toLowerCase() !== "aria") return ddl;
  if (/\bpage_checksum=/i.test(info.createOptions)) return ddl;
  return ddl.replace(/ PAGE_CHECKSUM=1\b/, "");
}

interface History {
  mode: "none" | "implicit" | "explicit" | "unsupported";
  start: string | null;
  end: string | null;
  why: string | null;
}

function historyMode(info: TableInfo, cols: RowDataPacket[], canInsert: boolean): History {
  if (info.type !== "SYSTEM VERSIONED") return { mode: "none", start: null, end: null, why: null };
  const start = cols.find((c) => String(c.expr ?? "").toUpperCase() === "ROW START");
  const end = cols.find((c) => String(c.expr ?? "").toUpperCase() === "ROW END");
  const timestamp = (c: RowDataPacket) => String(c.dataType).toLowerCase() === "timestamp";
  const name = displayName(info.name);
  if (start && end && (!timestamp(start) || !timestamp(end))) {
    return {
      mode: "unsupported",
      start: null,
      end: null,
      why: `the history of system-versioned table ${name} is not included: it is versioned by transaction id (its row start and end columns are BIGINT), and such a table cannot be reloaded with its history, so only its current rows are kept`,
    };
  }
  if (!canInsert) {
    return {
      mode: "unsupported",
      start: null,
      end: null,
      why: `the history of system-versioned table ${name} is not included: this MariaDB server cannot load row history, so only its current rows are kept`,
    };
  }
  if (!start || !end) return { mode: "implicit", start: "row_start", end: "row_end", why: null };
  return { mode: "explicit", start: String(start.name), end: String(end.name), why: null };
}

function planColumns(table: string, cols: RowDataPacket[], history: History, limitations: string[]): Column[] {
  const out: Column[] = [];
  for (const c of cols) {
    const name = String(c.name);
    const dataType = String(c.dataType).toLowerCase();
    const charset = c.charset === null || c.charset === undefined ? null : String(c.charset).toLowerCase();
    const expr = String(c.expr ?? "").toUpperCase();
    const isPeriod = expr === "ROW START" || expr === "ROW END";
    if (String(c.gen).toUpperCase() === "ALWAYS" && !(isPeriod && history.mode === "explicit")) continue;
    const { literal, known } = literalFor(dataType, charset);
    if (!known) {
      limitations.push(
        `column ${displayName(name)} of table ${displayName(table)} has the type ${dataType}, which LambData does not recognise; its values are stored as ${literal === "hex" ? "raw bytes" : "text"} and checked when a rollback loads them`,
      );
    }
    const quotedName = quoteTableName(name);
    out.push({
      name,
      dataType,
      charset,
      literal,
      select: literal === "float" ? `CAST(${quotedName} AS DOUBLE)` : INDEX_TYPES.has(dataType) ? `(${quotedName}+0)` : quotedName,
      insertName: quotedName,
    });
  }
  if (history.mode === "implicit") {
    out.push({ name: "row_start", dataType: "timestamp", charset: null, literal: "quoted", select: "ROW_START", insertName: "`row_start`" });
    out.push({ name: "row_end", dataType: "timestamp", charset: null, literal: "quoted", select: "ROW_END", insertName: "`row_end`" });
  }
  return out;
}

function needsTrueMembers(c: RowDataPacket): boolean {
  const dataType = String(c.dataType).toLowerCase();
  const charset = String(c.charset ?? "").toLowerCase();
  if (!INDEX_TYPES.has(dataType) || !WIDE_CHARSETS.has(charset)) return false;
  return String(c.columnType ?? "").includes("?") || String(c.dflt ?? "").includes("?");
}

function wideMemberLimitation(table: string, c: RowDataPacket): string {
  return `column ${displayName(String(c.name))} of table ${displayName(table)} is an ${String(c.dataType).toUpperCase()} whose member list MariaDB reports with a "?" in it; MariaDB cannot show characters outside the Basic Multilingual Plane (such as emoji) in a table definition, and LambData could not read the members another way, so a member that contains one comes back with "?" in its place`;
}

async function withTrueMembers(schema: string, table: string, cols: RowDataPacket[], ddl: string, limitations: string[]): Promise<string> {
  const affected = cols.filter(needsTrueMembers);
  if (affected.length === 0) return ddl;
  let out = ddl;
  let conn: Connection | null = null;
  try {
    conn = await openCaptureConnection();
  } catch {
    conn = null;
  }
  try {
    for (const c of affected) {
      const column = { name: String(c.name), columnType: String(c.columnType ?? ""), columnDefault: c.dflt === null || c.dflt === undefined ? null : String(c.dflt) };
      const truth = conn ? await readTrueMembers(conn, schema, table, column).catch(() => null) : null;
      const fixed = truth ? rewriteMembers(out, column, truth) : null;
      if (fixed === null) limitations.push(wideMemberLimitation(table, c));
      else out = fixed;
    }
  } finally {
    if (conn) await conn.end().catch(() => conn?.destroy());
  }
  return out;
}

interface CoreConnection {
  query(opts: unknown): { stream(opts?: unknown): AsyncIterable<(Buffer | null)[]> & { destroy(err?: Error): void } };
  on(event: string, fn: (...args: unknown[]) => void): void;
  off(event: string, fn: (...args: unknown[]) => void): void;
  stream?: { on(event: string, fn: () => void): void; off(event: string, fn: () => void): void };
}

function coreOf(conn: Connection): CoreConnection {
  return (conn as unknown as { connection: CoreConnection }).connection;
}

async function streamRows(
  conn: Connection,
  sql: string,
  label: string,
  guard: CaptureGuard,
  onRow: (row: (Buffer | null)[]) => Promise<void>,
): Promise<void> {
  guard.check();
  await conn.query("SET SESSION character_set_results = binary");
  const core = coreOf(conn);
  const stream = core.query({ sql, rowsAsArray: true, typeCast: (field: { buffer(): Buffer | null }) => field.buffer() }).stream({ highWaterMark: 128 });
  let failure: Error | null = null;
  let rejectFailed: (err: Error) => void = () => {};
  const failed = new Promise<never>((_, reject) => {
    rejectFailed = reject;
  });
  failed.catch(() => {});
  const fail = (err: Error): void => {
    if (failure) return;
    failure = err;
    rejectFailed(err);
    stream.destroy(err);
  };
  const lost = (): void => fail(new CaptureInterruptedError(`the connection to MariaDB was lost while the checkpoint was reading table ${label}`));
  let last = Date.now();
  let inRow = false;
  let checking = false;
  const stalled = (): void =>
    fail(new CaptureInterruptedError(`reading table ${label} made no progress for ${Math.round(captureLimits.inactivityMs / 1000)} seconds, so the checkpoint was stopped`));
  const timer = setInterval(() => {
    if (failure || checking || Date.now() - last <= captureLimits.inactivityMs) return;
    if (inRow) {
      stalled();
      return;
    }
    checking = true;
    serverStillWorking(conn)
      .then((busy) => {
        if (busy) last = Date.now();
        else stalled();
      })
      .finally(() => {
        checking = false;
      });
  }, Math.min(5_000, Math.max(50, Math.floor(captureLimits.inactivityMs / 4))));
  timer.unref?.();
  const stop = guard.onAbort(fail);
  core.on("end", lost);
  core.on("error", lost);
  core.stream?.on("close", lost);
  try {
    for await (const row of stream) {
      last = Date.now();
      inRow = true;
      await Promise.race([onRow(row), failed]);
      inRow = false;
      last = Date.now();
    }
  } catch (err) {
    throw failure ?? err;
  } finally {
    clearInterval(timer);
    stop();
    core.off("end", lost);
    core.off("error", lost);
    core.stream?.off("close", lost);
  }
  if (failure) throw failure;
  await conn.query("SET SESSION character_set_results = utf8mb4");
}

const PROGRESS_CHECK_MS = 5_000;

async function serverStillWorking(conn: Connection): Promise<boolean> {
  const id = (conn as unknown as { threadId?: number }).threadId;
  if (!id) return false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), PROGRESS_CHECK_MS);
  });
  const check = (async () => {
    const admin = await openAdminConnection();
    try {
      const [found] = await admin.query<RowDataPacket[]>("SELECT COMMAND AS c FROM information_schema.PROCESSLIST WHERE ID = ?", [id]);
      return found.length > 0 && String(found[0]!.c) === "Query";
    } finally {
      admin.destroy();
    }
  })().catch(() => false);
  try {
    return await Promise.race([check, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

class CaptureGuard {
  private reason: Error | null = null;
  private readonly listeners = new Set<(err: Error) => void>();

  constructor(private readonly conn: Connection) {}

  abort(message: string): void {
    if (this.reason) return;
    this.reason = new CaptureInterruptedError(message);
    for (const l of [...this.listeners]) l(this.reason);
    this.conn.destroy();
  }

  onAbort(fn: (err: Error) => void): () => void {
    if (this.reason) fn(this.reason);
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  check(): void {
    if (this.reason) throw this.reason;
  }

  get aborted(): Error | null {
    return this.reason;
  }
}

export class TableVanishedError extends CheckpointCaptureError {
  constructor(readonly table: string) {
    super(`table ${displayName(table)} disappeared while the checkpoint was being taken`);
    this.name = "TableVanishedError";
  }
}

function isNoSuchTable(err: unknown): boolean {
  return (err as { errno?: number } | null)?.errno === ER_NO_SUCH_TABLE;
}

const AUTO_INCREMENT_CLAUSE = / AUTO_INCREMENT=(\d+)/;

export function autoIncrementOf(ddl: string): number {
  const m = AUTO_INCREMENT_CLAUSE.exec(ddl);
  return m ? Number(m[1]) : 0;
}

interface WrittenTable {
  rowCount: number;
  checksum: number | null;
  schemaHash: string;
  autoIncrement: number;
  limitation: string | null;
  limitations: string[];
}

async function writeTable<T>(
  conn: Connection,
  schema: string,
  info: TableInfo,
  layout: SchemaLayout,
  writer: ChunkWriter<T>,
  canInsertHistory: boolean,
  guard: CaptureGuard,
  report: (bytes: number) => void,
): Promise<WrittenTable> {
  const ref = `${quoteTableName(schema)}.${quoteTableName(info.name)}`;
  const local = quoteTableName(info.name);
  const isSequence = info.type === "SEQUENCE";
  const limitations: string[] = [];
  const tableDdl = await showCreate(conn, ref, false);
  const hash = schemaHash(tableDdl);
  const sink = new Sink(writer);
  const checksumBefore = await checksumOf(conn, ref);
  let rowCount = 0;
  let limitation: string | null = null;

  sink.text(`${OBJECT_HEADER} ${displayName(info.name)}\nDROP TABLE IF EXISTS ${local};\n`);
  if (isSequence) {
    sink.text(`${await showCreate(conn, ref, true)};\n`);
    const state = await rows(conn, `SELECT next_not_cached_value AS n, cycle_count AS c FROM ${ref}`);
    const n = String(state[0]?.n ?? "");
    const c = String(state[0]?.c ?? "0");
    if (!/^-?\d+$/.test(n) || !/^-?\d+$/.test(c)) throw new CheckpointCaptureError(`could not read the state of sequence ${displayName(info.name)}`);
    sink.text(`DO SETVAL(${local}, ${n}, 0, ${c});\n`);
    rowCount = 1;
  } else {
    const cols = layout.columns.get(info.name) ?? [];
    const ddl = await withTrueMembers(schema, info.name, cols, tableDdl, limitations);
    sink.text(`${stripImplicitPageChecksum(ddl, info)};\n`);
    const history = historyMode(info, cols, canInsertHistory);
    if (history.why) limitation = history.why;
    const columns = planColumns(info.name, cols, history, limitations);
    if (columns.length > 0) {
      const order = layout.order.get(info.name) ?? [];
      const orderBy = [...order.map(quoteTableName), ...(history.mode === "implicit" ? ["ROW_END"] : history.end ? [quoteTableName(history.end)] : [])];
      const withHistory = history.mode === "implicit" || history.mode === "explicit";
      const sql = `SELECT ${columns.map((c) => c.select).join(", ")} FROM ${ref}${withHistory ? " FOR SYSTEM_TIME ALL" : ""}${orderBy.length > 0 ? ` ORDER BY ${orderBy.join(", ")}` : ""}`;
      const head = encoder.encode(`INSERT INTO ${local} (${columns.map((c) => c.insertName).join(", ")}) VALUES `);
      if (withHistory) sink.text("SET @@session.system_versioning_insert_history = 1;\n");
      let statement = 0;
      let emitted = 0;
      await streamRows(conn, sql, displayName(info.name), guard, async (row) => {
        const values = row.map((v, i) => renderValue(columns[i]!, v));
        const size = values.reduce((n, v) => n + v.size, 0) + values.length + 1;
        if (head.length + size + 2 > MAX_STATEMENT_BYTES) {
          throw new CheckpointCaptureError(
            `a row of table ${displayName(info.name)} is ${Math.round(size / 1024 / 1024)} MB as SQL, more than MariaDB can load in one statement; the checkpoint was not taken`,
          );
        }
        if (statement > 0 && statement + size + 1 > BATCH_BYTES) {
          sink.text(";\n");
          statement = 0;
        }
        if (statement === 0) {
          sink.push(head);
          statement = head.length;
        } else {
          sink.text(",");
          statement++;
        }
        sink.text("(");
        for (let i = 0; i < values.length; i++) {
          if (i > 0) sink.text(",");
          await values[i]!.emit(sink as Sink<unknown>);
        }
        sink.text(")");
        statement += size;
        emitted++;
        await sink.maybeFlush();
        report(size);
      });
      if (statement > 0) sink.text(";\n");
      if (withHistory) sink.text("SET @@session.system_versioning_insert_history = 0;\n");
      rowCount = info.type === "SYSTEM VERSIONED" ? await countOf(conn, ref) : emitted;
    }
  }
  await sink.flush();
  let checksum = checksumBefore;
  const transactional = !isSequence && info.engine?.toLowerCase() === "innodb";
  if (!transactional && checksum !== null && (await checksumOf(conn, ref)) !== checksum) checksum = null;
  if (limitation) checksum = null;
  return { rowCount, checksum, schemaHash: hash, autoIncrement: autoIncrementOf(tableDdl), limitation, limitations };
}

export async function openCaptureConnection(): Promise<Connection> {
  const conn = await openAdminConnection();
  try {
    await conn.query("SET NAMES utf8mb4");
    await conn.query("SET SESSION max_statement_time = 0");
    await conn.query("SET SESSION sql_mode = ''");
    await conn.query("SET SESSION sql_quote_show_create = 1");
    await conn.query("SET SESSION time_zone = '+00:00'");
    await conn.query("SET SESSION lock_wait_timeout = ?", [LOCK_WAIT_SEC]);
    await conn.query("SET SESSION net_write_timeout = ?", [NET_WRITE_TIMEOUT_SEC]);
    return conn;
  } catch (err) {
    conn.destroy();
    throw err;
  }
}

async function stillExists(conn: Connection, schema: string, table: string): Promise<boolean> {
  try {
    const found = await rows(conn, "SELECT COUNT(*) AS n FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?", [schema, table]);
    return Number(found[0]?.n ?? 0) > 0;
  } catch {
    return true;
  }
}

export async function captureSchemaTables<T>(schema: string, opts: CaptureTablesOptions<T>): Promise<SchemaCapture<T>> {
  const conn = await openCaptureConnection();
  const guard = new CaptureGuard(conn);
  const entry: RunningCapture = { abort: (reason) => guard.abort(reason) };
  running.add(entry);
  const onSignal = (): void => {
    const reason = opts.signal?.reason;
    guard.abort(reason instanceof Error ? reason.message : typeof reason === "string" && reason ? reason : "the checkpoint was cancelled");
  };
  if (opts.signal?.aborted) onSignal();
  opts.signal?.addEventListener("abort", onSignal, { once: true });
  const captured: CapturedTable<T>[] = [];
  let current: ChunkWriter<T> | null = null;
  let ok = false;
  try {
    const exclude = opts.exclude ?? new Set<string>();
    guard.check();
    const first = (await listTables(conn, schema)).filter((t) => !exclude.has(t.name));
    opts.stage?.(`Dumping ${first.length} table(s)`);
    guard.check();
    await conn.query("SET SESSION TRANSACTION ISOLATION LEVEL REPEATABLE READ");
    await conn.query("START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY");
    const tables = (await listTables(conn, schema)).filter((t) => !exclude.has(t.name));
    const schemaDefaults = await schemaDefaultsOf(conn, schema);
    const canInsertHistory = await supportsHistoryInsert(conn);
    const layout = await schemaLayout(conn, schema);
    const limitations: string[] = [];
    const total = Math.max(1, tables.reduce((n, t) => n + t.dataBytes, 0) * 1.3);
    let seen = 0;
    for (const info of tables) {
      guard.check();
      current = await opts.open(info.name);
      let written: WrittenTable;
      try {
        written = await writeTable(conn, schema, info, layout, current, canInsertHistory, guard, (n) => {
          seen += n;
          opts.progress?.(Math.min(1, seen / total));
        });
      } catch (err) {
        if (guard.aborted) throw guard.aborted;
        if (isNoSuchTable(err) && !(await stillExists(conn, schema, info.name))) {
          await current.abort().catch(() => {});
          current = null;
          limitations.push(new TableVanishedError(info.name).message);
          continue;
        }
        if (err instanceof CheckpointCaptureError) throw err;
        throw new CheckpointCaptureError(`could not capture table ${displayName(info.name)}: ${errorMessage(err)}`);
      }
      const result = await current.finish();
      current = null;
      if (written.limitation) limitations.push(written.limitation);
      limitations.push(...written.limitations);
      captured.push({
        name: info.name,
        type: info.type,
        rowCount: written.rowCount,
        checksum: written.checksum,
        schemaHash: written.schemaHash,
        autoIncrement: written.autoIncrement,
        limitation: written.limitation,
        result,
      });
    }
    guard.check();
    await conn.query("COMMIT");
    ok = true;
    return { tables: captured, schemaDefaults, limitations };
  } catch (err) {
    throw guard.aborted ?? err;
  } finally {
    running.delete(entry);
    opts.signal?.removeEventListener("abort", onSignal);
    if (current) await current.abort().catch(() => {});
    if (ok) await conn.end().catch(() => conn.destroy());
    else conn.destroy();
  }
}

export async function readTableStats(conn: Connection, schema: string): Promise<TableStats[]> {
  const out: TableStats[] = [];
  for (const t of await listTables(conn, schema)) {
    const ref = `${quoteTableName(schema)}.${quoteTableName(t.name)}`;
    let ddl: string;
    try {
      ddl = await showCreate(conn, ref, false);
    } catch (err) {
      if (isNoSuchTable(err)) continue;
      throw err;
    }
    out.push({
      name: t.name,
      type: t.type,
      rowCount: await countOf(conn, ref),
      checksum: await checksumOf(conn, ref),
      schemaHash: schemaHash(ddl),
      autoIncrement: autoIncrementOf(ddl),
    });
  }
  return out;
}

export async function tableDataBytes(conn: Connection, schema: string): Promise<number> {
  return (await listTables(conn, schema)).reduce((n, t) => n + t.dataBytes, 0);
}
