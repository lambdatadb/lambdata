import type {
  ImportColumnPlan,
  ImportPlan,
  ImportSkippedObject,
  ImportTablePlan,
  ImportUpload,
  SqliteStorageClass,
} from "@lambdata/shared";
import { formatBytes, formatNumber } from "../../lib/format";

const EXTENSIONS = /(\.sql\.gz|\.sqlite3|\.sqlite|\.db3|\.db|\.sql|\.gz|\.dump|\.bak)+$/i;

export function displayNameFromFile(fileName: string): string {
  const base = fileName.replace(EXTENSIONS, "").replace(/[_\-.]+/g, " ").replace(/\s+/g, " ").trim();
  const name = (base || fileName).slice(0, 200);
  return name.length > 3 && name === name.toLowerCase() ? name.charAt(0).toUpperCase() + name.slice(1) : name;
}

export function formatLabel(upload: Pick<ImportUpload, "format">, plan?: ImportPlan | null): string {
  if (upload.format === "sqlite") return "SQLite 3 database";
  if (plan && plan.format === "sql" && plan.compressed) return "MySQL/MariaDB dump, gzip-compressed";
  return "MySQL/MariaDB dump";
}

export function shortHash(sha256: string): string {
  return sha256.slice(0, 12);
}

export function formatRate(bytesPerSecond: number | null): string | null {
  if (bytesPerSecond == null || !Number.isFinite(bytesPerSecond) || bytesPerSecond <= 0) return null;
  return `${formatBytes(bytesPerSecond)}/s`;
}

export function formatEta(seconds: number | null): string | null {
  if (seconds == null || !Number.isFinite(seconds) || seconds < 0) return null;
  if (seconds < 1.5) return "about a second left";
  if (seconds < 60) return `about ${Math.round(seconds)} s left`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `about ${minutes} min left`;
  const hours = Math.floor(minutes / 60);
  return `about ${hours} h ${minutes % 60} min left`;
}

const CLASS_ORDER: SqliteStorageClass[] = ["integer", "real", "text", "blob", "null"];

export function observedParts(column: ImportColumnPlan): { cls: SqliteStorageClass; count: number }[] {
  return CLASS_ORDER.map((cls) => ({ cls, count: column.observed[cls] ?? 0 }))
    .filter((p) => p.count > 0)
    .sort((a, b) => (a.cls === "null" ? 1 : b.cls === "null" ? -1 : b.count - a.count));
}

export function observedSummary(column: ImportColumnPlan): string {
  const parts = observedParts(column);
  if (parts.length === 0) return "empty";
  const values = parts.filter((p) => p.cls !== "null");
  if (values.length === 0) return "all NULL";
  return parts.map((p) => `${p.cls} ${formatNumber(p.count)}`).join(" · ");
}

export function maxLengthLabel(column: ImportColumnPlan): string | null {
  if (column.maxLength == null) return null;
  const textual = (column.observed.text ?? 0) > 0;
  return textual ? `longest ${formatNumber(column.maxLength)} ch` : `largest ${formatBytes(column.maxLength)}`;
}

export function splitType(mariadbType: string): { base: string; collation: string | null } {
  const match = /^(.*?)\s+COLLATE\s+(\S+)\s*$/i.exec(mariadbType);
  if (!match) return { base: mariadbType, collation: null };
  return { base: match[1]!, collation: match[2]! };
}

export function skippedKeyReasons(table: ImportTablePlan): string[] {
  return [
    ...table.indexes.map((i) => i.skippedReason),
    ...table.foreignKeys.map((f) => f.skippedReason),
  ].filter((r): r is string => !!r);
}

export function generalWarnings(table: ImportTablePlan): string[] {
  const reasons = skippedKeyReasons(table);
  return table.warnings.filter((w) => !reasons.some((r) => w.includes(r)));
}

export const SKIPPED_KIND_LABEL: Record<ImportSkippedObject["kind"], string> = {
  view: "View",
  trigger: "Trigger",
  "virtual-table": "Virtual table",
  internal: "SQLite internal",
};

const STORAGE_OF = /^Storage table of the virtual table (.+?)\.?$/;

export interface SkippedGroup {
  item: ImportSkippedObject;
  storage: ImportSkippedObject[];
}

export function groupSkipped(skipped: ImportSkippedObject[]): SkippedGroup[] {
  const owners = new Set(skipped.filter((s) => s.kind === "virtual-table").map((s) => s.name));
  const ownerOf = (s: ImportSkippedObject): string | null => {
    if (s.kind !== "virtual-table") return null;
    const owner = STORAGE_OF.exec(s.reason)?.[1] ?? null;
    return owner && owner !== s.name && owners.has(owner) ? owner : null;
  };
  const groups: SkippedGroup[] = [];
  const byName = new Map<string, SkippedGroup>();
  for (const s of skipped) {
    if (ownerOf(s)) continue;
    const group = { item: s, storage: [] };
    groups.push(group);
    if (s.kind === "virtual-table") byName.set(s.name, group);
  }
  for (const s of skipped) {
    const owner = ownerOf(s);
    if (owner) byName.get(owner)?.storage.push(s);
  }
  const rank = (g: SkippedGroup) => (g.item.kind === "internal" ? 1 : 0);
  return groups.sort((a, b) => rank(a) - rank(b));
}

export function countSkipped(skipped: ImportSkippedObject[]): number {
  return groupSkipped(skipped).filter((g) => g.item.kind !== "internal").length;
}

export function sentence(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return trimmed;
  const capital = trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
  return /[.!?]$/.test(capital) ? capital : `${capital}.`;
}
