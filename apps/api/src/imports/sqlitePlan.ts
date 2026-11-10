import { openSync, readSync, closeSync } from "node:fs";
import type { Database } from "bun:sqlite";
import type {
  ImportColumnPlan,
  ImportForeignKeyPlan,
  ImportIndexPlan,
  ImportSkippedObject,
  ImportTablePlan,
  ImportUpload,
  SqliteImportPlan,
  SqliteStorageClass,
} from "@lambdata/shared";
import { NameAllocator, foldIdentifier, isPortableIdentifier, quoteMariaIdent } from "./identifiers";
import {
  TWO_POW_53,
  absBig,
  decimalShape,
  doubleLiteral,
  integerDigits,
  plainDecimal,
  realAsText,
  sqlString,
} from "./literals";
import { columnCollations, isWithoutRowid, sqliteColumnKey } from "./sqliteSchema";
import { openSqliteReadOnly, quoteSqliteIdent, yieldToEventLoop } from "./sqliteFile";

export const BLUEPRINT_VERSION = 3;
export const KEY_BUDGET_BYTES = 3072;
export const BINARY_COLLATION = "utf8mb4_nopad_bin";
export const PAD_BINARY_COLLATION = "utf8mb4_bin";
const MAX_VARCHAR_CHARS = 16383;
const ROW_SIZE_LIMIT = 65000;
const IN_PAGE_LIMIT = 8000;
const YIELD_EVERY_ROWS = 2000;
const MAX_SCAN_COLUMNS = 400;

export type Family = "integer" | "boolean" | "double" | "decimal" | "date" | "datetime" | "text" | "binary";

export interface ColumnBlueprint {
  sourceName: string;
  targetName: string;
  family: Family;
  rowidAlias: boolean;
  generated: boolean;
}

export interface TableBlueprint {
  sourceName: string;
  targetName: string;
  rowCount: number;
  columns: ColumnBlueprint[];
  selectSql: string;
  createSql: string;
  indexClauses: { name: string; clause: string }[];
  foreignKeyClauses: { clause: string; label: string }[];
}

export interface SqliteBlueprint {
  version: number;
  encoding: string;
  nocaseCollation: string;
  plan: SqliteImportPlan;
  tables: TableBlueprint[];
}

export interface PlanOptions {
  nocaseCollation: string;
}

interface ColumnStats {
  counts: Record<SqliteStorageClass, number>;
  intMin: bigint | null;
  intMax: bigint | null;
  intOver53: number;
  intMaxDigits: number;
  realNonFinite: number;
  realMaxIntDigits: number;
  realMaxFracDigits: number;
  textMaxChars: number;
  textMaxBytes: number;
  textInvalid: number;
  blobMaxBytes: number;
  numberTextMaxLen: number;
  dateOnly: number;
  dateTime: number;
  fracLengths: Set<number>;
}

interface XInfo {
  cid: number;
  name: string;
  type: string;
  notnull: boolean;
  dflt: string | null;
  pk: number;
  hidden: number;
}

interface Declared {
  raw: string | null;
  upper: string;
  affinity: "INTEGER" | "TEXT" | "BLOB" | "REAL" | "NUMERIC";
  length: number | null;
  decimal: { p: number; s: number } | null;
  bool: boolean;
  dateLike: boolean;
  dateOnlyDeclared: boolean;
}

interface WorkColumn {
  x: XInfo;
  declared: Declared;
  stats: ColumnStats;
  collation: string | null;
  sourceCollation: string;
  targetName: string;
  family: Family;
  fixedType: string | null;
  textCollation: string | null;
  needLength: number;
  declaredLength: number | null;
  unboundedType: string;
  finalLength: number | null;
  lossy: boolean;
  rowidAlias: boolean;
  generated: boolean;
  nullable: boolean;
  notes: string[];
  keyed: boolean;
}

interface WorkKey {
  kind: "primary" | "unique" | "index";
  name: string;
  sourceName: string;
  columns: number[];
  skippedReason: string | null;
  implicitFor: WorkForeignKey | null;
}

interface WorkForeignKey {
  childColumns: number[];
  parent: WorkTable | null;
  parentSourceName: string;
  parentColumns: number[];
  parentColumnNames: string[];
  onDelete: string;
  onUpdate: string;
  violations: number;
  skippedReason: string | null;
  implicitKey: WorkKey | null;
}

interface WorkTable {
  sourceName: string;
  targetName: string;
  renameReason: string | null;
  createSqlSource: string | null;
  withoutRowid: boolean;
  rowCount: number;
  columns: WorkColumn[];
  keys: WorkKey[];
  foreignKeys: WorkForeignKey[];
  rawForeignKeys: RawForeignKey[];
  warnings: string[];
  autoIncrementNext: bigint | null;
  selectSql: string;
  createSql: string;
}

interface RawForeignKey {
  id: number;
  table: string;
  from: string[];
  to: (string | null)[];
  onUpdate: string;
  onDelete: string;
}

export class PlanError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PlanError";
  }
}

function num(v: unknown): number {
  return typeof v === "bigint" ? Number(v) : Number(v ?? 0);
}

function str(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (v instanceof Uint8Array) return new TextDecoder().decode(v);
  return String(v);
}

function emptyStats(): ColumnStats {
  return {
    counts: { integer: 0, real: 0, text: 0, blob: 0, null: 0 },
    intMin: null,
    intMax: null,
    intOver53: 0,
    intMaxDigits: 0,
    realNonFinite: 0,
    realMaxIntDigits: 0,
    realMaxFracDigits: 0,
    textMaxChars: 0,
    textMaxBytes: 0,
    textInvalid: 0,
    blobMaxBytes: 0,
    numberTextMaxLen: 0,
    dateOnly: 0,
    dateTime: 0,
    fracLengths: new Set(),
  };
}

function parseDeclared(raw: string | null): Declared {
  const text = (raw ?? "").trim();
  const upper = text.toUpperCase();
  let affinity: Declared["affinity"];
  if (upper.includes("INT")) affinity = "INTEGER";
  else if (upper.includes("CHAR") || upper.includes("CLOB") || upper.includes("TEXT")) affinity = "TEXT";
  else if (upper.includes("BLOB") || upper === "") affinity = "BLOB";
  else if (upper.includes("REAL") || upper.includes("FLOA") || upper.includes("DOUB")) affinity = "REAL";
  else affinity = "NUMERIC";
  const lenMatch = /\(\s*(\d+)\s*(?:,\s*(\d+)\s*)?\)/.exec(upper);
  const decMatch = /^\s*(?:DECIMAL|NUMERIC|DEC)\s*\(\s*(\d+)\s*(?:,\s*(\d+)\s*)?\)/.exec(upper);
  let decimal: Declared["decimal"] = null;
  if (decMatch) {
    const p = Number(decMatch[1]);
    const s = Number(decMatch[2] ?? 0);
    if (p >= 1 && p <= 65 && s <= 38 && s <= p) decimal = { p, s };
  }
  return {
    raw: text === "" ? null : text,
    upper,
    affinity,
    length: affinity === "TEXT" && lenMatch ? Number(lenMatch[1]) : null,
    decimal,
    bool: /BOOL/.test(upper),
    dateLike: /DATE|TIME/.test(upper) && affinity !== "TEXT" && affinity !== "BLOB",
    dateOnlyDeclared: /^DATE$/.test(upper),
  };
}

function daysInMonth(y: number, m: number): number {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return [4, 6, 9, 11].includes(m) ? 30 : 31;
}

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DATETIME_RE = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?$/;

export function classifyDateText(s: string): { kind: "date" } | { kind: "datetime"; frac: number } | null {
  const d = DATE_RE.exec(s);
  const dt = d ? null : DATETIME_RE.exec(s);
  const m = d ?? dt;
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const day = Number(m[3]);
  if (y < 1000 || y > 9999 || mo < 1 || mo > 12 || day < 1 || day > daysInMonth(y, mo)) return null;
  if (d) return { kind: "date" };
  if (Number(m[4]) > 23 || Number(m[5]) > 59 || Number(m[6]) > 59) return null;
  return { kind: "datetime", frac: m[7]?.length ?? 0 };
}

function codePointLength(s: string): number {
  let surrogates = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) surrogates++;
  }
  return s.length - surrogates;
}

export function textDecoderFor(encoding: string): TextDecoder {
  const label = encoding.toUpperCase() === "UTF-16LE" ? "utf-16le" : encoding.toUpperCase() === "UTF-16BE" ? "utf-16be" : "utf-8";
  return new TextDecoder(label, { fatal: true, ignoreBOM: true });
}

function observe(
  st: ColumnStats,
  type: string,
  value: unknown,
  decoder: TextDecoder,
  utf8: boolean,
  wantDates: boolean,
): void {
  switch (type) {
    case "null":
      st.counts.null++;
      return;
    case "integer": {
      const v = typeof value === "bigint" ? value : BigInt(value as number);
      st.counts.integer++;
      if (st.intMin === null || v < st.intMin) st.intMin = v;
      if (st.intMax === null || v > st.intMax) st.intMax = v;
      if (absBig(v) > TWO_POW_53) st.intOver53++;
      const digits = integerDigits(v);
      if (digits > st.intMaxDigits) st.intMaxDigits = digits;
      const len = v.toString().length;
      if (len > st.numberTextMaxLen) st.numberTextMaxLen = len;
      return;
    }
    case "real": {
      const x = Number(value);
      st.counts.real++;
      if (!Number.isFinite(x)) st.realNonFinite++;
      else {
        const shape = decimalShape(x);
        if (shape.intDigits > st.realMaxIntDigits) st.realMaxIntDigits = shape.intDigits;
        if (shape.fracDigits > st.realMaxFracDigits) st.realMaxFracDigits = shape.fracDigits;
      }
      const len = realAsText(x).length;
      if (len > st.numberTextMaxLen) st.numberTextMaxLen = len;
      return;
    }
    case "text": {
      const bytes = value as Uint8Array;
      st.counts.text++;
      let decoded: string | null = null;
      try {
        decoded = decoder.decode(bytes);
      } catch {
        st.textInvalid++;
      }
      if (decoded === null) {
        if (bytes.byteLength > st.textMaxBytes) st.textMaxBytes = bytes.byteLength;
        if (bytes.byteLength > st.textMaxChars) st.textMaxChars = bytes.byteLength;
        return;
      }
      const utf8Bytes = utf8 ? bytes.byteLength : Buffer.byteLength(decoded, "utf8");
      if (utf8Bytes > st.textMaxBytes) st.textMaxBytes = utf8Bytes;
      const chars = utf8Bytes === decoded.length ? decoded.length : codePointLength(decoded);
      if (chars > st.textMaxChars) st.textMaxChars = chars;
      if (wantDates) {
        const c = classifyDateText(decoded);
        if (c?.kind === "date") st.dateOnly++;
        else if (c?.kind === "datetime") {
          st.dateTime++;
          st.fracLengths.add(c.frac);
        }
      }
      return;
    }
    case "blob": {
      const bytes = value as Uint8Array;
      st.counts.blob++;
      if (bytes.byteLength > st.blobMaxBytes) st.blobMaxBytes = bytes.byteLength;
      return;
    }
  }
}

export function readValueExpr(name: string): string {
  const q = quoteSqliteIdent(name);
  return `CASE WHEN typeof(${q}) = 'text' THEN CAST(${q} AS BLOB) ELSE ${q} END`;
}

async function scanTable(
  db: Database,
  table: string,
  columns: WorkColumn[],
  decoder: TextDecoder,
  utf8: boolean,
): Promise<void> {
  for (let start = 0; start < columns.length; start += MAX_SCAN_COLUMNS) {
    const group = columns.slice(start, start + MAX_SCAN_COLUMNS);
    const exprs = group.flatMap((c, i) => [`typeof(${quoteSqliteIdent(c.x.name)}) AS t${i}`, `${readValueExpr(c.x.name)} AS v${i}`]);
    const stmt = db.query(`SELECT ${exprs.join(", ")} FROM ${quoteSqliteIdent(table)}`);
    let n = 0;
    try {
      for (const row of stmt.iterate() as IterableIterator<Record<string, unknown>>) {
        for (let i = 0; i < group.length; i++) {
          const c = group[i]!;
          observe(c.stats, String(row[`t${i}`]), row[`v${i}`], decoder, utf8, c.declared.dateLike);
        }
        if (++n % YIELD_EVERY_ROWS === 0) await yieldToEventLoop();
      }
    } finally {
      stmt.finalize();
    }
  }
}

function classesPresent(st: ColumnStats): ("integer" | "real" | "text" | "blob")[] {
  return (["integer", "real", "text", "blob"] as const).filter((k) => st.counts[k] > 0);
}

function unboundedTextType(bytes: number): string {
  if (bytes * 4 <= 65535) return "TEXT";
  if (bytes * 4 <= 16777215) return "MEDIUMTEXT";
  return "LONGTEXT";
}

function decideColumn(c: WorkColumn, nocaseCollation: string, tableWarnings: string[]): void {
  const st = c.stats;
  const d = c.declared;
  const present = classesPresent(st);
  const has = (k: "integer" | "real" | "text" | "blob") => st.counts[k] > 0;
  const declaredLabel = d.raw ? `Declared ${d.raw}` : "No declared type";
  const setText = () => {
    c.family = "text";
    const coll = c.collation;
    if (coll === "NOCASE") {
      c.textCollation = nocaseCollation;
      c.notes.push(
        `Declared COLLATE NOCASE: uses the case-insensitive ${nocaseCollation} (SQLite folds only ASCII letters; MariaDB also folds accented and non-Latin letters).`,
      );
    } else if (coll === "RTRIM") {
      c.textCollation = PAD_BINARY_COLLATION;
      c.notes.push(`Declared COLLATE RTRIM: ${PAD_BINARY_COLLATION} also ignores trailing spaces when comparing.`);
    } else {
      c.textCollation = BINARY_COLLATION;
      if (coll && coll !== "BINARY") {
        c.notes.push(`Declared COLLATE ${coll}, which MariaDB does not have; compared byte by byte (${BINARY_COLLATION}).`);
      }
    }
    const numbers = has("integer") || has("real");
    c.needLength = Math.max(st.textMaxChars, numbers ? st.numberTextMaxLen : 0);
    const needBytes = Math.max(st.textMaxBytes, numbers ? st.numberTextMaxLen : 0);
    c.unboundedType = unboundedTextType(needBytes);
    if (d.length !== null) {
      if (d.length >= c.needLength && d.length <= MAX_VARCHAR_CHARS) c.declaredLength = d.length;
      else if (d.length < c.needLength) {
        c.notes.push(
          `${declaredLabel}, but holds values up to ${c.needLength} characters (SQLite does not enforce lengths); stored as ${c.unboundedType}.`,
        );
      }
    }
    c.lossy = numbers || c.textCollation === nocaseCollation;
  };
  const setBinary = () => {
    c.family = "binary";
    c.needLength = Math.max(st.blobMaxBytes, st.textMaxBytes, st.numberTextMaxLen);
    c.unboundedType = "LONGBLOB";
    c.lossy = present.length > 1;
  };

  if (c.rowidAlias) {
    c.family = "integer";
    c.fixedType = "BIGINT";
    return;
  }
  if (c.generated) c.notes.push("Generated column in SQLite: imported as a plain column holding its current values (the expression is not translated).");

  if (present.length === 0) {
    if (d.affinity === "INTEGER") {
      if (d.bool) {
        c.family = "boolean";
        c.fixedType = "TINYINT(1)";
      } else {
        c.family = "integer";
        c.fixedType = "BIGINT";
      }
    } else if (d.decimal) {
      c.family = "decimal";
      c.fixedType = `DECIMAL(${d.decimal.p},${d.decimal.s})`;
    } else if (d.dateLike) {
      c.family = d.dateOnlyDeclared ? "date" : "datetime";
      c.fixedType = d.dateOnlyDeclared ? "DATE" : "DATETIME";
    } else if (d.affinity === "REAL" || d.affinity === "NUMERIC") {
      c.family = d.bool ? "boolean" : "double";
      c.fixedType = d.bool ? "TINYINT(1)" : "DOUBLE";
    } else if (d.affinity === "BLOB" && d.raw !== null) {
      setBinary();
    } else {
      setText();
      if (d.raw === null) c.unboundedType = "LONGTEXT";
    }
    c.notes.push(`${st.counts.null > 0 ? "Every value is NULL" : "The table is empty"}, so the type follows the declaration${d.raw ? "" : " (none: stored as text)"}.`);
    return;
  }

  if (has("blob") || st.textInvalid > 0) {
    setBinary();
    if (st.textInvalid > 0) {
      const msg = `Column ${c.targetName}: ${st.textInvalid} text value(s) are not valid ${c.sourceCollation === "UTF-8" ? "UTF-8" : "text"}; the column is stored as binary (${c.unboundedType}) so the bytes survive unchanged.`;
      tableWarnings.push(msg);
      c.notes.push(`${st.textInvalid} text value(s) are not valid UTF-8; stored as binary so the bytes survive unchanged.`);
    }
    if (has("blob") && present.length > 1) {
      c.notes.push(
        `Holds ${present.join(", ")} values; stored as binary. Text keeps its bytes, numbers become their decimal text.`,
      );
    }
    return;
  }

  if (has("text") && !has("integer") && !has("real")) {
    if (d.dateLike) {
      if (st.dateOnly === st.counts.text) {
        c.family = "date";
        c.fixedType = "DATE";
        c.notes.push(`${declaredLabel} and every value is a YYYY-MM-DD date: stored as DATE.`);
        return;
      }
      if (st.dateTime === st.counts.text && st.fracLengths.size === 1) {
        const f = [...st.fracLengths][0]!;
        c.family = "datetime";
        c.fixedType = f === 0 ? "DATETIME" : `DATETIME(${f})`;
        c.notes.push(`${declaredLabel} and every value is 'YYYY-MM-DD HH:MM:SS${f ? "." + "f".repeat(f) : ""}': stored as ${c.fixedType}.`);
        return;
      }
      setText();
      c.notes.push(
        `${declaredLabel}, but not every value is written exactly as YYYY-MM-DD or YYYY-MM-DD HH:MM:SS; kept as text so each value stays exactly as stored.`,
      );
      return;
    }
    setText();
    if (d.affinity === "INTEGER" || d.affinity === "REAL" || d.affinity === "NUMERIC") {
      c.notes.push(`${declaredLabel}, but every value is text; kept as text.`);
    } else if (d.raw === null) {
      c.notes.push("No declared type; every value is text.");
    }
    return;
  }

  if (!has("text")) {
    if (d.decimal && !has("blob")) {
      const intRoom = d.decimal.p - d.decimal.s;
      const fits =
        st.realNonFinite === 0 &&
        st.intMaxDigits <= intRoom &&
        st.realMaxIntDigits <= intRoom &&
        st.realMaxFracDigits <= d.decimal.s;
      if (fits) {
        c.family = "decimal";
        c.fixedType = `DECIMAL(${d.decimal.p},${d.decimal.s})`;
        if (has("real")) c.notes.push(`${declaredLabel} and every value fits it exactly: stored as ${c.fixedType}.`);
        return;
      }
      c.notes.push(`${declaredLabel}, but some values do not fit DECIMAL(${d.decimal.p},${d.decimal.s}) exactly; the type follows the values.`);
    }
    if (has("integer") && !has("real")) {
      if (d.bool && st.intMin !== null && st.intMin >= 0n && st.intMax !== null && st.intMax <= 1n) {
        c.family = "boolean";
        c.fixedType = "TINYINT(1)";
        c.notes.push(`${declaredLabel} and holds only 0 and 1: TINYINT(1).`);
        return;
      }
      c.family = "integer";
      c.fixedType = "BIGINT";
      if (d.bool) c.notes.push(`${declaredLabel}, but holds values other than 0 and 1; stored as BIGINT.`);
      if (d.dateLike) c.notes.push(`${declaredLabel}, but holds integers (probably Unix timestamps); kept as BIGINT.`);
      if (d.affinity !== "INTEGER" && !d.bool && !d.dateLike) c.notes.push(`${declaredLabel}; every value is an integer: BIGINT.`);
      if (st.intOver53 > 0) {
        c.notes.push(
          `${st.intOver53} value(s) are larger than 2^53 (SteamID64-sized, up to ${st.intMax}); BIGINT keeps every digit and they are copied as exact 64-bit integers.`,
        );
      }
      return;
    }
    if (st.realNonFinite > 0) {
      setText();
      c.notes.push(`Holds ${st.realNonFinite} infinite value(s), which DOUBLE cannot store; stored as text ("Inf", "-Inf", other numbers as exact decimal text).`);
      return;
    }
    if (has("real") && !has("integer")) {
      c.family = "double";
      c.fixedType = "DOUBLE";
      if (d.affinity !== "REAL") c.notes.push(`${declaredLabel}; every value is a floating-point number: DOUBLE.`);
      if (d.dateLike) c.notes.push(`${declaredLabel}, but holds numbers (probably Julian days or timestamps); kept as DOUBLE.`);
      return;
    }
    if (st.intOver53 === 0) {
      c.family = "double";
      c.fixedType = "DOUBLE";
      c.notes.push("Mixes integers and floating-point numbers; stored as DOUBLE (every integer here is below 2^53, so all stay exact).");
      return;
    }
    setText();
    c.notes.push(
      "Mixes floating-point numbers with integers larger than 2^53; no MariaDB numeric type holds both exactly, so the column is text and each number is its exact decimal text.",
    );
    return;
  }

  setText();
  c.notes.push(`Holds ${present.join(" and ")} values; stored as text so every value survives (numbers become their exact decimal text).`);
}

function fixedKeyBytes(c: WorkColumn): number {
  switch (c.family) {
    case "integer":
    case "double":
      return 8;
    case "boolean":
      return 1;
    case "date":
      return 3;
    case "datetime": {
      const f = /\((\d)\)/.exec(c.fixedType ?? "")?.[1];
      return 5 + Math.ceil(Number(f ?? 0) / 2);
    }
    case "decimal": {
      const m = /\((\d+),(\d+)\)/.exec(c.fixedType ?? "");
      const p = Number(m?.[1] ?? 10);
      return Math.ceil(p / 2) + 1;
    }
    default:
      return 0;
  }
}

function isSized(c: WorkColumn): boolean {
  return c.family === "text" || c.family === "binary";
}

function unitBytes(c: WorkColumn): number {
  return c.family === "text" ? 4 : 1;
}

function headroom(need: number, cap: number): number {
  return Math.min(cap, Math.max(32, Math.ceil((need * 2) / 32) * 32));
}

function sizeKeys(t: WorkTable): void {
  const want = new Map<number, number>();
  for (const key of t.keys) {
    if (key.skippedReason) continue;
    for (const i of key.columns) {
      const c = t.columns[i]!;
      if (!isSized(c) || want.has(i)) continue;
      const cap = Math.floor(KEY_BUDGET_BYTES / unitBytes(c));
      const need = Math.max(1, c.needLength);
      const declared = c.declaredLength !== null && c.declaredLength >= need && c.declaredLength <= cap ? c.declaredLength : null;
      want.set(i, declared ?? headroom(need, cap));
    }
  }
  const len = new Map(want);
  for (const key of t.keys) {
    if (key.skippedReason) continue;
    const fixed = key.columns.reduce((s, i) => s + fixedKeyBytes(t.columns[i]!), 0);
    const sized = key.columns.filter((i) => isSized(t.columns[i]!));
    const needBytes = sized.reduce((s, i) => s + unitBytes(t.columns[i]!) * Math.max(1, t.columns[i]!.needLength), 0);
    if (fixed + needBytes > KEY_BUDGET_BYTES) {
      const detail = sized
        .map((i) => {
          const c = t.columns[i]!;
          return `${c.targetName} holds values up to ${c.needLength} ${c.family === "text" ? "characters" : "bytes"}`;
        })
        .join(", ");
      key.skippedReason = `Too long for a MariaDB index: ${detail}, which needs ${fixed + needBytes} bytes; InnoDB keys are limited to ${KEY_BUDGET_BYTES} bytes (utf8mb4 text counts 4 bytes per character).`;
      continue;
    }
    const current = () => fixed + sized.reduce((s, i) => s + unitBytes(t.columns[i]!) * len.get(i)!, 0);
    if (current() <= KEY_BUDGET_BYTES) continue;
    let lo = 0;
    let hi = 1;
    const lengthsAt = (f: number) =>
      sized.map((i) => {
        const need = Math.max(1, t.columns[i]!.needLength);
        const top = len.get(i)!;
        return need + Math.floor((top - need) * f);
      });
    for (let step = 0; step < 30; step++) {
      const mid = (lo + hi) / 2;
      const total = fixed + lengthsAt(mid).reduce((s, l, k) => s + unitBytes(t.columns[sized[k]!]!) * l, 0);
      if (total <= KEY_BUDGET_BYTES) lo = mid;
      else hi = mid;
    }
    const chosen = lengthsAt(lo);
    sized.forEach((i, k) => len.set(i, Math.min(len.get(i)!, chosen[k]!)));
  }
  for (const c of t.columns) c.keyed = false;
  for (const key of t.keys) {
    if (key.skippedReason) continue;
    for (const i of key.columns) t.columns[i]!.keyed = true;
  }
  t.columns.forEach((c, i) => {
    if (c.keyed && isSized(c)) {
      c.finalLength = len.get(i)!;
      const kind = c.family === "text" ? "VARCHAR" : "VARBINARY";
      const unit = c.family === "text" ? (c.needLength === 1 ? "character" : "characters") : c.needLength === 1 ? "byte" : "bytes";
      c.notes.push(
        `Part of a key, so it cannot be unbounded ${c.family === "text" ? "TEXT" : "BLOB"}: ${kind}(${c.finalLength}), sized from the longest value (${c.needLength} ${unit}) with room to grow and within InnoDB's ${KEY_BUDGET_BYTES}-byte key limit.`,
      );
      if (c.family === "text" && c.textCollation === BINARY_COLLATION) {
        c.notes.push(
          `Compared byte by byte (${BINARY_COLLATION}), as SQLite does: keys such as 'abc' and 'ABC', or 'a' and 'a ', stay different. MariaDB's usual collations would treat them as duplicates.`,
        );
      }
    } else if (isSized(c) && c.family === "text" && c.declaredLength !== null) {
      c.finalLength = c.declaredLength;
    }
  });
}

function columnRowBytes(c: WorkColumn): { row: number; inPage: number } {
  if (isSized(c) && c.finalLength !== null) {
    const max = c.finalLength * unitBytes(c);
    return { row: max + 2, inPage: max <= 255 ? max + 1 : 20 };
  }
  if (isSized(c)) return { row: 12, inPage: 20 };
  const f = fixedKeyBytes(c);
  return { row: f, inPage: f };
}

function guardRowSize(t: WorkTable): void {
  const total = () => t.columns.reduce((s, c) => s + columnRowBytes(c).row, 0);
  const inPage = () => t.columns.reduce((s, c) => s + columnRowBytes(c).inPage, 0);
  const candidates = () =>
    t.columns
      .filter((c) => !c.keyed && c.family === "text" && c.finalLength !== null)
      .sort((a, b) => (b.finalLength ?? 0) - (a.finalLength ?? 0));
  for (const c of candidates()) {
    if (total() <= ROW_SIZE_LIMIT && inPage() <= IN_PAGE_LIMIT) break;
    c.notes.push(`${c.declared.raw ? `Declared ${c.declared.raw}` : "Declared with a length"}, but the table's declared lengths add up to more than a MariaDB row can hold; stored as ${c.unboundedType}.`);
    c.finalLength = null;
  }
}

function columnType(c: WorkColumn): string {
  if (c.fixedType) return c.fixedType;
  if (c.family === "text") {
    const base = c.finalLength !== null ? `VARCHAR(${c.finalLength})` : c.unboundedType;
    return `${base} COLLATE ${c.textCollation ?? BINARY_COLLATION}`;
  }
  return c.finalLength !== null ? `VARBINARY(${c.finalLength})` : c.unboundedType;
}

type ParsedDefault =
  | { kind: "null" }
  | { kind: "int"; value: bigint }
  | { kind: "real"; value: number }
  | { kind: "text"; value: string }
  | { kind: "blob"; hex: string }
  | { kind: "current"; which: "timestamp" | "date" | "time" }
  | { kind: "expr"; text: string };

function parseDefault(raw: string): ParsedDefault {
  let s = raw.trim();
  for (let i = 0; i < 8 && s.startsWith("(") && s.endsWith(")"); i++) {
    const inner = s.slice(1, -1).trim();
    let depth = 0;
    let balanced = true;
    for (const ch of inner) {
      if (ch === "(") depth++;
      if (ch === ")" && --depth < 0) balanced = false;
    }
    if (!balanced || depth !== 0) break;
    s = inner;
  }
  if (/^[+-]?\d+$/.test(s)) {
    const v = BigInt(s);
    if (v >= -(2n ** 63n) && v < 2n ** 63n) return { kind: "int", value: v };
    return { kind: "real", value: Number(s) };
  }
  if (/^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(s)) return { kind: "real", value: Number(s) };
  let m = /^'((?:[^']|'')*)'$/s.exec(s);
  if (m) return { kind: "text", value: m[1]!.replaceAll("''", "'") };
  m = /^"((?:[^"]|"")*)"$/s.exec(s);
  if (m) return { kind: "text", value: m[1]!.replaceAll('""', '"') };
  m = /^x'([0-9a-f]*)'$/i.exec(s);
  if (m && m[1]!.length % 2 === 0) return { kind: "blob", hex: m[1]!.toLowerCase() };
  const upper = s.toUpperCase();
  if (upper === "NULL") return { kind: "null" };
  if (upper === "TRUE") return { kind: "int", value: 1n };
  if (upper === "FALSE") return { kind: "int", value: 0n };
  if (upper === "CURRENT_TIMESTAMP") return { kind: "current", which: "timestamp" };
  if (upper === "CURRENT_DATE") return { kind: "current", which: "date" };
  if (upper === "CURRENT_TIME") return { kind: "current", which: "time" };
  return { kind: "expr", text: s };
}

function numericText(p: ParsedDefault): string | null {
  if (p.kind === "int") return p.value.toString();
  if (p.kind === "real") return Number.isFinite(p.value) ? realAsText(p.value) : null;
  return null;
}

function translateDefault(c: WorkColumn): string | null {
  const raw = c.x.dflt;
  if (raw === null || c.rowidAlias) return null;
  const p = parseDefault(raw);
  const drop = (why: string) => {
    c.notes.push(`Default ${raw} ${why}; dropped.`);
    return null;
  };
  if (p.kind === "expr") return drop("is an SQLite expression that does not translate mechanically");
  if (p.kind === "null") return c.nullable ? "NULL" : null;
  const intLike = (): bigint | null => {
    if (p.kind === "int") return p.value;
    if (p.kind === "real" && Number.isInteger(p.value) && Math.abs(p.value) <= Number.MAX_SAFE_INTEGER) return BigInt(p.value);
    if (p.kind === "text" && /^\s*[+-]?\d+\s*$/.test(p.value)) {
      const v = BigInt(p.value.trim());
      return v >= -(2n ** 63n) && v < 2n ** 63n ? v : null;
    }
    return null;
  };
  const realLike = (): number | null => {
    if (p.kind === "int") return Number(p.value);
    if (p.kind === "real") return Number.isFinite(p.value) ? p.value : null;
    if (p.kind === "text" && /^\s*[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?\s*$/i.test(p.value)) return Number(p.value);
    return null;
  };
  switch (c.family) {
    case "integer": {
      const v = intLike();
      return v === null ? drop("is not an integer") : v.toString();
    }
    case "boolean": {
      const v = intLike();
      return v === 0n || v === 1n ? v.toString() : drop("is not 0 or 1");
    }
    case "double": {
      const v = realLike();
      return v === null ? drop("is not a number") : doubleLiteral(v);
    }
    case "decimal": {
      const v = realLike();
      if (v === null) return drop("is not a number");
      const m = /\((\d+),(\d+)\)/.exec(c.fixedType ?? "");
      const shape = decimalShape(v);
      if (m && shape.intDigits <= Number(m[1]) - Number(m[2]) && shape.fracDigits <= Number(m[2])) return plainDecimal(v);
      return drop(`does not fit ${c.fixedType}`);
    }
    case "date": {
      if (p.kind === "current" && p.which === "date") {
        c.notes.push("Default CURRENT_DATE became (UTC_DATE()), because SQLite's CURRENT_DATE is in UTC.");
        return "(UTC_DATE())";
      }
      if (p.kind === "text" && classifyDateText(p.value)?.kind === "date") return sqlString(p.value);
      return drop("is not a YYYY-MM-DD date");
    }
    case "datetime": {
      if (p.kind === "current" && p.which === "timestamp") {
        c.notes.push("Default CURRENT_TIMESTAMP became (UTC_TIMESTAMP()), because SQLite's CURRENT_TIMESTAMP is in UTC.");
        return "(UTC_TIMESTAMP())";
      }
      const frac = Number(/\((\d)\)/.exec(c.fixedType ?? "")?.[1] ?? 0);
      if (p.kind === "text") {
        const k = classifyDateText(p.value);
        if (k?.kind === "datetime" && k.frac === frac) return sqlString(p.value);
      }
      return drop(`is not a value ${c.fixedType} prints back identically`);
    }
    case "text": {
      if (p.kind === "current") {
        const fn = p.which === "timestamp" ? "UTC_TIMESTAMP()" : p.which === "date" ? "UTC_DATE()" : "UTC_TIME()";
        c.notes.push(`Default CURRENT_${p.which.toUpperCase()} became (${fn}), which stores the same UTC text SQLite would.`);
        return `(${fn})`;
      }
      if (p.kind === "blob") return drop("is a blob literal on a text column");
      const text = p.kind === "text" ? p.value : numericText(p);
      if (text === null) return drop("cannot be represented");
      if (c.finalLength !== null && codePointLength(text) > c.finalLength) return drop(`is longer than ${columnType(c)}`);
      return sqlString(text);
    }
    case "binary": {
      if (p.kind === "blob") return `X'${p.hex}'`;
      if (p.kind === "current") return drop("is a time function on a binary column");
      const text = p.kind === "text" ? p.value : numericText(p);
      if (text === null) return drop("cannot be represented");
      const hex = Buffer.from(text, "utf8").toString("hex");
      if (c.finalLength !== null && hex.length / 2 > c.finalLength) return drop(`is longer than ${columnType(c)}`);
      return `X'${hex}'`;
    }
  }
}

function defaultLength(c: WorkColumn): number {
  if (c.x.dflt === null) return 0;
  const p = parseDefault(c.x.dflt);
  if (p.kind === "text") return c.family === "binary" ? Buffer.byteLength(p.value) : codePointLength(p.value);
  if (p.kind === "blob") return p.hex.length / 2;
  if (p.kind === "current") return 19;
  return numericText(p)?.length ?? 0;
}

function foldForCollation(s: string): string {
  return s
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .replace(/[\p{Cc}\p{Cf}]/gu, "")
    .toUpperCase()
    .toLowerCase();
}

async function keyCollides(
  db: Database,
  t: WorkTable,
  key: WorkKey,
  decoder: TextDecoder,
  fold: (c: WorkColumn) => boolean,
): Promise<boolean> {
  const cols = key.columns.map((i) => t.columns[i]!);
  const sql = `SELECT ${cols.map((c, i) => `${readValueExpr(c.x.name)} AS v${i}`).join(", ")} FROM ${quoteSqliteIdent(t.sourceName)}`;
  const stmt = db.query(sql);
  const seen = new Set<string>();
  let n = 0;
  try {
    for (const row of stmt.iterate() as IterableIterator<Record<string, unknown>>) {
      const parts: string[] = [];
      let hasNull = false;
      for (let i = 0; i < cols.length; i++) {
        const c = cols[i]!;
        const v = row[`v${i}`];
        if (v === null || v === undefined) {
          hasNull = true;
          break;
        }
        let rendered: string;
        if (v instanceof Uint8Array) {
          if (c.family === "binary") rendered = Buffer.from(v).toString("hex");
          else {
            let s: string;
            try {
              s = decoder.decode(v);
            } catch {
              s = Buffer.from(v).toString("hex");
            }
            rendered = fold(c) ? foldForCollation(s) : s;
          }
        } else if (typeof v === "bigint") {
          rendered = c.family === "binary" ? Buffer.from(v.toString()).toString("hex") : v.toString();
        } else {
          const text = realAsText(Number(v));
          rendered = c.family === "binary" ? Buffer.from(text).toString("hex") : text;
        }
        parts.push(`${rendered.length}:${rendered}`);
      }
      if (!hasNull) {
        const k = parts.join("|");
        if (seen.has(k)) return true;
        seen.add(k);
      }
      if (++n % YIELD_EVERY_ROWS === 0) await yieldToEventLoop();
    }
  } finally {
    stmt.finalize();
  }
  return false;
}

async function checkLossyKeys(db: Database, t: WorkTable, decoder: TextDecoder, nocaseCollation: string): Promise<void> {
  for (const key of t.keys) {
    if (key.skippedReason || key.kind === "index") continue;
    const cols = key.columns.map((i) => t.columns[i]!);
    if (!cols.some((c) => c.lossy)) continue;
    const ci = cols.filter((c) => c.family === "text" && c.textCollation === nocaseCollation);
    if (ci.length > 0 && (await keyCollides(db, t, key, decoder, (c) => ci.includes(c)))) {
      for (const c of ci) {
        c.textCollation = BINARY_COLLATION;
        c.lossy = c.stats.counts.integer + c.stats.counts.real > 0;
        c.notes.push(
          `Declared COLLATE NOCASE, but some values that SQLite keeps apart would be equal under ${nocaseCollation}; compared byte by byte (${BINARY_COLLATION}) instead so the key keeps every row.`,
        );
      }
      t.warnings.push(
        `Key ${key.name} (${cols.map((c) => c.targetName).join(", ")}): values distinct under SQLite's NOCASE collide under ${nocaseCollation}; ${ci.map((c) => c.targetName).join(", ")} use${ci.length === 1 ? "s" : ""} case-sensitive ${BINARY_COLLATION} instead.`,
      );
    }
    if (!cols.some((c) => c.lossy)) continue;
    if (await keyCollides(db, t, key, decoder, (c) => c.family === "text" && c.textCollation === nocaseCollation)) {
      key.skippedReason =
        "Values that SQLite keeps apart (for example the number 1 and the text '1', or text and a blob with the same bytes) become equal once the column holds a single type in MariaDB, so this key would reject rows.";
    }
  }
}

function keyLabel(t: WorkTable, key: WorkKey): string {
  return key.columns.map((i) => t.columns[i]!.targetName).join(", ");
}

function sameColumns(a: number[], b: number[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

function readXInfo(db: Database, table: string): XInfo[] {
  const rows = db.query(`PRAGMA table_xinfo(${quoteSqliteIdent(table)})`).all() as Record<string, unknown>[];
  return rows.map((r) => ({
    cid: num(r.cid),
    name: str(r.name),
    type: str(r.type),
    notnull: num(r.notnull) === 1,
    dflt: r.dflt_value === null || r.dflt_value === undefined ? null : str(r.dflt_value),
    pk: num(r.pk),
    hidden: num(r.hidden),
  }));
}

function readForeignKeys(db: Database, table: string): RawForeignKey[] {
  let rows: Record<string, unknown>[];
  try {
    rows = db.query(`PRAGMA foreign_key_list(${quoteSqliteIdent(table)})`).all() as Record<string, unknown>[];
  } catch {
    return [];
  }
  const byId = new Map<number, RawForeignKey>();
  for (const r of rows) {
    const id = num(r.id);
    let fk = byId.get(id);
    if (!fk) {
      fk = { id, table: str(r.table), from: [], to: [], onUpdate: str(r.on_update), onDelete: str(r.on_delete) };
      byId.set(id, fk);
    }
    const seq = num(r.seq);
    fk.from[seq] = str(r.from);
    fk.to[seq] = r.to === null || r.to === undefined ? null : str(r.to);
  }
  return [...byId.values()].sort((a, b) => a.id - b.id);
}

function foreignKeyViolations(db: Database, table: string): Map<number, number> {
  const out = new Map<number, number>();
  try {
    const rows = db.query(`PRAGMA foreign_key_check(${quoteSqliteIdent(table)})`).all() as Record<string, unknown>[];
    for (const r of rows) out.set(num(r.fkid), (out.get(num(r.fkid)) ?? 0) + 1);
  } catch {
    out.set(-1, -1);
  }
  return out;
}

function headerIsWal(path: string): boolean {
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.alloc(20);
    readSync(fd, buf, 0, 20, 0);
    return buf[18] === 2 || buf[19] === 2;
  } finally {
    closeSync(fd);
  }
}

interface MasterRow {
  type: string;
  name: string;
  tblName: string;
  sql: string | null;
}

const FTS_SHADOWS = ["_content", "_segments", "_segdir", "_docsize", "_stat", "_data", "_idx", "_config"];
const RTREE_SHADOWS = ["_node", "_rowid", "_parent"];

export async function buildSqliteBlueprint(path: string, upload: ImportUpload, opts: PlanOptions): Promise<SqliteBlueprint> {
  let db: Database;
  try {
    db = openSqliteReadOnly(path);
  } catch (err) {
    throw new PlanError(`SQLite cannot open this file: ${err instanceof Error ? err.message : String(err)}`);
  }
  try {
    return await buildFromDatabase(db, path, upload, opts);
  } catch (err) {
    if (err instanceof PlanError) throw err;
    throw new PlanError(`Could not read the SQLite file: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    db.close();
  }
}

async function buildFromDatabase(db: Database, path: string, upload: ImportUpload, opts: PlanOptions): Promise<SqliteBlueprint> {
  const planWarnings: string[] = [];
  const encoding = str((db.query("PRAGMA encoding").get() as Record<string, unknown>)?.encoding) || "UTF-8";
  const utf8 = encoding.toUpperCase() === "UTF-8";
  const decoder = textDecoderFor(encoding);
  if (!utf8) planWarnings.push(`The file stores text as ${encoding}; text is converted to UTF-8 (utf8mb4) on import.`);
  if (headerIsWal(path)) {
    planWarnings.push(
      "This database was in WAL mode. If it was copied while the game server was running, recent changes may still be in a separate -wal file that was not uploaded.",
    );
  }
  try {
    const check = db.query("PRAGMA quick_check(5)").all() as Record<string, unknown>[];
    const messages = check.map((r) => str(Object.values(r)[0]));
    if (!(messages.length === 1 && messages[0] === "ok")) {
      planWarnings.push(`SQLite reports damage in this file: ${messages.join("; ").slice(0, 500)}. Some rows may fail to import.`);
    }
  } catch (err) {
    planWarnings.push(`SQLite could not check this file for damage: ${err instanceof Error ? err.message : String(err)}`);
  }

  const master = (db.query("SELECT type, name, tbl_name, sql FROM sqlite_master").all() as Record<string, unknown>[]).map(
    (r): MasterRow => ({ type: str(r.type), name: str(r.name), tblName: str(r.tbl_name), sql: r.sql === null ? null : str(r.sql) }),
  );
  const listTypes = new Map<string, { type: string; wr: boolean }>();
  try {
    for (const r of db.query("PRAGMA main.table_list").all() as Record<string, unknown>[]) {
      listTypes.set(str(r.name), { type: str(r.type), wr: num(r.wr) === 1 });
    }
  } catch {}

  const skipped: ImportSkippedObject[] = [];
  const virtualNames = master
    .filter((m) => m.type === "table" && /^\s*CREATE\s+VIRTUAL\s+TABLE/i.test(m.sql ?? ""))
    .map((m) => m.name);
  const isShadow = (name: string): string | null => {
    if (listTypes.get(name)?.type === "shadow") {
      return virtualNames.find((v) => name.startsWith(`${v}_`)) ?? "a virtual table";
    }
    for (const v of virtualNames) {
      const sqlText = master.find((m) => m.name === v)?.sql ?? "";
      const suffixes = /USING\s+rtree/i.test(sqlText) ? RTREE_SHADOWS : FTS_SHADOWS;
      if (suffixes.some((s) => name === `${v}${s}`)) return v;
    }
    return null;
  };

  const sequence = new Map<string, bigint>();
  if (master.some((m) => m.name === "sqlite_sequence")) {
    try {
      for (const r of db.query("SELECT name, seq FROM sqlite_sequence").all() as Record<string, unknown>[]) {
        const seq = r.seq;
        if (typeof seq === "bigint") sequence.set(str(r.name), seq);
      }
    } catch {}
  }

  const tableRows: MasterRow[] = [];
  for (const m of master) {
    if (m.type === "view") {
      skipped.push({ kind: "view", name: m.name, reason: "SQLite view SQL does not translate mechanically; recreate it in MariaDB if you need it.", sql: m.sql });
    } else if (m.type === "trigger") {
      skipped.push({ kind: "trigger", name: m.name, reason: `Trigger on ${m.tblName}: SQLite trigger SQL does not translate mechanically; recreate it in MariaDB if you need it.`, sql: m.sql });
    } else if (m.type === "table") {
      if (m.name.toLowerCase().startsWith("sqlite_")) {
        const reason =
          m.name === "sqlite_sequence"
            ? "SQLite's AUTOINCREMENT bookkeeping; its values set each table's AUTO_INCREMENT."
            : m.name.startsWith("sqlite_stat")
              ? "SQLite query-planner statistics."
              : "SQLite internal table.";
        skipped.push({ kind: "internal", name: m.name, reason, sql: m.sql });
      } else if (virtualNames.includes(m.name)) {
        skipped.push({ kind: "virtual-table", name: m.name, reason: "Virtual table (a SQLite extension such as full-text search); MariaDB has no equivalent module.", sql: m.sql });
      } else {
        const owner = isShadow(m.name);
        if (owner) skipped.push({ kind: "virtual-table", name: m.name, reason: `Storage table of the virtual table ${owner}.`, sql: m.sql });
        else tableRows.push(m);
      }
    }
  }
  tableRows.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  const tableNames = new NameAllocator();
  const work: WorkTable[] = [];
  for (const m of tableRows) {
    const allocated = tableNames.allocate(m.name, "table");
    const xinfo = readXInfo(db, m.name).filter((x) => x.hidden !== 1);
    const listed = listTypes.get(m.name);
    const withoutRowid = listed ? listed.wr : isWithoutRowid(m.sql);
    const collations = columnCollations(m.sql);
    const indexList = (db.query(`PRAGMA index_list(${quoteSqliteIdent(m.name)})`).all() as Record<string, unknown>[]).map((r) => ({
      name: str(r.name),
      unique: num(r.unique) === 1,
      origin: str(r.origin),
      partial: num(r.partial) === 1,
    }));
    const pkCols = xinfo.filter((x) => x.pk > 0).sort((a, b) => a.pk - b.pk);
    const rowidAliasCid = !withoutRowid && pkCols.length === 1 && !indexList.some((i) => i.origin === "pk") ? pkCols[0]!.cid : null;
    const columnNames = new NameAllocator();
    const columns: WorkColumn[] = xinfo.map((x) => {
      const declared = parseDeclared(x.type || null);
      const a = columnNames.allocate(x.name, "column");
      const c: WorkColumn = {
        x,
        declared,
        stats: emptyStats(),
        collation: collations.get(sqliteColumnKey(x.name)) ?? null,
        sourceCollation: encoding,
        targetName: a.targetName,
        family: "text",
        fixedType: null,
        textCollation: null,
        needLength: 0,
        declaredLength: null,
        unboundedType: "TEXT",
        finalLength: null,
        lossy: false,
        rowidAlias: x.cid === rowidAliasCid,
        generated: x.hidden === 2 || x.hidden === 3,
        nullable: true,
        notes: [],
        keyed: false,
      };
      if (a.renamed) c.notes.push(`Renamed from "${x.name}": the name ${a.reason}.`);
      return c;
    });
    if (columns.length === 0) throw new PlanError(`Table ${m.name} has no readable columns`);
    const rowCount = num((db.query(`SELECT count(*) AS n FROM ${quoteSqliteIdent(m.name)}`).get() as Record<string, unknown>).n);
    await scanTable(db, m.name, columns, decoder, utf8);
    const t: WorkTable = {
      sourceName: m.name,
      targetName: allocated.targetName,
      renameReason: allocated.renamed ? allocated.reason : null,
      createSqlSource: m.sql,
      withoutRowid,
      rowCount,
      columns,
      keys: [],
      foreignKeys: [],
      rawForeignKeys: readForeignKeys(db, m.name),
      warnings: [],
      autoIncrementNext: null,
      selectSql: "",
      createSql: "",
    };
    if (t.renameReason) t.warnings.push(`Table renamed from "${m.name}": the name ${t.renameReason}.`);
    for (const c of columns) {
      decideColumn(c, opts.nocaseCollation, t.warnings);
      const dl = defaultLength(c);
      if (isSized(c) && dl > c.needLength) c.needLength = dl;
      c.nullable = c.rowidAlias ? false : !c.x.notnull || c.stats.counts.null > 0;
      if (c.x.notnull && c.stats.counts.null > 0) {
        c.notes.push(`Declared NOT NULL, but ${c.stats.counts.null} value(s) are NULL; the column allows NULL so they survive.`);
      }
    }

    const keyNames = new NameAllocator();
    keyNames.reserve("PRIMARY");
    const colIndex = (cid: number) => columns.findIndex((c) => c.x.cid === cid);
    if (rowidAliasCid !== null) {
      const i = colIndex(rowidAliasCid);
      t.keys.push({ kind: "primary", name: "PRIMARY", sourceName: "PRIMARY KEY", columns: [i], skippedReason: null, implicitFor: null });
      const c = columns[i]!;
      const maxId = c.stats.intMax ?? 0n;
      const seq = sequence.get(m.name) ?? 0n;
      const top = maxId > seq ? maxId : seq;
      const next = top + 1n;
      if (next > 9223372036854775807n) {
        c.notes.push("INTEGER PRIMARY KEY (the SQLite rowid): BIGINT AUTO_INCREMENT. The largest id is already the BIGINT maximum, so no further ids can be generated.");
      } else {
        t.autoIncrementNext = next < 1n ? 1n : next;
        c.notes.push(
          `INTEGER PRIMARY KEY (the SQLite rowid): BIGINT AUTO_INCREMENT, next id ${t.autoIncrementNext}${seq > maxId ? " (from sqlite_sequence, so deleted ids are not reused)" : ""}. Rows are copied with NO_AUTO_VALUE_ON_ZERO so an id of 0 stays 0.`,
        );
      }
    } else if (pkCols.length > 0) {
      const idx = pkCols.map((x) => colIndex(x.cid));
      const nullCols = idx.filter((i) => columns[i]!.stats.counts.null > 0);
      if (nullCols.length > 0) {
        const name = keyNames.allocate(idx.map((i) => columns[i]!.targetName).join("_"), "pk").targetName;
        t.keys.push({ kind: "unique", name, sourceName: "PRIMARY KEY", columns: idx, skippedReason: null, implicitFor: null });
        t.warnings.push(
          `Declared PRIMARY KEY (${idx.map((i) => columns[i]!.targetName).join(", ")}) holds NULLs, which SQLite allows but a MariaDB primary key does not; imported as UNIQUE key ${name} instead.`,
        );
      } else {
        t.keys.push({ kind: "primary", name: "PRIMARY", sourceName: "PRIMARY KEY", columns: idx, skippedReason: null, implicitFor: null });
        for (const i of idx) columns[i]!.nullable = false;
      }
    }

    const ordered = [...indexList].sort((a, b) => {
      const rank = (o: string) => (o === "pk" ? 0 : o === "u" ? 1 : 2);
      return rank(a.origin) - rank(b.origin) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    });
    for (const ix of ordered) {
      if (ix.origin === "pk") continue;
      const info = (db.query(`PRAGMA index_xinfo(${quoteSqliteIdent(ix.name)})`).all() as Record<string, unknown>[])
        .filter((r) => num(r.key) === 1)
        .sort((a, b) => num(a.seqno) - num(b.seqno));
      const kind: WorkKey["kind"] = ix.unique ? "unique" : "index";
      const auto = ix.name.startsWith("sqlite_autoindex_");
      let skippedReason: string | null = null;
      const cols: number[] = [];
      for (const r of info) {
        const cid = num(r.cid);
        if (cid === -2) {
          skippedReason = "Expression index; MariaDB indexes plain columns only, so it is not recreated.";
          break;
        }
        const i = cid === -1 ? columns.findIndex((c) => c.rowidAlias) : colIndex(cid);
        if (i < 0) {
          skippedReason = "Indexes SQLite's hidden rowid, which is not imported.";
          break;
        }
        cols.push(i);
        const coll = str(r.coll).toUpperCase();
        const own = columns[i]!.collation ?? "BINARY";
        if (coll && coll !== own) {
          if (ix.unique) {
            skippedReason = `Uses COLLATE ${coll} on ${columns[i]!.targetName}, which is declared ${own}; MariaDB cannot give one index its own collation, and enforcing it with the column's collation would change which rows count as duplicates.`;
            break;
          }
          t.warnings.push(`Index ${ix.name} uses COLLATE ${coll} on ${columns[i]!.targetName}; recreated with the column's own collation.`);
        }
      }
      if (!skippedReason && ix.partial) {
        if (ix.unique) skippedReason = "Partial unique index (CREATE UNIQUE INDEX ... WHERE); MariaDB has no partial indexes, and a full unique index would reject rows SQLite accepts.";
        else t.warnings.push(`Index ${ix.name} is partial (has a WHERE clause); recreated as a full index.`);
      }
      const baseName = auto ? cols.map((i) => columns[i]!.targetName).join("_") || "key" : ix.name;
      const name = keyNames.allocate(baseName, "key").targetName;
      if (!skippedReason) {
        const dup = t.keys.find((k) => !k.skippedReason && sameColumns(k.columns, cols) && (k.kind !== "index" || kind === "index"));
        if (dup) skippedReason = `Same columns as ${dup.name === "PRIMARY" ? "the primary key" : dup.name}; not created twice.`;
      }
      t.keys.push({ kind, name, sourceName: ix.name, columns: cols, skippedReason, implicitFor: null });
    }
    work.push(t);
    await yieldToEventLoop();
  }

  const bySource = new Map(work.map((t) => [t.sourceName.toLowerCase(), t]));
  for (const t of work) {
    const violations = foreignKeyViolations(db, t.sourceName);
    for (const raw of t.rawForeignKeys) {
      const childCols = raw.from.map((n) => t.columns.findIndex((c) => sqliteColumnKey(c.x.name) === sqliteColumnKey(n)));
      const parent = bySource.get(raw.table.toLowerCase()) ?? null;
      const fk: WorkForeignKey = {
        childColumns: childCols,
        parent,
        parentSourceName: raw.table,
        parentColumns: [],
        parentColumnNames: raw.to.map((v) => v ?? ""),
        onDelete: raw.onDelete.toUpperCase(),
        onUpdate: raw.onUpdate.toUpperCase(),
        violations: violations.get(raw.id) ?? 0,
        skippedReason: null,
        implicitKey: null,
      };
      t.foreignKeys.push(fk);
      if (childCols.some((i) => i < 0)) {
        fk.skippedReason = "Names a column that does not exist in this table.";
        continue;
      }
      if (!parent) {
        const skippedObj = skipped.find((s) => s.name.toLowerCase() === raw.table.toLowerCase());
        fk.skippedReason = skippedObj
          ? `References ${raw.table}, which is not imported (${skippedObj.kind}).`
          : `References ${raw.table}, which does not exist in the file.`;
        continue;
      }
      let parentCols: number[];
      if (raw.to.every((v) => v === null)) {
        const pk = parent.keys.find((k) => k.sourceName === "PRIMARY KEY");
        if (!pk) {
          fk.skippedReason = `References the primary key of ${parent.targetName}, which has none.`;
          continue;
        }
        parentCols = pk.columns;
      } else {
        parentCols = raw.to.map((n) => parent.columns.findIndex((c) => sqliteColumnKey(c.x.name) === sqliteColumnKey(n ?? "")));
      }
      fk.parentColumns = parentCols;
      fk.parentColumnNames = parentCols.map((i) => parent.columns[i]?.targetName ?? "?");
      if (parentCols.some((i) => i < 0) || parentCols.length !== childCols.length) {
        fk.skippedReason = `Names columns that do not exist in ${parent.targetName}.`;
        continue;
      }
      if (fk.violations === -1) {
        fk.skippedReason = "SQLite could not check this foreign key against the data.";
        continue;
      }
      if (fk.violations > 0) {
        fk.skippedReason = `${fk.violations} row(s) reference rows that do not exist in ${parent.targetName} (SQLite does not enforce foreign keys unless asked to), so MariaDB would refuse it.`;
        continue;
      }
      if (fk.onDelete === "SET DEFAULT" || fk.onUpdate === "SET DEFAULT") {
        fk.skippedReason = "Uses ON DELETE/UPDATE SET DEFAULT, which InnoDB does not support.";
        continue;
      }
      if ((fk.onDelete === "SET NULL" || fk.onUpdate === "SET NULL") && childCols.some((i) => !t.columns[i]!.nullable)) {
        fk.skippedReason = "Uses SET NULL on a NOT NULL column, which MariaDB rejects.";
        continue;
      }
      const mismatch = childCols.findIndex((ci, k) => {
        const a = t.columns[ci]!;
        const b = parent.columns[parentCols[k]!]!;
        if (a.family !== b.family) return true;
        if (!isSized(a) && a.fixedType !== b.fixedType) return true;
        return false;
      });
      if (mismatch >= 0) {
        const a = t.columns[childCols[mismatch]!]!;
        const b = parent.columns[parentCols[mismatch]!]!;
        fk.skippedReason = `${a.targetName} and ${parent.targetName}.${b.targetName} end up with different MariaDB types (${a.family} and ${b.family}), so InnoDB cannot link them.`;
        continue;
      }
      const covered = t.keys.some((k) => !k.skippedReason && sameColumns(k.columns.slice(0, childCols.length), childCols));
      if (!covered) {
        const key: WorkKey = {
          kind: "index",
          name: "",
          sourceName: "foreign key",
          columns: childCols,
          skippedReason: null,
          implicitFor: fk,
        };
        fk.implicitKey = key;
        t.keys.push(key);
      }
    }
  }

  for (const t of work) {
    const keyNames = new NameAllocator();
    keyNames.reserve("PRIMARY");
    for (const k of t.keys) if (k.name) keyNames.reserve(k.name);
    for (const k of t.keys) {
      if (!k.name) k.name = keyNames.allocate(`fk_${k.columns.map((i) => t.columns[i]!.targetName).join("_")}`, "fk").targetName;
    }
    await checkLossyKeys(db, t, decoder, opts.nocaseCollation);
    sizeKeys(t);
    guardRowSize(t);
  }

  for (const t of work) {
    for (const fk of t.foreignKeys) {
      if (fk.skippedReason || !fk.parent) continue;
      const parent = fk.parent;
      const parentKey = parent.keys.find((k) => !k.skippedReason && sameColumns(k.columns.slice(0, fk.parentColumns.length), fk.parentColumns));
      if (!parentKey) {
        fk.skippedReason = `${parent.targetName} has no MariaDB index on (${fk.parentColumnNames.join(", ")}), which InnoDB needs on the referenced side.`;
      } else if (fk.implicitKey?.skippedReason) {
        fk.skippedReason = `The referencing columns cannot be indexed: ${fk.implicitKey.skippedReason}`;
      } else {
        const bad = fk.childColumns.findIndex((ci, k) => {
          const a = t.columns[ci]!;
          const b = parent.columns[fk.parentColumns[k]!]!;
          return a.family === "text" && a.textCollation !== b.textCollation;
        });
        if (bad >= 0) fk.skippedReason = "The two sides use different collations, so InnoDB cannot link them.";
      }
      if (fk.skippedReason && fk.implicitKey) fk.implicitKey.skippedReason = "Only needed for a foreign key that is skipped.";
    }
  }

  const tables: TableBlueprint[] = [];
  const planTables: ImportTablePlan[] = [];
  let nonPortable = 0;
  for (const t of work) {
    if (!isPortableIdentifier(t.targetName)) nonPortable++;
    const pk = t.keys.find((k) => k.kind === "primary" && !k.skippedReason) ?? null;
    if (!pk) {
      const declaredPk = t.keys.find((k) => k.kind === "primary");
      t.warnings.push(
        declaredPk?.skippedReason
          ? `Primary key not created: ${declaredPk.skippedReason} Rows cannot be updated or deleted through the Data API, which needs a key.`
          : "No primary key: imported without one (the SQLite rowid is not copied). Rows cannot be updated or deleted through the Data API, which needs a key.",
      );
    }
    for (const k of t.keys) {
      if (k.skippedReason && k.kind !== "primary" && !k.implicitFor) {
        t.warnings.push(`${k.kind === "unique" ? "Unique key" : "Index"} ${k.name} (${keyLabel(t, k)}) not created: ${k.skippedReason}`);
      }
    }
    const columnPlans: ImportColumnPlan[] = [];
    const defs: string[] = [];
    for (const c of t.columns) {
      if (!isPortableIdentifier(c.targetName)) nonPortable++;
      const type = columnType(c);
      const dflt = translateDefault(c);
      const parts = [quoteMariaIdent(c.targetName), type];
      if (!c.nullable) parts.push("NOT NULL");
      if (c.rowidAlias) parts.push("AUTO_INCREMENT");
      if (dflt !== null) parts.push(`DEFAULT ${dflt}`);
      defs.push(`  ${parts.join(" ")}`);
      const st = c.stats;
      columnPlans.push({
        sourceName: c.x.name,
        targetName: c.targetName,
        declaredType: c.declared.raw,
        observed: { ...st.counts },
        maxLength: st.counts.text + st.counts.blob > 0 ? Math.max(st.textMaxChars, st.blobMaxBytes) : null,
        mariadbType: type,
        nullable: c.nullable,
        primaryKey: pk !== null && pk.columns.includes(t.columns.indexOf(c)),
        autoIncrement: c.rowidAlias,
        defaultSql: dflt,
        notes: c.notes,
      });
    }
    if (pk) defs.push(`  PRIMARY KEY (${pk.columns.map((i) => quoteMariaIdent(t.columns[i]!.targetName)).join(", ")})`);
    const options = [`ENGINE=InnoDB`, `DEFAULT CHARSET=utf8mb4`, `COLLATE=${BINARY_COLLATION}`, `ROW_FORMAT=DYNAMIC`];
    if (t.autoIncrementNext !== null && t.autoIncrementNext > 1n) options.push(`AUTO_INCREMENT=${t.autoIncrementNext}`);
    t.createSql = `CREATE TABLE ${quoteMariaIdent(t.targetName)} (\n${defs.join(",\n")}\n) ${options.join(" ")}`;

    const order = pk && !pk.columns.some((i) => t.columns[i]!.rowidAlias) && !t.withoutRowid
      ? ` ORDER BY ${pk.columns.map((i) => quoteSqliteIdent(t.columns[i]!.x.name)).join(", ")}`
      : "";
    const exprs = t.columns.map(
      (c, i) =>
        `${c.family === "text" || c.family === "binary" || c.family === "date" || c.family === "datetime" ? readValueExpr(c.x.name) : quoteSqliteIdent(c.x.name)} AS c${i}`,
    );
    t.selectSql = `SELECT ${exprs.join(", ")} FROM ${quoteSqliteIdent(t.sourceName)}${order}`;

    const indexPlans: ImportIndexPlan[] = [];
    const indexClauses: { name: string; clause: string }[] = [];
    for (const k of t.keys) {
      if (k.implicitFor && k.skippedReason) continue;
      indexPlans.push({
        name: k.name,
        columns: k.columns.map((i) => t.columns[i]!.targetName),
        unique: k.kind !== "index",
        skippedReason: k.skippedReason,
      });
      if (k.skippedReason || k.kind === "primary") continue;
      const cols = k.columns.map((i) => quoteMariaIdent(t.columns[i]!.targetName)).join(", ");
      indexClauses.push({ name: k.name, clause: `ADD ${k.kind === "unique" ? "UNIQUE KEY" : "KEY"} ${quoteMariaIdent(k.name)} (${cols})` });
    }
    const fkPlans: ImportForeignKeyPlan[] = [];
    const fkClauses: { clause: string; label: string }[] = [];
    for (const fk of t.foreignKeys) {
      const childNames = fk.childColumns.map((i) => t.columns[i]?.targetName ?? "?");
      const refTable = fk.parent?.targetName ?? fk.parentSourceName;
      fkPlans.push({ columns: childNames, refTable, refColumns: fk.parentColumnNames, skippedReason: fk.skippedReason });
      const label = `(${childNames.join(", ")}) -> ${refTable}(${fk.parentColumnNames.join(", ")})`;
      if (fk.skippedReason) {
        t.warnings.push(`Foreign key ${label} not created: ${fk.skippedReason}`);
        continue;
      }
      const actions: string[] = [];
      for (const [kw, action] of [["ON DELETE", fk.onDelete], ["ON UPDATE", fk.onUpdate]] as const) {
        if (["CASCADE", "SET NULL", "RESTRICT"].includes(action)) actions.push(`${kw} ${action}`);
      }
      fkClauses.push({
        label,
        clause: `ADD FOREIGN KEY (${childNames.map(quoteMariaIdent).join(", ")}) REFERENCES ${quoteMariaIdent(refTable)} (${fk.parentColumnNames.map(quoteMariaIdent).join(", ")})${actions.length ? ` ${actions.join(" ")}` : ""}`,
      });
    }

    const plan: ImportTablePlan = {
      sourceName: t.sourceName,
      targetName: t.targetName,
      rowCount: t.rowCount,
      columns: columnPlans,
      indexes: indexPlans,
      foreignKeys: fkPlans,
      warnings: t.warnings,
      createSql: t.createSql,
    };
    planTables.push(plan);
    tables.push({
      sourceName: t.sourceName,
      targetName: t.targetName,
      rowCount: t.rowCount,
      columns: t.columns.map((c) => ({
        sourceName: c.x.name,
        targetName: c.targetName,
        family: c.family,
        rowidAlias: c.rowidAlias,
        generated: c.generated,
      })),
      selectSql: t.selectSql,
      createSql: t.createSql,
      indexClauses,
      foreignKeyClauses: fkClauses,
    });
  }
  if (nonPortable > 0) {
    planWarnings.push(
      `${nonPortable} table or column name(s) contain characters other than letters, digits and underscores. They work in SQL (always quote them with backticks) but the console's Data API and table browser cannot address them.`,
    );
  }
  if (work.length === 0) planWarnings.push("The file has no tables to import.");
  const warningCount = planWarnings.length + planTables.reduce((s, t) => s + t.warnings.length, 0);
  const plan: SqliteImportPlan = {
    format: "sqlite",
    upload,
    tables: planTables,
    skipped,
    warnings: planWarnings,
    totals: { tables: planTables.length, rows: planTables.reduce((s, t) => s + t.rowCount, 0), warnings: warningCount },
  };
  return { version: BLUEPRINT_VERSION, encoding, nocaseCollation: opts.nocaseCollation, plan, tables };
}
