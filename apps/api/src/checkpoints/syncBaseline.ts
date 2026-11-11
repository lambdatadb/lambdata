import { syncBaselines, type BaselineTable, type SyncBaseline } from "../db/queries";
import { renderCodeRecords, type CodeRecord } from "../mariadb/codeObjects";
import { captureLiveCode, collectLiveStats } from "./capture";
import { sha256Hex } from "./store";
import type { TableStats } from "./tables";

const DEFINER_CLAUSE = /\bDEFINER\s*=\s*(?:`(?:[^`]|``)*`|'(?:[^']|'')*'|[^\s@]+)@(?:`(?:[^`]|``)*`|'(?:[^']|'')*'|\S+)\s*/gi;
const UNVERIFIED_PREFIX = "unverified:";

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function baselineTables(stats: TableStats[]): BaselineTable[] {
  return stats
    .map((t) => ({
      name: t.name,
      rowCount: t.rowCount,
      checksum: t.checksum,
      schemaHash: t.schemaHash,
      autoIncrement: t.autoIncrement ?? null,
    }))
    .sort((a, b) => compare(a.name, b.name));
}

export function sameTables(a: BaselineTable[], b: BaselineTable[]): boolean {
  if (a.length !== b.length) return false;
  const byName = new Map(b.map((t) => [t.name, t]));
  for (const t of a) {
    const o = byName.get(t.name);
    if (!o) return false;
    if (t.checksum === null || o.checksum === null || t.rowCount === null || o.rowCount === null) return false;
    if (t.checksum !== o.checksum || t.rowCount !== o.rowCount) return false;
    if (t.schemaHash === null || t.schemaHash !== o.schemaHash) return false;
    if ((t.autoIncrement ?? null) !== (o.autoIncrement ?? null)) return false;
  }
  return true;
}

export function matchesBaseline(baseline: SyncBaseline | null, tables: TableStats[], codeHash: string | null): boolean {
  if (!baseline) return false;
  if (baseline.codeHash !== null && baseline.codeHash.startsWith(UNVERIFIED_PREFIX)) return false;
  if (baseline.codeHash !== codeHash) return false;
  return sameTables(baselineTables(tables), baseline.tables);
}

export function matchesLastSync(databaseId: string, tables: TableStats[], codeHash: string | null): boolean {
  return matchesBaseline(syncBaselines.get(databaseId), tables, codeHash);
}

export async function deliveredTables(staging: string): Promise<BaselineTable[]> {
  return baselineTables((await collectLiveStats(staging, false)).tables);
}

function codeKey(r: { kind: string; name: string }): string {
  return r.kind === "VIEW" ? `${r.kind}\u0000${r.name}` : `${r.kind}\u0000${r.name.toLowerCase()}`;
}

function shapeOf(records: CodeRecord[]): string[] {
  return records.map((r) => `${codeKey(r)}\u0000${r.createSql.replace(DEFINER_CLAUSE, "")}`).sort(compare);
}

export function codeHashOf(records: CodeRecord[]): string | null {
  return records.length > 0 ? sha256Hex(renderCodeRecords(records)) : null;
}

export async function deliveredCodeHash(live: string, delivered: CodeRecord[], failed: { kind: string; name: string }[]): Promise<string | null> {
  const skipped = new Set(failed.map(codeKey));
  const expected = shapeOf(delivered.filter((r) => !skipped.has(codeKey(r))));
  const present = await captureLiveCode(live);
  const actual = shapeOf(present);
  if (expected.length === actual.length && expected.every((s, i) => s === actual[i])) return codeHashOf(present);
  return `${UNVERIFIED_PREFIX}${Date.now()}`;
}

export function recordBaseline(databaseId: string, tables: BaselineTable[], codeHash: string | null): void {
  syncBaselines.set(databaseId, { tables, codeHash, recordedAt: Date.now() });
}

export function dropBaseline(databaseId: string): void {
  syncBaselines.remove(databaseId);
}
