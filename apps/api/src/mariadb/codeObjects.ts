import mysql, { type Connection, type RowDataPacket } from "mysql2/promise";
import { databases } from "../db/queries";
import { isSafeIdent, quoteIdent } from "../util/ident";
import { openAdminConnection } from "./controller";
import { explainMariaDbFailure, sanitizeMariaDbMessage } from "./messages";
import type { Target } from "./process";
import { withScopedAccount } from "./scopedAccount";

type RoutineKind = "PROCEDURE" | "FUNCTION" | "PACKAGE" | "PACKAGE BODY";
export type CodeKind = RoutineKind | "VIEW" | "TRIGGER" | "EVENT";

export interface Account {
  user: string;
  host: string;
}

export interface TriggerParts {
  table: string;
  timing: string;
  event: string;
  order: number;
  body: string;
}

export interface CodeRecord {
  kind: CodeKind;
  name: string;
  definer: Account | null;
  createSql: string;
  sqlMode: string | null;
  characterSetClient: string | null;
  collation: string | null;
  timeZone: string | null;
  invalid?: boolean;
  sourceSchema?: string;
  trigger?: TriggerParts;
}

export interface DefinerPolicy {
  account?: Account | null;
  keep?: "recorded" | "account";
}

export interface CodeApplyFailure {
  kind: CodeKind;
  name: string;
  error: string;
  explanation?: string;
}

export interface CodeApplyResult {
  applied: number;
  unchanged: number;
  dropped: number;
  failures: CodeApplyFailure[];
  warnings: string[];
}

export interface ApplyCodeOptions {
  definers?: DefinerPolicy;
  replace?: boolean;
  keepKinds?: CodeKind[];
  lockWaitTimeoutSec?: number;
  timeoutMs?: number;
}

export class CodeTimeLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CodeTimeLimitError";
  }
}

const MAX_IDENT_LENGTH = 64;
export const DEFAULT_CODE_LOCK_WAIT_SEC = 10;
export const DEFAULT_CODE_TIMEOUT_MS = 120_000;
const STATEMENT_GRACE_SEC = 20;
const SYSTEM_SCHEMAS = new Set(["mysql", "information_schema", "performance_schema", "sys"]);
const ROUTINE_KINDS: RoutineKind[] = ["PACKAGE", "PACKAGE BODY", "FUNCTION", "PROCEDURE"];
const ALL_KINDS: CodeKind[] = ["PACKAGE", "PACKAGE BODY", "FUNCTION", "PROCEDURE", "VIEW", "TRIGGER", "EVENT"];
const EXTRA_DROP_ORDER: CodeKind[] = ["VIEW", "EVENT", "TRIGGER", "PROCEDURE", "FUNCTION", "PACKAGE BODY", "PACKAGE"];
const TIMINGS = new Set(["BEFORE", "AFTER"]);
const EVENTS = new Set(["INSERT", "UPDATE", "DELETE"]);
const SAFE_SESSION_VALUE = /^[A-Za-z0-9_]+$/;
const SAFE_TIME_ZONE = /^(?:SYSTEM|[+-]\d{1,2}:\d{2}|[A-Za-z0-9_+\-/]{1,64})$/;
const RENDER_MAGIC = "-- LambData code objects v1";
const RENDER_MARK = "-- ld-code";

const QUOTED = String.raw`(?:\`(?:[^\`]|\`\`)*\`|"(?:[^"]|"")*")`;
const ACCOUNT = String.raw`(${QUOTED})(?:@(${QUOTED}))?`;
const ROUTINE_HEAD = new RegExp(String.raw`^CREATE DEFINER=${ACCOUNT} ((?:AGGREGATE )?FUNCTION|PROCEDURE|PACKAGE BODY|PACKAGE) `);
const VIEW_HEAD = new RegExp(
  String.raw`^CREATE ALGORITHM=(UNDEFINED|MERGE|TEMPTABLE) DEFINER=${ACCOUNT} SQL SECURITY (DEFINER|INVOKER) VIEW `,
);
const EVENT_HEAD = new RegExp(String.raw`^CREATE DEFINER=${ACCOUNT} EVENT `);
const ORIGINAL_TRIGGER_HEAD = new RegExp(String.raw`^CREATE DEFINER=${ACCOUNT} (?=trigger\s)`, "i");


function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function quoteName(name: string): string {
  if (!name || name.length > MAX_IDENT_LENGTH || name.includes("\u0000")) throw new Error("invalid object name");
  return "`" + name.replaceAll("`", "``") + "`";
}

function assertCodeSchema(schema: string): void {
  if (!isSafeIdent(schema)) throw new Error("invalid schema name");
  if (SYSTEM_SCHEMAS.has(schema.toLowerCase())) throw new Error(`refusing to change code objects in ${schema}`);
}

function unquoteIdent(token: string): string {
  const q = token[0] ?? "`";
  return token.slice(1, -1).replaceAll(q + q, q);
}

function backtick(value: string): string {
  return "`" + value.replaceAll("`", "``") + "`";
}

export function quoteAccount(a: Account): string {
  return `${backtick(a.user)}@${backtick(a.host)}`;
}

export function accountKey(a: Account): string {
  return `${a.user}@${a.host.toLowerCase()}`;
}

function parseDefinerString(value: unknown): Account | null {
  if (typeof value !== "string" || !value) return null;
  const at = value.lastIndexOf("@");
  if (at <= 0) return null;
  return { user: value.slice(0, at), host: value.slice(at + 1) };
}

interface ParsedHead {
  definer: Account | null;
  keyword: string;
  algorithm: string | null;
  security: string | null;
  rest: string;
}

function headAccount(userTok: string, hostTok: string | undefined): Account | null {
  if (hostTok === undefined) return null;
  return { user: unquoteIdent(userTok), host: unquoteIdent(hostTok) };
}

function parseHead(kind: CodeKind, createSql: string): ParsedHead | null {
  if (kind === "VIEW") {
    const m = VIEW_HEAD.exec(createSql);
    if (!m) return null;
    return {
      definer: headAccount(m[2]!, m[3]),
      keyword: "VIEW",
      algorithm: m[1]!,
      security: m[4]!,
      rest: createSql.slice(m[0].length),
    };
  }
  if (kind === "TRIGGER") {
    const t = ORIGINAL_TRIGGER_HEAD.exec(createSql);
    if (!t) return null;
    const keyword = createSql.slice(t[0].length, t[0].length + "trigger".length);
    return { definer: headAccount(t[1]!, t[2]), keyword, algorithm: null, security: null, rest: createSql.slice(t[0].length + "trigger".length).replace(/^\s+/, "") };
  }
  const pattern = kind === "EVENT" ? EVENT_HEAD : ROUTINE_HEAD;
  const m = pattern.exec(createSql);
  if (!m) return null;
  const keyword = kind === "EVENT" ? "EVENT" : m[3]!;
  const normalized = keyword === "AGGREGATE FUNCTION" ? "FUNCTION" : keyword;
  if (kind !== "EVENT" && normalized !== kind) return null;
  return { definer: headAccount(m[1]!, m[2]), keyword, algorithm: null, security: null, rest: createSql.slice(m[0].length) };
}

interface IdentToken {
  value: string;
  end: number;
}

function readIdent(s: string, pos: number): IdentToken | null {
  const q = s[pos];
  if (q === "`" || q === '"') {
    let i = pos + 1;
    let value = "";
    while (i < s.length) {
      if (s[i] === q) {
        if (s[i + 1] === q) {
          value += q;
          i += 2;
          continue;
        }
        return { value, end: i + 1 };
      }
      value += s[i];
      i++;
    }
    return null;
  }
  const m = /^[A-Za-z0-9_$]+/.exec(s.slice(pos));
  return m ? { value: m[0], end: pos + m[0].length } : null;
}

function readQualified(s: string, pos: number): { qualifier: string | null; name: string; end: number } | null {
  const first = readIdent(s, pos);
  if (!first) return null;
  if (s[first.end] === ".") {
    const second = readIdent(s, first.end + 1);
    if (!second) return null;
    return { qualifier: first.value, name: second.value, end: second.end };
  }
  return { qualifier: null, name: first.value, end: first.end };
}

export interface ParsedTriggerStatement {
  qualifier: string | null;
  name: string;
  timing: string;
  event: string;
  tableQualifier: string | null;
  table: string;
  body: string;
}

export function parseTriggerStatement(createSql: string): ParsedTriggerStatement | null {
  const head = ORIGINAL_TRIGGER_HEAD.exec(createSql);
  if (!head) return null;
  const rest = createSql.slice(head[0].length + "trigger".length).replace(/^\s+/, "");
  const name = readQualified(rest, 0);
  if (!name) return null;
  const middle = /^\s+(BEFORE|AFTER)\s+(INSERT|UPDATE|DELETE)\s+ON\s+/i.exec(rest.slice(name.end));
  if (!middle) return null;
  const tablePos = name.end + middle[0].length;
  const table = readQualified(rest, tablePos);
  if (!table) return null;
  const tail = /^\s+FOR\s+EACH\s+ROW\s+/i.exec(rest.slice(table.end));
  if (!tail) return null;
  return {
    qualifier: name.qualifier,
    name: name.name,
    timing: middle[1]!.toUpperCase(),
    event: middle[2]!.toUpperCase(),
    tableQualifier: table.qualifier,
    table: table.name,
    body: rest.slice(table.end + tail[0].length),
  };
}

function originalFits(r: { name: string; createSql: string; trigger?: TriggerParts }, schema: string): boolean {
  const t = r.trigger;
  if (!t) return false;
  const parsed = parseTriggerStatement(r.createSql);
  if (!parsed) return false;
  if (parsed.qualifier !== null && parsed.qualifier !== schema) return false;
  if (parsed.tableQualifier !== null && parsed.tableQualifier !== schema) return false;
  return (
    parsed.name.toLowerCase() === r.name.toLowerCase() &&
    parsed.table === t.table &&
    parsed.timing === t.timing &&
    parsed.event === t.event &&
    parsed.body === t.body
  );
}

function startsWithName(rest: string, name: string, allowBare: boolean): boolean {
  const forms = [backtick(name), `"${name.replaceAll('"', '""')}"`];
  if (allowBare && /^[A-Za-z0-9_$]+$/.test(name)) forms.push(name);
  return forms.some((f) => rest.startsWith(f) && /^[\s(]/.test(rest.slice(f.length)));
}

function isConnection(source: Target | Connection): source is Connection {
  return typeof (source as Connection).query === "function";
}

async function openCaptureConnection(target: Target, schema: string): Promise<Connection> {
  return mysql.createConnection({
    host: target.host,
    port: target.port,
    user: target.user,
    password: target.password,
    database: schema,
    multipleStatements: false,
    supportBigNumbers: true,
    charset: "utf8mb4",
    connectTimeout: 10_000,
  });
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function pickCreate(row: RowDataPacket | undefined, column: string, label: string): string {
  const value = row?.[column];
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`could not read the definition of ${label}; the account used needs the rights to see it`);
  }
  return value;
}

async function captureOn(c: Connection, schema: string): Promise<CodeRecord[]> {
  await c.query(`USE ${quoteName(schema)}`);
  await c.query("SET SESSION sql_mode = ''");
  await c.query("SET SESSION sql_quote_show_create = 1");
  const out: CodeRecord[] = [];

  const [routines] = await c.query<RowDataPacket[]>(
    `SELECT ROUTINE_NAME AS name, ROUTINE_TYPE AS type, DEFINER AS definer FROM information_schema.ROUTINES
      WHERE ROUTINE_SCHEMA = ? ORDER BY ROUTINE_TYPE, ROUTINE_NAME`,
    [schema],
  );
  for (const r of routines) {
    const kind = String(r.type) as RoutineKind;
    if (!ROUTINE_KINDS.includes(kind)) throw new Error(`unsupported routine type ${kind}`);
    const name = String(r.name);
    const [rows] = await c.query<RowDataPacket[]>(`SHOW CREATE ${kind} ${quoteName(name)}`);
    const row = rows[0];
    const column = Object.keys(row ?? {}).find((k) => k.startsWith("Create ")) ?? "";
    const createSql = pickCreate(row, column, `${kind.toLowerCase()} ${name}`);
    out.push({
      kind,
      name,
      definer: parseHead(kind, createSql)?.definer ?? parseDefinerString(r.definer),
      createSql,
      sqlMode: optionalString(row?.sql_mode),
      characterSetClient: optionalString(row?.character_set_client),
      collation: optionalString(row?.collation_connection),
      timeZone: null,
      sourceSchema: schema,
    });
  }

  const [views] = await c.query<RowDataPacket[]>(
    `SELECT TABLE_NAME AS name, DEFINER AS definer FROM information_schema.VIEWS WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME`,
    [schema],
  );
  for (const v of views) {
    const name = String(v.name);
    const [rows] = await c.query<RowDataPacket[]>(`SHOW CREATE VIEW ${quoteName(name)}`);
    const [warnings] = await c.query<RowDataPacket[]>("SHOW WARNINGS");
    const row = rows[0];
    const createSql = pickCreate(row, "Create View", `view ${name}`);
    const record: CodeRecord = {
      kind: "VIEW",
      name,
      definer: parseHead("VIEW", createSql)?.definer ?? parseDefinerString(v.definer),
      createSql,
      sqlMode: null,
      characterSetClient: optionalString(row?.character_set_client),
      collation: optionalString(row?.collation_connection),
      timeZone: null,
      sourceSchema: schema,
    };
    if (warnings.some((w) => Number(w.Code) === 1356)) record.invalid = true;
    out.push(record);
  }

  const [triggers] = await c.query<RowDataPacket[]>(
    `SELECT TRIGGER_NAME AS name, EVENT_OBJECT_TABLE AS tbl, ACTION_TIMING AS timing, EVENT_MANIPULATION AS ev,
            ACTION_ORDER AS ord, ACTION_STATEMENT AS body, DEFINER AS definer, SQL_MODE AS sqlMode,
            CHARACTER_SET_CLIENT AS cs, COLLATION_CONNECTION AS coll
       FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = ?
      ORDER BY EVENT_OBJECT_TABLE, ACTION_TIMING, EVENT_MANIPULATION, ACTION_ORDER`,
    [schema],
  );
  for (const t of triggers) {
    const name = String(t.name);
    const definer = parseDefinerString(t.definer);
    const timing = String(t.timing).toUpperCase();
    const event = String(t.ev).toUpperCase();
    const body = typeof t.body === "string" ? t.body : null;
    const base = {
      kind: "TRIGGER" as const,
      name,
      definer,
      sqlMode: optionalString(t.sqlMode),
      characterSetClient: optionalString(t.cs),
      collation: optionalString(t.coll),
      timeZone: null,
      sourceSchema: schema,
    };
    const [rows] = await c.query<RowDataPacket[]>(`SHOW CREATE TRIGGER ${quoteName(name)}`);
    const original = rows[0]?.["SQL Original Statement"];
    if (definer && body !== null && TIMINGS.has(timing) && EVENTS.has(event)) {
      const parts: TriggerParts = { table: String(t.tbl), timing, event, order: Number(t.ord ?? 0), body };
      const record: CodeRecord = { ...base, createSql: triggerStatement(name, definer, parts, false), trigger: parts };
      if (typeof original === "string" && originalFits({ name, createSql: original, trigger: parts }, schema)) record.createSql = original;
      out.push(record);
      continue;
    }
    out.push({ ...base, createSql: pickCreate(rows[0], "SQL Original Statement", `trigger ${name}`) });
  }

  const [events] = await c.query<RowDataPacket[]>(
    `SELECT EVENT_NAME AS name, DEFINER AS definer FROM information_schema.EVENTS WHERE EVENT_SCHEMA = ? ORDER BY EVENT_NAME`,
    [schema],
  );
  for (const e of events) {
    const name = String(e.name);
    const [rows] = await c.query<RowDataPacket[]>(`SHOW CREATE EVENT ${quoteName(name)}`);
    const row = rows[0];
    const createSql = pickCreate(row, "Create Event", `event ${name}`);
    out.push({
      kind: "EVENT",
      name,
      definer: parseHead("EVENT", createSql)?.definer ?? parseDefinerString(e.definer),
      createSql,
      sqlMode: optionalString(row?.sql_mode),
      characterSetClient: optionalString(row?.character_set_client),
      collation: optionalString(row?.collation_connection),
      timeZone: optionalString(row?.time_zone),
      sourceSchema: schema,
    });
  }
  return out;
}

export async function captureCodeRecords(source: Target | Connection, schema: string): Promise<CodeRecord[]> {
  if (!schema || schema.length > MAX_IDENT_LENGTH) throw new Error("invalid schema name");
  if (isConnection(source)) return captureOn(source, schema);
  const conn = await openCaptureConnection(source, schema);
  try {
    return await captureOn(conn, schema);
  } finally {
    await conn.end().catch(() => conn.destroy());
  }
}

function triggerStatement(name: string, definer: Account, t: TriggerParts, orReplace: boolean): string {
  return `CREATE ${orReplace ? "OR REPLACE " : ""}DEFINER=${quoteAccount(definer)} TRIGGER ${quoteName(name)} ${t.timing} ${t.event} ON ${quoteName(t.table)} FOR EACH ROW ${t.body}`;
}

export class CodeShapeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CodeShapeError";
  }
}

export function buildCreateStatement(r: CodeRecord, definer: Account, targetSchema: string): string {
  if (r.kind === "TRIGGER" && r.trigger) {
    if (!TIMINGS.has(r.trigger.timing) || !EVENTS.has(r.trigger.event)) throw new CodeShapeError("unsupported trigger timing or event");
    if (originalFits(r, targetSchema)) {
      const head = ORIGINAL_TRIGGER_HEAD.exec(r.createSql)!;
      return `CREATE OR REPLACE DEFINER=${quoteAccount(definer)} ${r.createSql.slice(head[0].length)}`;
    }
    return triggerStatement(r.name, definer, r.trigger, true);
  }
  const head = parseHead(r.kind, r.createSql);
  if (!head) throw new CodeShapeError("its definition does not have the form MariaDB prints for this kind of object");
  if (!startsWithName(head.rest, r.name, r.kind === "TRIGGER")) {
    throw new CodeShapeError("its definition names a different object or another database");
  }
  if (r.kind === "VIEW") {
    let rest = head.rest;
    if (r.sourceSchema && r.sourceSchema !== targetSchema) rest = rest.replaceAll(`${backtick(r.sourceSchema)}.`, "");
    return `CREATE OR REPLACE ALGORITHM=${head.algorithm} DEFINER=${quoteAccount(definer)} SQL SECURITY ${head.security} VIEW ${rest}`;
  }
  return `CREATE OR REPLACE DEFINER=${quoteAccount(definer)} ${head.keyword} ${head.rest}`;
}

function recordKey(kind: CodeKind, name: string): string {
  return `${kind}:${kind === "VIEW" ? name : name.toLowerCase()}`;
}

function viewDependencies(views: CodeRecord[]): CodeRecord[] {
  const byName = new Map(views.map((v) => [v.name, v]));
  const deps = new Map<string, Set<string>>();
  for (const v of views) {
    const set = new Set<string>();
    for (const other of views) {
      if (other.name !== v.name && v.createSql.includes(backtick(other.name))) set.add(other.name);
    }
    deps.set(v.name, set);
  }
  const out: CodeRecord[] = [];
  const done = new Set<string>();
  const visiting = new Set<string>();
  const visit = (name: string): void => {
    if (done.has(name) || visiting.has(name)) return;
    visiting.add(name);
    for (const d of [...(deps.get(name) ?? [])].sort()) visit(d);
    visiting.delete(name);
    done.add(name);
    out.push(byName.get(name)!);
  };
  for (const name of [...byName.keys()].sort()) visit(name);
  return out;
}

function triggerSort(a: CodeRecord, b: CodeRecord): number {
  const ta = a.trigger;
  const tb = b.trigger;
  const ka = ta ? `${ta.table}\u0000${ta.timing}\u0000${ta.event}` : `￿${a.name}`;
  const kb = tb ? `${tb.table}\u0000${tb.timing}\u0000${tb.event}` : `￿${b.name}`;
  if (ka !== kb) return ka < kb ? -1 : 1;
  return (ta?.order ?? 0) - (tb?.order ?? 0);
}

function byName(a: CodeRecord, b: CodeRecord): number {
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

export function orderCodeRecords(records: CodeRecord[]): CodeRecord[] {
  const pick = (kind: CodeKind) => records.filter((r) => r.kind === kind);
  return [
    ...pick("PACKAGE").sort(byName),
    ...pick("PACKAGE BODY").sort(byName),
    ...pick("FUNCTION").sort(byName),
    ...pick("PROCEDURE").sort(byName),
    ...viewDependencies(pick("VIEW")),
    ...pick("TRIGGER").sort(triggerSort),
    ...pick("EVENT").sort(byName),
  ];
}

function sqlString(value: string): string {
  return `'${value.replaceAll("\\", "\\\\").replaceAll("'", "''")}'`;
}

function sessionLines(r: CodeRecord): string[] {
  const lines: string[] = [];
  lines.push(r.sqlMode !== null ? `SET SESSION sql_mode = ${sqlString(r.sqlMode)};` : "SET SESSION sql_mode = @ld_saved_sql_mode;");
  if (r.collation && SAFE_SESSION_VALUE.test(r.collation)) lines.push(`SET SESSION collation_connection = ${r.collation};`);
  if (r.kind === "EVENT" && r.timeZone && SAFE_TIME_ZONE.test(r.timeZone)) lines.push(`SET SESSION time_zone = ${sqlString(r.timeZone)};`);
  return lines;
}

function renderMeta(r: CodeRecord): string {
  const meta = {
    kind: r.kind,
    name: r.name,
    sqlMode: r.sqlMode,
    characterSetClient: r.characterSetClient,
    collation: r.collation,
    timeZone: r.timeZone,
    sourceSchema: r.sourceSchema ?? null,
    trigger: r.trigger ? { table: r.trigger.table, timing: r.trigger.timing, event: r.trigger.event, order: r.trigger.order } : null,
  };
  return Buffer.from(JSON.stringify(meta)).toString("base64");
}

export function renderCodeRecords(records: CodeRecord[]): string {
  if (records.length === 0) return "";
  const ordered = orderCodeRecords(records);
  const blocks = ordered.map((r) => ({
    meta: renderMeta(r),
    text: [...sessionLines(r), "DELIMITER ;;", r.createSql, ";;", "DELIMITER ;", ""].join("\n"),
  }));
  const boundary = new Bun.CryptoHasher("sha256")
    .update(JSON.stringify(blocks))
    .digest("hex")
    .slice(0, 32);
  const out = [
    `${RENDER_MAGIC} ${boundary}`,
    "SET @ld_saved_sql_mode = @@sql_mode, @ld_saved_collation = @@collation_connection, @ld_saved_time_zone = @@time_zone;",
  ];
  for (const b of blocks) out.push(`${RENDER_MARK} ${boundary} ${b.meta}`, b.text);
  out.push(
    `${RENDER_MARK} ${boundary} end`,
    "SET SESSION sql_mode = @ld_saved_sql_mode, collation_connection = @ld_saved_collation, time_zone = @ld_saved_time_zone;",
    "",
  );
  return out.join("\n");
}

export function isRenderedCode(text: string): boolean {
  return text.startsWith(`${RENDER_MAGIC} `);
}

const BLOCK_OPEN = "DELIMITER ;;\n";
const BLOCK_CLOSE = "\n;;\nDELIMITER ;\n";

export function parseRenderedCode(text: string): CodeRecord[] | null {
  const header = /^-- LambData code objects v1 ([0-9a-f]{32})\n/.exec(text);
  if (!header) return null;
  const marker = `${RENDER_MARK} ${header[1]} `;
  const out: CodeRecord[] = [];
  let pos = text.indexOf(`\n${marker}`);
  while (pos !== -1) {
    const lineStart = pos + 1;
    const lineEnd = text.indexOf("\n", lineStart);
    if (lineEnd === -1) throw new Error("the stored code objects are truncated");
    const payload = text.slice(lineStart + marker.length, lineEnd);
    if (payload === "end") return out;
    const next = text.indexOf(`\n${marker}`, lineEnd);
    if (next === -1) throw new Error("the stored code objects are truncated");
    const block = text.slice(lineEnd + 1, next + 1);
    const open = block.indexOf(BLOCK_OPEN);
    const close = block.lastIndexOf(BLOCK_CLOSE);
    if (open === -1 || close === -1 || close < open) throw new Error("the stored code objects are malformed");
    const createSql = block.slice(open + BLOCK_OPEN.length, close);
    let meta: {
      kind: CodeKind;
      name: string;
      sqlMode: string | null;
      characterSetClient: string | null;
      collation: string | null;
      timeZone: string | null;
      sourceSchema: string | null;
      trigger: { table: string; timing: string; event: string; order: number } | null;
    };
    try {
      meta = JSON.parse(Buffer.from(payload, "base64").toString("utf8"));
    } catch {
      throw new Error("the stored code objects are malformed");
    }
    if (!ALL_KINDS.includes(meta.kind) || typeof meta.name !== "string") throw new Error("the stored code objects are malformed");
    const head = parseHead(meta.kind, createSql);
    const record: CodeRecord = {
      kind: meta.kind,
      name: meta.name,
      definer: head?.definer ?? null,
      createSql,
      sqlMode: meta.sqlMode ?? null,
      characterSetClient: meta.characterSetClient ?? null,
      collation: meta.collation ?? null,
      timeZone: meta.timeZone ?? null,
    };
    if (meta.sourceSchema) record.sourceSchema = meta.sourceSchema;
    if (meta.kind === "TRIGGER" && meta.trigger && head) {
      const t = meta.trigger;
      const expected = `${quoteName(meta.name)} ${t.timing} ${t.event} ON ${quoteName(t.table)} FOR EACH ROW `;
      const parsed = head.rest.startsWith(expected) ? null : parseTriggerStatement(createSql);
      if (head.rest.startsWith(expected)) {
        record.trigger = { table: t.table, timing: t.timing, event: t.event, order: t.order, body: head.rest.slice(expected.length) };
      } else if (parsed && parsed.table === t.table && parsed.timing === t.timing && parsed.event === t.event) {
        record.trigger = { table: t.table, timing: t.timing, event: t.event, order: t.order, body: parsed.body };
      }
    }
    out.push(record);
    pos = next;
  }
  throw new Error("the stored code objects are truncated");
}

function ordered(objects: CodeRecord[], order: CodeKind[]): CodeRecord[] {
  return order.flatMap((kind) => objects.filter((o) => o.kind === kind));
}

export function ownAccountOf(schema: string): Account | null {
  const row = databases.byName(schema);
  return row ? { user: row.mysqlUser, host: row.connectionsFrom } : null;
}

async function existingAccounts(c: Connection): Promise<Set<string>> {
  const [rows] = await c.query<RowDataPacket[]>("SELECT User AS u, Host AS h FROM mysql.user");
  return new Set(rows.map((r) => accountKey({ user: String(r.u), host: String(r.h) })));
}

export class CodeSession {
  readonly conn: Connection;
  readonly schema: string;
  private readonly deadline: number;
  private readonly baseSqlMode: string;
  private readonly baseCollation: string;
  private readonly baseTimeZone: string;

  private constructor(conn: Connection, schema: string, deadline: number, base: { sqlMode: string; collation: string; timeZone: string }) {
    this.conn = conn;
    this.schema = schema;
    this.deadline = deadline;
    this.baseSqlMode = base.sqlMode;
    this.baseCollation = base.collation;
    this.baseTimeZone = base.timeZone;
  }

  static async open(target: Target, schema: string, opts: { lockWaitTimeoutSec?: number; deadline: number }): Promise<CodeSession> {
    const conn = await mysql.createConnection({
      host: target.host,
      port: target.port,
      user: target.user,
      password: target.password,
      database: schema,
      multipleStatements: false,
      supportBigNumbers: true,
      charset: "utf8mb4",
      connectTimeout: 10_000,
    });
    try {
      const wait = Math.max(1, Math.round(opts.lockWaitTimeoutSec ?? DEFAULT_CODE_LOCK_WAIT_SEC));
      await conn.query("SET SESSION lock_wait_timeout = ?", [wait]);
      await conn.query("SET SESSION max_statement_time = ?", [wait + STATEMENT_GRACE_SEC]);
      const [rows] = await conn.query<RowDataPacket[]>(
        "SELECT @@SESSION.sql_mode AS m, @@SESSION.collation_connection AS c, @@SESSION.time_zone AS z",
      );
      return new CodeSession(conn, schema, opts.deadline, {
        sqlMode: String(rows[0]?.m ?? ""),
        collation: String(rows[0]?.c ?? "utf8mb4_general_ci"),
        timeZone: String(rows[0]?.z ?? "SYSTEM"),
      });
    } catch (err) {
      await conn.end().catch(() => conn.destroy());
      throw err;
    }
  }

  async close(): Promise<void> {
    await this.conn.end().catch(() => this.conn.destroy());
  }

  remainingMs(): number {
    return this.deadline - Date.now();
  }

  private checkDeadline(): void {
    if (Date.now() > this.deadline) throw new CodeTimeLimitError("the time limit for re-creating code objects was reached");
  }

  private async context(r: CodeRecord): Promise<void> {
    await this.conn.query("SET SESSION sql_mode = ?", [r.sqlMode ?? this.baseSqlMode]);
    const coll = r.collation && SAFE_SESSION_VALUE.test(r.collation) ? r.collation : this.baseCollation;
    await this.conn.query(`SET SESSION collation_connection = ${coll}`);
    const tz = r.kind === "EVENT" && r.timeZone && SAFE_TIME_ZONE.test(r.timeZone) ? r.timeZone : this.baseTimeZone;
    await this.conn.query("SET SESSION time_zone = ?", [tz]);
  }

  async definerOf(kind: CodeKind, name: string): Promise<string | null> {
    let rows: RowDataPacket[];
    if (kind === "VIEW") {
      [rows] = await this.conn.query<RowDataPacket[]>(
        "SELECT DEFINER AS d FROM information_schema.VIEWS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?",
        [this.schema, name],
      );
    } else if (kind === "TRIGGER") {
      [rows] = await this.conn.query<RowDataPacket[]>(
        "SELECT DEFINER AS d FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = ? AND TRIGGER_NAME = ?",
        [this.schema, name],
      );
    } else if (kind === "EVENT") {
      [rows] = await this.conn.query<RowDataPacket[]>(
        "SELECT DEFINER AS d FROM information_schema.EVENTS WHERE EVENT_SCHEMA = ? AND EVENT_NAME = ?",
        [this.schema, name],
      );
    } else {
      [rows] = await this.conn.query<RowDataPacket[]>(
        "SELECT DEFINER AS d FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA = ? AND ROUTINE_TYPE = ? AND ROUTINE_NAME = ?",
        [this.schema, kind, name],
      );
    }
    return rows.length > 0 ? String(rows[0]!.d) : null;
  }

  async create(r: CodeRecord, definer: Account): Promise<void> {
    this.checkDeadline();
    const sql = buildCreateStatement(r, definer, this.schema);
    await this.context(r);
    const client = recordedClientCharset(r, sql);
    if (client) await this.conn.query(`SET SESSION character_set_client = ${client}`);
    try {
      await this.conn.query(sql);
    } finally {
      if (client) await this.conn.query(`SET SESSION character_set_client = ${SESSION_CLIENT_CHARSET}`).catch(() => {});
    }
    const actual = await this.definerOf(r.kind, r.name);
    if (actual === null || actual.toLowerCase() !== `${definer.user}@${definer.host}`.toLowerCase()) {
      await this.drop(r.kind, r.name).catch(() => {});
      throw new Error(`it was created with an unexpected definer (${actual ?? "none"}) and was removed`);
    }
  }

  async drop(kind: CodeKind, name: string): Promise<void> {
    this.checkDeadline();
    await this.conn.query(`DROP ${kind} IF EXISTS ${quoteName(name)}`);
  }
}

const SESSION_CLIENT_CHARSET = "utf8mb4";
const UTF8_CLIENT_CHARSETS = new Set(["utf8", "utf8mb3"]);
const ASCII_ONLY = /^[\x00-\x7f]*$/;
const BEYOND_BMP = /[\u{10000}-\u{10FFFF}]/u;

function recordedClientCharset(r: CodeRecord, sql: string): string | null {
  const recorded = r.characterSetClient;
  if (!recorded || !SAFE_SESSION_VALUE.test(recorded)) return null;
  const name = recorded.toLowerCase();
  if (name === SESSION_CLIENT_CHARSET) return null;
  if (ASCII_ONLY.test(sql)) return name;
  if (UTF8_CLIENT_CHARSETS.has(name) && !BEYOND_BMP.test(sql)) return name;
  return null;
}

function sameDefinition(a: CodeRecord, aDefiner: Account | null, b: CodeRecord, bDefiner: Account, schema: string): boolean {
  if (!aDefiner || accountKey(aDefiner) !== accountKey(bDefiner)) return false;
  if ((a.sqlMode ?? "") !== (b.sqlMode ?? "") && a.kind !== "VIEW") return false;
  if (a.kind === "EVENT" && (a.timeZone ?? "") !== (b.timeZone ?? "")) return false;
  try {
    return buildCreateStatement(a, aDefiner, schema) === buildCreateStatement(b, bDefiner, schema);
  } catch {
    return false;
  }
}

export interface ReconcileInput {
  session: CodeSession;
  current: CodeRecord[];
  desired: CodeRecord[];
  kinds: CodeKind[];
  dropExtras: boolean;
  definerFor: (r: CodeRecord) => Account;
  isExtraCandidate?: (r: CodeRecord) => boolean;
}

export function codeFailure(kind: CodeKind, name: string, raw: string): CodeApplyFailure {
  const failure: CodeApplyFailure = { kind, name, error: sanitizeMariaDbMessage(raw) };
  const explanation = explainMariaDbFailure(raw, kind);
  if (explanation) failure.explanation = explanation;
  return failure;
}

function failureOf(r: { kind: CodeKind; name: string }, err: unknown): CodeApplyFailure {
  return codeFailure(r.kind, r.name, errorMessage(err));
}

function triggerGroup(r: CodeRecord): string {
  return r.trigger ? `${r.trigger.table}\u0000${r.trigger.timing}\u0000${r.trigger.event}` : `\u0001${r.name}`;
}

export async function reconcileCode(input: ReconcileInput): Promise<CodeApplyResult> {
  const { session } = input;
  const kinds = new Set(input.kinds);
  const result: CodeApplyResult = { applied: 0, unchanged: 0, dropped: 0, failures: [], warnings: [] };
  const current = input.current.filter((r) => kinds.has(r.kind));
  const desired = input.desired.filter((r) => kinds.has(r.kind));
  const currentByKey = new Map(current.map((r) => [recordKey(r.kind, r.name), r]));
  const desiredKeys = new Set(desired.map((r) => recordKey(r.kind, r.name)));
  let timedOut = false;

  const unchanged = (r: CodeRecord): boolean => {
    const existing = currentByKey.get(recordKey(r.kind, r.name));
    if (!existing) return false;
    try {
      return sameDefinition(existing, existing.definer, r, input.definerFor(r), session.schema);
    } catch {
      return false;
    }
  };

  const createOrError = async (r: CodeRecord): Promise<unknown> => {
    if (timedOut) return new CodeTimeLimitError("not re-created: the time limit was reached");
    try {
      await session.create(r, input.definerFor(r));
      result.applied++;
      return null;
    } catch (err) {
      if (err instanceof CodeTimeLimitError) timedOut = true;
      return err;
    }
  };

  const attempt = async (r: CodeRecord): Promise<void> => {
    const err = await createOrError(r);
    if (err) result.failures.push(failureOf(r, err));
  };

  const dropOne = async (r: CodeRecord): Promise<void> => {
    if (timedOut) {
      result.warnings.push(`did not remove ${r.kind.toLowerCase()} ${r.name}: the time limit was reached`);
      return;
    }
    try {
      await session.drop(r.kind, r.name);
      result.dropped++;
    } catch (err) {
      if (err instanceof CodeTimeLimitError) timedOut = true;
      result.warnings.push(`could not remove ${r.kind.toLowerCase()} ${r.name}: ${sanitizeMariaDbMessage(errorMessage(err))}`);
    }
  };

  const isExtra = (r: CodeRecord): boolean =>
    input.dropExtras && !desiredKeys.has(recordKey(r.kind, r.name)) && (input.isExtraCandidate?.(r) ?? true);

  for (const r of current.filter((c) => c.kind === "VIEW" && isExtra(c))) await dropOne(r);

  const ordering = orderCodeRecords(desired);
  for (const r of ordering.filter((o) => ROUTINE_KINDS.includes(o.kind as RoutineKind))) {
    if (unchanged(r)) result.unchanged++;
    else await attempt(r);
  }

  let pending = ordering.filter((o) => o.kind === "VIEW").filter((r) => {
    if (!unchanged(r)) return true;
    result.unchanged++;
    if (currentByKey.get(recordKey(r.kind, r.name))?.invalid) {
      result.warnings.push(
        `view ${r.name} is kept as recorded but cannot be queried: it refers to a table, column or function that does not exist`,
      );
    }
    return false;
  });
  while (pending.length > 0) {
    const failed: { view: CodeRecord; err: unknown }[] = [];
    for (const v of pending) {
      const err = await createOrError(v);
      if (err) failed.push({ view: v, err });
    }
    if (failed.length === pending.length || timedOut) {
      for (const f of failed) result.failures.push(failureOf(f.view, f.err));
      break;
    }
    pending = failed.map((f) => f.view);
  }

  const groups = new Map<string, { desired: CodeRecord[]; current: CodeRecord[] }>();
  for (const r of ordering.filter((o) => o.kind === "TRIGGER")) {
    const key = triggerGroup(r);
    const g = groups.get(key) ?? { desired: [], current: [] };
    g.desired.push(r);
    groups.set(key, g);
  }
  for (const r of current.filter((o) => o.kind === "TRIGGER")) groups.get(triggerGroup(r))?.current.push(r);
  for (const g of groups.values()) {
    g.current.sort(triggerSort);
    const same =
      g.current.length === g.desired.length &&
      g.current.every((c, i) => c.name.toLowerCase() === g.desired[i]!.name.toLowerCase() && unchanged(g.desired[i]!));
    if (same) {
      result.unchanged += g.desired.length;
      continue;
    }
    for (const c of g.current) {
      if (!g.desired.some((d) => d.name.toLowerCase() === c.name.toLowerCase())) await dropOne(c);
    }
    for (const d of g.desired) await attempt(d);
  }

  for (const r of ordering.filter((o) => o.kind === "EVENT")) {
    if (unchanged(r)) result.unchanged++;
    else await attempt(r);
  }

  const lateExtras = current.filter((r) => r.kind !== "VIEW" && isExtra(r) && !(r.kind === "TRIGGER" && groups.has(triggerGroup(r))));
  for (const r of ordered(lateExtras, EXTRA_DROP_ORDER)) await dropOne(r);

  for (const f of result.failures) result.warnings.push(`could not re-create ${f.kind.toLowerCase()} ${f.name}: ${f.explanation ?? f.error}`);
  return result;
}

export function definerResolver(
  policy: DefinerPolicy,
  existing: Set<string>,
  warnings: string[],
): (r: CodeRecord) => Account {
  const account = policy.account ?? null;
  const keep = policy.keep ?? "recorded";
  const cache = new Map<string, Account>();
  return (r: CodeRecord) => {
    const key = recordKey(r.kind, r.name);
    const cached = cache.get(key);
    if (cached) return cached;
    let chosen: Account;
    const recorded = r.definer;
    if (keep === "account") {
      if (!account) throw new Error("no account was given to define code objects");
      chosen = account;
    } else if (recorded && existing.has(accountKey(recorded))) {
      chosen = recorded;
    } else if (account) {
      chosen = account;
      warnings.push(
        `${r.kind.toLowerCase()} ${r.name} was defined by ${recorded ? `${recorded.user}@${recorded.host}` : "an unknown account"}, which does not exist here; it is now defined by ${account.user}@${account.host}`,
      );
    } else if (recorded) {
      chosen = recorded;
      warnings.push(`${r.kind.toLowerCase()} ${r.name} is defined by ${recorded.user}@${recorded.host}, which does not exist`);
    } else {
      throw new Error(`${r.kind.toLowerCase()} ${r.name} has no definer and no account was given`);
    }
    cache.set(key, chosen);
    return chosen;
  };
}

function mergeDesired(current: CodeRecord[], given: CodeRecord[]): CodeRecord[] {
  const givenByKey = new Map(given.map((r) => [recordKey(r.kind, r.name), r]));
  const out = current.map((c) => givenByKey.get(recordKey(c.kind, c.name)) ?? c);
  const known = new Set(current.map((c) => recordKey(c.kind, c.name)));
  for (const g of given) if (!known.has(recordKey(g.kind, g.name))) out.push(g);
  return out;
}

export async function applyCodeRecords(schema: string, records: CodeRecord[], opts: ApplyCodeOptions = {}): Promise<CodeApplyResult> {
  assertCodeSchema(schema);
  const deadline = Date.now() + (opts.timeoutMs ?? DEFAULT_CODE_TIMEOUT_MS);
  const policy: DefinerPolicy = { account: opts.definers?.account ?? ownAccountOf(schema), keep: opts.definers?.keep ?? "recorded" };
  return withScopedAccount({ schemas: [schema], setUser: true }, async (account) => {
    const session = await CodeSession.open(account.target, schema, { lockWaitTimeoutSec: opts.lockWaitTimeoutSec, deadline });
    try {
      const current = await captureCodeRecords(session.conn, schema);
      const warnings: string[] = [];
      const existing = await withAdmin((c) => existingAccounts(c));
      const keepKinds = new Set(opts.keepKinds ?? []);
      const kinds = ALL_KINDS.filter((k) => !keepKinds.has(k));
      const given = records.filter((r) => kinds.includes(r.kind));
      const desired = opts.replace ? given : mergeDesired(current, given);
      const definerFor = definerResolver(policy, existing, warnings);
      const currentDefiners = new Map(current.map((c) => [recordKey(c.kind, c.name), c]));
      const result = await reconcileCode({
        session,
        current,
        desired,
        kinds,
        dropExtras: opts.replace === true,
        definerFor: (r) => {
          if (!opts.replace && !given.includes(r)) {
            const c = currentDefiners.get(recordKey(r.kind, r.name));
            if (c?.definer) return c.definer;
          }
          return definerFor(r);
        },
      });
      result.warnings.unshift(...warnings);
      return result;
    } finally {
      await session.close();
    }
  });
}

async function withAdmin<T>(fn: (c: Connection) => Promise<T>): Promise<T> {
  const conn = await openAdminConnection();
  try {
    return await fn(conn);
  } finally {
    await conn.end().catch(() => conn.destroy());
  }
}

export async function existingAccountKeys(): Promise<Set<string>> {
  return withAdmin((c) => existingAccounts(c));
}

export async function objectsWithMissingDefiner(schema: string): Promise<string[]> {
  assertCodeSchema(schema);
  return withAdmin(async (c) => {
    const [rows] = await c.query<RowDataPacket[]>(
      `SELECT o.name, o.kind FROM (
         SELECT 'VIEW' AS kind, TABLE_NAME AS name, DEFINER AS definer FROM information_schema.VIEWS WHERE TABLE_SCHEMA = ?
         UNION ALL SELECT ROUTINE_TYPE, ROUTINE_NAME, DEFINER FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA = ?
         UNION ALL SELECT 'TRIGGER', TRIGGER_NAME, DEFINER FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = ?
         UNION ALL SELECT 'EVENT', EVENT_NAME, DEFINER FROM information_schema.EVENTS WHERE EVENT_SCHEMA = ?
       ) o
       WHERE NOT EXISTS (SELECT 1 FROM mysql.user u WHERE CONCAT(u.User, '@', u.Host) = o.definer)
       ORDER BY o.kind, o.name`,
      [schema, schema, schema, schema],
    );
    return rows.map((r) => `${String(r.kind)}:${String(r.name)}`);
  });
}

export async function objectsDefinedBy(schema: string, user: string, exceptHost?: string): Promise<number> {
  assertCodeSchema(schema);
  return withAdmin(async (conn) => {
    const [rows] = await conn.query<RowDataPacket[]>(
      `SELECT COUNT(*) AS n FROM (
         SELECT DEFINER AS definer FROM information_schema.VIEWS WHERE TABLE_SCHEMA = ?
         UNION ALL SELECT DEFINER FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA = ?
         UNION ALL SELECT DEFINER FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = ?
         UNION ALL SELECT DEFINER FROM information_schema.EVENTS WHERE EVENT_SCHEMA = ?
       ) o
       WHERE SUBSTRING_INDEX(o.definer, '@', 1) = ? AND (? IS NULL OR o.definer <> CONCAT(?, '@', ?))`,
      [schema, schema, schema, schema, user, exceptHost ?? null, user, exceptHost ?? null],
    );
    return Number(rows[0]?.n ?? 0);
  });
}
