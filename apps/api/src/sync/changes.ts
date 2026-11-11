import type { Connection, RowDataPacket } from "mysql2/promise";
import type { RowChangeNetReason, SyncChangeSummary, TableRowChange } from "@lambdata/shared";
import { openAdminConnection } from "../mariadb/controller";
import { quoteIdent } from "../util/ident";
import { readEnv } from "../util/readEnv";
import { quoteTableName, TABLE_TYPES } from "../checkpoints/tables";

export const DEFAULT_DIFF_MAX_ROWS = 2_000_000;
export const DEFAULT_DIFF_MAX_SECONDS = 30;
export const MAX_LISTED_TABLES = 50;

const ER_STATEMENT_TIMEOUT = 1969;
const DIRECT_TYPES = new Set([
  "tinyint",
  "smallint",
  "mediumint",
  "int",
  "integer",
  "bigint",
  "decimal",
  "numeric",
  "float",
  "double",
  "real",
  "bit",
  "year",
  "date",
  "datetime",
  "timestamp",
  "time",
  "inet4",
  "inet6",
  "uuid",
]);

export type NetReason = RowChangeNetReason;

export type MeasuredTableChange = TableRowChange;

export interface ChangeLimits {
  maxRows: number;
  maxSeconds: number;
}

export interface TableHint {
  name: string;
  rowCount: number | null;
  checksum: number | null;
}

export interface ChangeHints {
  live?: TableHint[] | null;
  staging?: TableHint[] | null;
}

export interface ChangeBudget {
  deadline: number;
}

export interface MeasureOptions {
  limits?: ChangeLimits;
  hints?: ChangeHints;
  budget?: ChangeBudget;
}

interface ColumnInfo {
  name: string;
  dataType: string;
  nullable: boolean;
  generated: boolean;
  dataSig: string;
  fullSig: string;
}

interface IndexInfo {
  name: string;
  unique: boolean;
  type: string;
  columns: string[];
  prefixed: boolean;
  sig: string;
}

interface TableMeta {
  name: string;
  type: string;
  engine: string | null;
  bytes: number;
  estRows: number;
  columns: ColumnInfo[];
  indexes: IndexInfo[];
}

interface Measured {
  change: MeasuredTableChange | null;
  method: "exact" | "net";
  before: number;
  after: number;
}

function envNumber(name: string, fallback: number): number {
  const raw = readEnv(name);
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

export function changeLimits(): ChangeLimits {
  return {
    maxRows: envNumber("SYNC_DIFF_MAX_ROWS", DEFAULT_DIFF_MAX_ROWS),
    maxSeconds: envNumber("SYNC_DIFF_MAX_SECONDS", DEFAULT_DIFF_MAX_SECONDS),
  };
}

export function changeBudget(limits: ChangeLimits = changeLimits(), now = Date.now()): ChangeBudget {
  return { deadline: now + limits.maxSeconds * 1000 };
}

function str(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (Buffer.isBuffer(v)) return v.toString("utf8");
  return String(v);
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

async function rows(conn: Connection, sql: string, values: unknown[] = []): Promise<RowDataPacket[]> {
  const [result] = await conn.query<RowDataPacket[]>(sql, values);
  return result;
}

async function loadMeta(conn: Connection, schema: string): Promise<Map<string, TableMeta>> {
  const tables = new Map<string, TableMeta>();
  for (const t of await rows(
    conn,
    `SELECT TABLE_NAME AS name, TABLE_TYPE AS type, ENGINE AS engine,
            COALESCE(DATA_LENGTH, 0) + COALESCE(INDEX_LENGTH, 0) AS bytes, COALESCE(TABLE_ROWS, 0) AS estRows
       FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_TYPE IN (?)`,
    [schema, TABLE_TYPES],
  )) {
    const name = str(t.name);
    tables.set(name, {
      name,
      type: str(t.type),
      engine: t.engine === null ? null : str(t.engine),
      bytes: Number(t.bytes) || 0,
      estRows: Number(t.estRows) || 0,
      columns: [],
      indexes: [],
    });
  }
  for (const c of await rows(
    conn,
    `SELECT TABLE_NAME AS tbl, COLUMN_NAME AS name, DATA_TYPE AS dataType, COLUMN_TYPE AS columnType, COLLATION_NAME AS coll,
            IS_NULLABLE AS nullable, IS_GENERATED AS gen, GENERATION_EXPRESSION AS expr, COLUMN_DEFAULT AS dflt, EXTRA AS extra
       FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME, ORDINAL_POSITION`,
    [schema],
  )) {
    const table = tables.get(str(c.tbl));
    if (!table) continue;
    const generated = str(c.gen).toUpperCase() === "ALWAYS";
    const dataSig = JSON.stringify([str(c.name), str(c.columnType).toLowerCase(), str(c.coll), generated]);
    table.columns.push({
      name: str(c.name),
      dataType: str(c.dataType).toLowerCase(),
      nullable: str(c.nullable).toUpperCase() === "YES",
      generated,
      dataSig,
      fullSig: JSON.stringify([dataSig, str(c.nullable), c.dflt === null ? null : str(c.dflt), str(c.expr), str(c.extra)]),
    });
  }
  const byIndex = new Map<string, IndexInfo & { table: string }>();
  for (const s of await rows(
    conn,
    `SELECT TABLE_NAME AS tbl, INDEX_NAME AS idx, NON_UNIQUE AS nonUnique, SEQ_IN_INDEX AS seq, COLUMN_NAME AS col,
            SUB_PART AS sub, INDEX_TYPE AS itype
       FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME, INDEX_NAME, SEQ_IN_INDEX`,
    [schema],
  )) {
    const table = str(s.tbl);
    if (!tables.has(table)) continue;
    const key = JSON.stringify([table, str(s.idx)]);
    let idx = byIndex.get(key);
    if (!idx) {
      idx = { table, name: str(s.idx), unique: Number(s.nonUnique) === 0, type: str(s.itype).toUpperCase(), columns: [], prefixed: false, sig: "" };
      byIndex.set(key, idx);
    }
    idx.columns.push(str(s.col));
    if (s.sub !== null && s.sub !== undefined) idx.prefixed = true;
  }
  for (const idx of byIndex.values()) {
    idx.sig = JSON.stringify([idx.name, idx.unique, idx.type, idx.columns, idx.prefixed]);
    tables.get(idx.table)!.indexes.push(idx);
  }
  for (const t of tables.values()) t.indexes.sort((a, b) => compare(a.name, b.name));
  return tables;
}

function dataSignature(t: TableMeta): string {
  return JSON.stringify(t.columns.map((c) => c.dataSig).sort(compare));
}

function structureSignature(t: TableMeta): string {
  return JSON.stringify([t.type, (t.engine ?? "").toLowerCase(), t.columns.map((c) => c.fullSig), t.indexes.map((i) => i.sig)]);
}

function usableKey(after: TableMeta, before: TableMeta): IndexInfo | null {
  const ordered = [...after.indexes].sort((a, b) => (a.name === "PRIMARY" ? -1 : b.name === "PRIMARY" ? 1 : compare(a.name, b.name)));
  const columnsAfter = new Map(after.columns.map((c) => [c.name, c]));
  const columnsBefore = new Map(before.columns.map((c) => [c.name, c]));
  for (const idx of ordered) {
    if (!idx.unique || idx.prefixed || idx.type !== "BTREE" || idx.columns.length === 0) continue;
    const twin = before.indexes.find((i) => i.name === idx.name);
    if (!twin || twin.sig !== idx.sig) continue;
    const allNotNull = idx.columns.every((name) => {
      const a = columnsAfter.get(name);
      const b = columnsBefore.get(name);
      return a && b && !a.nullable && !b.nullable && !a.generated;
    });
    if (allNotNull) return idx;
  }
  return null;
}

function columnEquality(c: ColumnInfo): string {
  const q = quoteTableName(c.name);
  if (DIRECT_TYPES.has(c.dataType)) return `n.${q} <=> o.${q}`;
  return `CAST(n.${q} AS BINARY) <=> CAST(o.${q} AS BINARY)`;
}

function hintMap(list: TableHint[] | null | undefined): Map<string, TableHint> {
  return new Map((list ?? []).map((h) => [h.name, h]));
}

function hintCount(h: TableHint | undefined): number | null {
  return h && typeof h.rowCount === "number" && Number.isFinite(h.rowCount) ? h.rowCount : null;
}

function hintChecksum(h: TableHint | undefined): number | null {
  return h && typeof h.checksum === "number" && Number.isFinite(h.checksum) ? h.checksum : null;
}

function isTimeout(err: unknown): boolean {
  const e = err as { errno?: number; code?: string } | null;
  return e?.errno === ER_STATEMENT_TIMEOUT || e?.code === "ER_STATEMENT_TIMEOUT";
}

class OutOfTime extends Error {
  constructor() {
    super("the time for measuring this sync ran out");
    this.name = "OutOfTime";
  }
}

interface Analysis {
  schemaChanged: boolean;
  sameColumns: boolean;
  key: IndexInfo | null;
  reason: NetReason | null;
}

interface Settled {
  final?: Measured;
  fallback?: Measured;
}

class Measurer {
  private exhausted = false;
  private counted = new Map<string, number>();

  constructor(
    private conn: Connection,
    private side: Connection,
    private live: string,
    private staging: string,
    private limits: ChangeLimits,
    private budget: ChangeBudget,
    private liveHints: Map<string, TableHint>,
    private stagingHints: Map<string, TableHint>,
  ) {}

  spent(): boolean {
    if (!this.exhausted && Date.now() >= this.budget.deadline) this.exhausted = true;
    return this.exhausted;
  }

  private ref(schema: string, table: string): string {
    return `${quoteIdent(schema)}.${quoteTableName(table)}`;
  }

  private async run(sql: string, conn: Connection = this.conn): Promise<RowDataPacket[]> {
    if (this.spent()) throw new OutOfTime();
    const left = Math.max(0.001, (this.budget.deadline - Date.now()) / 1000);
    await conn.query(`SET SESSION max_statement_time = ${left.toFixed(3)}`);
    try {
      return await rows(conn, sql);
    } catch (err) {
      if (!isTimeout(err)) throw err;
      this.exhausted = true;
      throw new OutOfTime();
    }
  }

  private async count(schema: string, table: string): Promise<number> {
    const hint = hintCount((schema === this.live ? this.liveHints : this.stagingHints).get(table));
    if (hint !== null) return hint;
    const key = `${schema}\u0000${table}`;
    const known = this.counted.get(key);
    if (known !== undefined) return known;
    const n = Number((await this.run(`SELECT COUNT(*) AS n FROM ${this.ref(schema, table)}`, this.connFor(schema)))[0]?.n ?? 0);
    this.counted.set(key, n);
    return n;
  }

  private async checksum(schema: string, table: string): Promise<number | null> {
    const hint = hintChecksum((schema === this.live ? this.liveHints : this.stagingHints).get(table));
    if (hint !== null) return hint;
    const v = (await this.run(`CHECKSUM TABLE ${this.ref(schema, table)}`, this.connFor(schema)))[0]?.Checksum;
    if (v === null || v === undefined) return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }

  private connFor(schema: string): Connection {
    return schema === this.staging ? this.side : this.conn;
  }

  private async both<T>(a: () => Promise<T>, b: () => Promise<T>): Promise<[T, T]> {
    const results = await Promise.allSettled([a(), b()]);
    for (const r of results) if (r.status === "rejected" && !(r.reason instanceof OutOfTime)) throw r.reason;
    for (const r of results) if (r.status === "rejected") throw r.reason;
    return [(results[0] as PromiseFulfilledResult<T>).value, (results[1] as PromiseFulfilledResult<T>).value];
  }

  private exactAllowed(): boolean {
    return this.limits.maxRows > 0 && this.limits.maxSeconds > 0;
  }

  private analyse(after: TableMeta, before: TableMeta): Analysis {
    const schemaChanged = structureSignature(after) !== structureSignature(before);
    const sameColumns = dataSignature(after) === dataSignature(before);
    const plain = after.type === "BASE TABLE" && before.type === "BASE TABLE";
    const innodb = (before.engine ?? "").toLowerCase() === "innodb";
    const key = sameColumns && plain && innodb ? usableKey(after, before) : null;
    let reason: NetReason | null = null;
    if (!this.exactAllowed()) reason = "off";
    else if (!plain) reason = "unsupported";
    else if (!sameColumns) reason = "structure";
    else if (!key) reason = innodb ? "no-key" : "unsupported";
    return { schemaChanged, sameColumns, key, reason };
  }

  private same(name: string, rowsNow: number, a: Analysis): Measured {
    const method = a.reason === null && rowsNow <= this.limits.maxRows ? "exact" : "net";
    if (!a.schemaChanged) return { method, before: rowsNow, after: rowsNow, change: null };
    const change =
      method === "exact" ? exact(name, true, rowsNow, rowsNow, 0, 0, 0) : net(name, "modified", true, rowsNow, rowsNow, a.reason ?? "too-large");
    return { method, before: rowsNow, after: rowsNow, change };
  }

  settle(after: TableMeta | undefined, before: TableMeta | undefined): Settled {
    if (after && !before) {
      const n = hintCount(this.stagingHints.get(after.name));
      return n === null ? {} : { final: { method: "net", before: 0, after: n, change: net(after.name, "added", true, null, n, "new") } };
    }
    if (before && !after) {
      const n = hintCount(this.liveHints.get(before.name));
      return n === null ? {} : { final: { method: "net", before: n, after: 0, change: net(before.name, "removed", true, n, null, "removed") } };
    }
    if (!after || !before) return {};
    const a = this.analyse(after, before);
    const lh = this.liveHints.get(after.name);
    const sh = this.stagingHints.get(after.name);
    const b0 = hintCount(lh);
    const a0 = hintCount(sh);
    const lc = hintChecksum(lh);
    const sc = hintChecksum(sh);
    if (b0 === null || a0 === null) return {};
    if (a.sameColumns && lc !== null && sc !== null && lc === sc && b0 === a0) return { final: this.same(after.name, a0, a) };
    const changed = !a.sameColumns || b0 !== a0 || (lc !== null && sc !== null && lc !== sc);
    if (!changed) return {};
    const tooLarge = a.reason === null && Math.max(a0, b0) > this.limits.maxRows;
    const result = (reason: NetReason): Measured => ({ method: "net", before: b0, after: a0, change: net(after.name, "modified", a.schemaChanged, b0, a0, reason) });
    if (a.reason !== null) return { final: result(a.reason) };
    if (tooLarge) return { final: result("too-large") };
    return { fallback: result("time") };
  }

  async work(after: TableMeta | undefined, before: TableMeta | undefined): Promise<Measured> {
    if (after && !before) {
      const n = await this.count(this.staging, after.name);
      return { method: "net", before: 0, after: n, change: net(after.name, "added", true, null, n, "new") };
    }
    if (before && !after) {
      const n = await this.count(this.live, before.name);
      return { method: "net", before: n, after: 0, change: net(before.name, "removed", true, n, null, "removed") };
    }
    const t = after!;
    const a = this.analyse(t, before!);
    const netResult = async (reason: NetReason): Promise<Measured> => {
      const [b, n] = await this.both(
        () => this.count(this.live, t.name),
        () => this.count(this.staging, t.name),
      );
      return { method: "net", before: b, after: n, change: net(t.name, "modified", a.schemaChanged, b, n, reason) };
    };
    if (!a.sameColumns) return netResult(a.reason ?? "structure");
    const [lc, sc] = await this.both(
      () => this.checksum(this.live, t.name),
      () => this.checksum(this.staging, t.name),
    );
    const b0 = hintCount(this.liveHints.get(t.name));
    const a0 = hintCount(this.stagingHints.get(t.name));
    const countsDiffer = b0 !== null && a0 !== null && b0 !== a0;
    if (lc !== null && sc !== null && lc === sc && !countsDiffer) {
      if (!a.schemaChanged) return { method: a.reason === null ? "exact" : "net", before: 0, after: 0, change: null };
      return this.same(t.name, await this.count(this.staging, t.name), a);
    }
    if (a.reason !== null || !a.key) return netResult(a.reason ?? "no-key");
    const estimate = Math.max(b0 ?? before!.estRows, a0 ?? t.estRows);
    if (estimate > this.limits.maxRows) return netResult("too-large");
    const result = await this.exact(t, a.key, a.schemaChanged);
    return typeof result === "string" ? netResult(result) : result;
  }

  private async exact(t: TableMeta, key: IndexInfo, schemaChanged: boolean): Promise<Measured | NetReason> {
    const liveRef = this.ref(this.live, t.name);
    const stagingRef = this.ref(this.staging, t.name);
    const on = key.columns.map((c) => `n.${quoteTableName(c)} = o.${quoteTableName(c)}`).join(" AND ");
    const probe = `o.${quoteTableName(key.columns[0]!)}`;
    const compared = t.columns.filter((c) => !c.generated);
    const same = compared.length > 0 ? compared.map(columnEquality).join(" AND ") : "1";
    const sql = `SELECT COUNT(*) AS n, COALESCE(SUM(${probe} IS NULL), 0) AS added,
        COALESCE(SUM(${probe} IS NOT NULL AND NOT (${same})), 0) AS changed
      FROM ${stagingRef} AS n LEFT JOIN ${liveRef} AS o ON ${on}`;
    let began = false;
    try {
      await this.conn.query("SET SESSION TRANSACTION ISOLATION LEVEL REPEATABLE READ");
      await this.conn.query("START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY");
      began = true;
      const before = Number((await this.run(`SELECT COUNT(*) AS n FROM ${liveRef}`))[0]?.n ?? 0);
      if (before > this.limits.maxRows) return "too-large";
      const found = (await this.run(sql))[0];
      const after = Number(found?.n ?? 0);
      const added = Number(found?.added ?? 0);
      const changed = Number(found?.changed ?? 0);
      const removed = before - (after - added);
      if (removed < 0 || ![after, added, changed].every(Number.isFinite)) return "no-key";
      const touched = added + removed + changed > 0;
      return {
        method: "exact",
        before,
        after,
        change: touched || schemaChanged ? exact(t.name, schemaChanged, before, after, added, removed, changed) : null,
      };
    } finally {
      if (began) await this.conn.query("COMMIT").catch(() => {});
    }
  }
}

function net(
  name: string,
  change: TableRowChange["change"],
  schemaChanged: boolean,
  rowsBefore: number | null,
  rowsAfter: number | null,
  reason: NetReason,
): MeasuredTableChange {
  return { name, change, method: "net", schemaChanged, rowsBefore, rowsAfter, added: null, removed: null, changed: null, reason };
}

function exact(
  name: string,
  schemaChanged: boolean,
  rowsBefore: number,
  rowsAfter: number,
  added: number,
  removed: number,
  changed: number,
): TableRowChange {
  return { name, change: "modified", method: "exact", schemaChanged, rowsBefore, rowsAfter, added, removed, changed };
}

export function changeSize(t: TableRowChange): number {
  if (t.method === "exact") return (t.added ?? 0) + (t.removed ?? 0) + (t.changed ?? 0);
  return Math.abs((t.rowsAfter ?? 0) - (t.rowsBefore ?? 0));
}

export function summarize(measured: Measured[], notCompared = 0): SyncChangeSummary {
  const changed = measured.map((m) => m.change).filter((c): c is MeasuredTableChange => c !== null);
  const exactAll = measured.filter((m) => m.method === "exact");
  const exactChanged = changed.filter((c) => c.method === "exact");
  const sum = (pick: (c: TableRowChange) => number | null) => exactChanged.reduce((n, c) => n + (pick(c) ?? 0), 0);
  const sorted = [...changed].sort((a, b) => changeSize(b) - changeSize(a) || compare(a.name, b.name));
  return {
    tablesChanged: changed.length,
    tablesUnchanged: measured.length - changed.length,
    exactTables: exactAll.length,
    netTables: measured.length - exactAll.length,
    rowsAdded: exactAll.length > 0 ? sum((c) => c.added) : null,
    rowsRemoved: exactAll.length > 0 ? sum((c) => c.removed) : null,
    rowsChanged: exactAll.length > 0 ? sum((c) => c.changed) : null,
    rowDelta: notCompared > 0 ? null : measured.reduce((n, m) => n + m.after - m.before, 0),
    tables: sorted.slice(0, MAX_LISTED_TABLES),
    truncated: sorted.length > MAX_LISTED_TABLES,
    tablesNotCompared: notCompared,
  };
}

export async function measureSyncChanges(live: string, staging: string, opts: MeasureOptions = {}): Promise<SyncChangeSummary> {
  const limits = opts.limits ?? changeLimits();
  const budget = opts.budget ?? changeBudget(limits);
  const conn = await openAdminConnection();
  let side: Connection | null = null;
  try {
    await conn.query("SET NAMES utf8mb4");
    side = await openAdminConnection();
    await side.query("SET NAMES utf8mb4");
    const before = await loadMeta(conn, live);
    const after = await loadMeta(conn, staging);
    const m = new Measurer(conn, side, live, staging, limits, budget, hintMap(opts.hints?.live), hintMap(opts.hints?.staging));
    const measured: Measured[] = [];
    const pending: { after?: TableMeta; before?: TableMeta; fallback?: Measured; bytes: number; name: string }[] = [];
    for (const name of [...new Set([...after.keys(), ...before.keys()])].sort(compare)) {
      const a = after.get(name);
      const b = before.get(name);
      const settled = m.settle(a, b);
      if (settled.final) measured.push(settled.final);
      else pending.push({ after: a, before: b, fallback: settled.fallback, bytes: Math.max(a?.bytes ?? 0, b?.bytes ?? 0), name });
    }
    pending.sort((x, y) => x.bytes - y.bytes || compare(x.name, y.name));
    let notCompared = 0;
    for (const p of pending) {
      try {
        if (m.spent()) throw new OutOfTime();
        measured.push(await m.work(p.after, p.before));
      } catch (err) {
        if (!(err instanceof OutOfTime)) throw err;
        if (p.fallback) measured.push(p.fallback);
        else notCompared++;
      }
    }
    return summarize(measured, notCompared);
  } finally {
    await conn.end().catch(() => conn.destroy());
    if (side) {
      const s = side;
      await s.end().catch(() => s.destroy());
    }
  }
}

export const syncChanges = {
  measure: measureSyncChanges,
};
