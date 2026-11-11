import type { RowChangeNetReason, SyncChangeSummary, TableRowChange } from "@lambdata/shared";
import { Badge } from "../ui/Badge";
import { cn } from "../ui/cn";

const REASON_TEXT: Record<RowChangeNetReason, string | null> = {
  new: null,
  removed: null,
  "no-key": "no primary key, so only the row count is compared",
  structure: "structure changed, so only the row count is compared",
  "too-large": "too large to compare row by row",
  time: "the time for comparing rows ran out during this sync",
  unsupported: "this kind of table is not compared row by row",
  off: "row-by-row comparison is turned off",
};

function n(v: number | null | undefined): string {
  return typeof v === "number" && Number.isFinite(v) ? v.toLocaleString("en-US") : "?";
}

function rows(v: number): string {
  return `${n(v)} ${v === 1 ? "row" : "rows"}`;
}

function tables(v: number): string {
  return `${n(v)} ${v === 1 ? "table" : "tables"}`;
}

function signed(v: number): string {
  return `${v > 0 ? "+" : v < 0 ? "−" : ""}${Math.abs(v).toLocaleString("en-US")}`;
}

export function readSyncChanges(value: unknown): SyncChangeSummary | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const v = value as Partial<SyncChangeSummary>;
  if (typeof v.tablesChanged !== "number" || !Array.isArray(v.tables)) return null;
  return value as SyncChangeSummary;
}

export function netReason(t: TableRowChange): string | null {
  if (t.method !== "net" || t.change !== "modified") return null;
  const raw: unknown = t.reason;
  if (typeof raw === "string" && Object.hasOwn(REASON_TEXT, raw)) return REASON_TEXT[raw as RowChangeNetReason];
  return t.schemaChanged ? REASON_TEXT.structure : "only the row count is compared";
}

function exactTotal(s: SyncChangeSummary): string | null {
  if (s.rowsAdded === null || s.rowsRemoved === null || s.rowsChanged === null) return null;
  if (s.rowsAdded + s.rowsRemoved + s.rowsChanged === 0) return null;
  return `${rows(s.rowsAdded)} added, ${n(s.rowsRemoved)} removed, ${n(s.rowsChanged)} changed`;
}

function netTotal(s: SyncChangeSummary): string | null {
  if (s.rowDelta === null || s.rowDelta === 0) return null;
  return `${signed(s.rowDelta)} ${Math.abs(s.rowDelta) === 1 ? "row" : "rows"} in all`;
}

export function notComparedText(s: SyncChangeSummary): string | null {
  const count = s.tablesNotCompared ?? 0;
  if (count <= 0) return null;
  return `${n(count)} ${count === 1 ? "table was" : "tables were"} not compared because the sync's time limit for comparing was reached.`;
}

export function changeHeadline(s: SyncChangeSummary): string {
  if (s.tablesChanged === 0) return (s.tablesNotCompared ?? 0) > 0 ? "No changes in the tables that were compared" : "Nothing changed";
  const totals = exactTotal(s) ?? netTotal(s);
  return `${tables(s.tablesChanged)} changed${totals ? `: ${totals}` : ""}`;
}

export function tableChangeText(t: TableRowChange): string {
  if (t.change === "added") return t.rowsAfter === null ? "new table" : `new table, ${rows(t.rowsAfter)}`;
  if (t.change === "removed") return t.rowsBefore === null ? "removed" : `removed, had ${rows(t.rowsBefore)}`;
  if (t.method === "exact" && t.added !== null && t.removed !== null && t.changed !== null) {
    if (t.added + t.removed + t.changed === 0) return "structure changed, rows the same";
    return `${n(t.added)} added, ${n(t.removed)} removed, ${n(t.changed)} changed`;
  }
  return `${n(t.rowsBefore)} → ${n(t.rowsAfter)} rows`;
}

export function SyncChanges({ changes, className }: { changes: SyncChangeSummary | null | undefined; className?: string }) {
  if (changes === undefined) return null;
  if (changes === null) {
    return (
      <p className={cn("text-label text-text-subtle", className)} data-sync-changes="unknown">
        What this sync changed was not measured.
      </p>
    );
  }
  const skipped = notComparedText(changes);
  if (changes.tablesChanged === 0) {
    return (
      <p className={cn("text-label text-text-muted", className)} data-sync-changes={skipped ? "partial" : "none"}>
        {skipped
          ? `No changes in the ${tables(changes.tablesUnchanged)} that were compared. ${skipped}`
          : `Nothing changed${changes.tablesUnchanged > 0 ? ` in ${tables(changes.tablesUnchanged)}` : ""}.`}
      </p>
    );
  }
  const more = changes.tablesChanged - changes.tables.length;
  return (
    <div className={cn("space-y-2", className)} data-sync-changes="changed">
      <p className="text-label text-text">
        {changeHeadline(changes)}.
        {changes.tablesUnchanged > 0 && <span className="text-text-muted"> {tables(changes.tablesUnchanged)} unchanged.</span>}
      </p>
      <ul className="divide-y divide-border rounded-md border border-border bg-bg-inset" aria-label="Changed tables">
        {changes.tables.map((t) => {
          const hint = netReason(t);
          return (
            <li key={`${t.change}:${t.name}`} className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 px-3 py-1.5 text-label" data-table-change={t.method}>
              <span className="min-w-0 max-w-full truncate font-mono text-code text-text" title={t.name}>
                {t.name}
              </span>
              <span className="tabular-nums text-text-muted">{tableChangeText(t)}</span>
              {t.schemaChanged && t.change === "modified" && t.method === "exact" && (
                <Badge variant="muted" size="sm">
                  structure changed
                </Badge>
              )}
              {hint && <span className="basis-full text-micro text-text-subtle">Net: {hint}.</span>}
            </li>
          );
        })}
      </ul>
      {more > 0 && <p className="text-label text-text-muted">and {n(more)} more {more === 1 ? "table" : "tables"}.</p>}
      {skipped && <p className="text-label text-warn">{skipped}</p>}
    </div>
  );
}
