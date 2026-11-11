import type { RowChangeNetReason, SyncChangeSummary, TableRowChange } from "@lambdata/shared";
import { count } from "./emit";
import { cleanUserText } from "./format";

export const MESSAGE_TABLES = 5;
export const PAYLOAD_TABLES = 20;

const REASONS: readonly RowChangeNetReason[] = ["new", "removed", "no-key", "structure", "too-large", "time", "unsupported", "off"];

export interface SyncChangeText {
  text: string;
  changedField: string | null;
  rowsField: string | null;
}

function isObj(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function n(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function table(v: unknown): TableRowChange | null {
  if (!isObj(v) || typeof v.name !== "string") return null;
  const change = v.change === "added" || v.change === "removed" || v.change === "modified" ? v.change : null;
  if (!change) return null;
  const reason = REASONS.find((r) => r === v.reason);
  return {
    name: v.name,
    change,
    method: v.method === "exact" ? "exact" : "net",
    schemaChanged: v.schemaChanged === true,
    rowsBefore: n(v.rowsBefore),
    rowsAfter: n(v.rowsAfter),
    added: n(v.added),
    removed: n(v.removed),
    changed: n(v.changed),
    ...(reason ? { reason } : {}),
  };
}

export function readSyncChanges(raw: unknown): SyncChangeSummary | null {
  if (!isObj(raw)) return null;
  const tablesChanged = n(raw.tablesChanged);
  if (tablesChanged === null) return null;
  const tables = Array.isArray(raw.tables) ? raw.tables.map(table).filter((t): t is TableRowChange => t !== null) : [];
  return {
    tablesChanged,
    tablesUnchanged: n(raw.tablesUnchanged) ?? 0,
    exactTables: n(raw.exactTables) ?? 0,
    netTables: n(raw.netTables) ?? 0,
    rowsAdded: n(raw.rowsAdded),
    rowsRemoved: n(raw.rowsRemoved),
    rowsChanged: n(raw.rowsChanged),
    rowDelta: n(raw.rowDelta),
    tables,
    truncated: raw.truncated === true,
    tablesNotCompared: Math.max(0, n(raw.tablesNotCompared) ?? 0),
  };
}

export function notComparedSentence(count: number): string {
  return `${count.toLocaleString("en-US")} ${count === 1 ? "table was" : "tables were"} not compared because the sync's time limit for comparing was reached.`;
}

function fmt(v: number | null): string {
  return v === null ? "?" : v.toLocaleString("en-US");
}

function signed(v: number): string {
  return `${v > 0 ? "+" : v < 0 ? "-" : ""}${Math.abs(v).toLocaleString("en-US")}`;
}

function nameOf(t: TableRowChange): string {
  return cleanUserText(t.name, 64) || "(unnamed table)";
}

export function tableLine(t: TableRowChange): string {
  const name = nameOf(t);
  if (t.change === "added") return `${name}: new table, ${t.rowsAfter === null ? "rows unknown" : count(t.rowsAfter, "row")}`;
  if (t.change === "removed") return `${name}: removed${t.rowsBefore === null ? "" : ` (had ${count(t.rowsBefore, "row")})`}`;
  const structure = t.schemaChanged ? " (structure changed)" : "";
  if (t.method === "exact" && t.added !== null && t.removed !== null && t.changed !== null) {
    if (t.added + t.removed + t.changed === 0) return `${name}: structure changed, rows the same`;
    return `${name}: ${fmt(t.added)} added, ${fmt(t.removed)} removed, ${fmt(t.changed)} changed${structure}`;
  }
  return `${name}: ${fmt(t.rowsBefore)} → ${fmt(t.rowsAfter)} rows${structure}`;
}

function exactTotals(s: SyncChangeSummary): string | null {
  if (s.rowsAdded === null || s.rowsRemoved === null || s.rowsChanged === null) return null;
  if (s.rowsAdded + s.rowsRemoved + s.rowsChanged === 0) return null;
  return `${count(s.rowsAdded, "row")} added, ${fmt(s.rowsRemoved)} removed, ${fmt(s.rowsChanged)} changed`;
}

function netTotal(s: SyncChangeSummary): string | null {
  if (s.rowDelta === null || s.rowDelta === 0) return null;
  return `${signed(s.rowDelta)} ${Math.abs(s.rowDelta) === 1 ? "row" : "rows"} in all`;
}

export function describeSyncChanges(raw: unknown): SyncChangeText {
  const s = readSyncChanges(raw);
  if (!s) return { text: "", changedField: null, rowsField: null };
  const notCompared = s.tablesNotCompared ?? 0;
  const tail = notCompared > 0 ? notComparedSentence(notCompared) : "";
  if (s.tablesChanged === 0) {
    if (notCompared > 0) return { text: `No changes in the tables that were compared. ${tail}`, changedField: "None found", rowsField: null };
    return { text: "Nothing changed.", changedField: "Nothing", rowsField: null };
  }
  const totals = exactTotals(s) ?? netTotal(s);
  const head = `${count(s.tablesChanged, "table")} changed${totals ? `: ${totals}` : ""}.`;
  const shown = s.tables.slice(0, MESSAGE_TABLES);
  const lines = shown.map((t) => `\n• ${tableLine(t)}`);
  const more = s.tablesChanged - shown.length;
  return {
    text: `${head}${lines.join("")}${more > 0 ? `\nand ${more.toLocaleString("en-US")} more.` : ""}${tail ? `\n${tail}` : ""}`,
    changedField: count(s.tablesChanged, "table"),
    rowsField: totals,
  };
}

export function syncUnchanged(raw: unknown): boolean {
  const s = readSyncChanges(raw);
  return s !== null && s.tablesChanged === 0 && (s.tablesNotCompared ?? 0) === 0;
}

export function syncChangeData(raw: unknown): Record<string, string | number | boolean | null> {
  const s = readSyncChanges(raw);
  if (!s) return { changesMeasured: false };
  return {
    changesMeasured: true,
    tablesChanged: s.tablesChanged,
    tablesUnchanged: s.tablesUnchanged,
    rowsAdded: s.rowsAdded,
    rowsRemoved: s.rowsRemoved,
    rowsChanged: s.rowsChanged,
    rowDelta: s.rowDelta,
    tablesNotCompared: s.tablesNotCompared ?? 0,
  };
}

export function syncChangeList(raw: unknown): { tables: TableRowChange[]; truncated: boolean } | null {
  const s = readSyncChanges(raw);
  if (!s) return null;
  const tables = s.tables.slice(0, PAYLOAD_TABLES).map((t) => ({ ...t, name: nameOf(t) }));
  return { tables, truncated: s.truncated || s.tablesChanged > tables.length };
}
