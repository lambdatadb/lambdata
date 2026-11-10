import { Code2 } from "lucide-react";
import type { CheckpointDiff, CheckpointTableDiff } from "@lambdata/shared";
import { Badge } from "../ui/Badge";
import { cn } from "../ui/cn";
import { formatNumber, pluralize } from "../../lib/format";
import { signed } from "./meta";

const MARK: Record<CheckpointTableDiff["change"], { letter: string; tone: string; label: string }> = {
  added: { letter: "A", tone: "text-success", label: "added" },
  modified: { letter: "M", tone: "text-warn", label: "modified" },
  removed: { letter: "D", tone: "text-danger", label: "removed" },
};

function rows(n: number | null): string {
  return n === null ? "—" : formatNumber(n);
}

export interface DiffListProps {
  diff: CheckpointDiff;
  emptyLabel?: string;
  dense?: boolean;
  className?: string;
  direction?: "forward" | "rollback";
}

export function DiffList({ diff, emptyLabel = "No differences", dense = false, className, direction = "forward" }: DiffListProps) {
  const nothing = diff.tables.length === 0 && !diff.codeChanged;
  if (nothing) {
    return (
      <p className={cn("text-label text-text-muted", className)}>
        {emptyLabel}
        {diff.unchangedTables > 0 && ` · ${pluralize(diff.unchangedTables, "table")} identical`}
      </p>
    );
  }
  return (
    <div className={cn("min-w-0", className)}>
      <ul className="divide-y divide-border/70 overflow-hidden rounded-md border border-border bg-bg-inset">
        {diff.tables.map((t) => {
          const view = direction === "rollback" ? invert(t) : t;
          const mark = MARK[view.change];
          const delta = view.rowsBefore !== null && view.rowsAfter !== null ? view.rowsAfter - view.rowsBefore : null;
          return (
            <li
              key={t.name}
              className={cn("flex min-w-0 items-center gap-3 px-3 font-mono text-code", dense ? "py-1.5" : "py-2")}
            >
              <span className={cn("w-3 shrink-0 font-semibold", mark.tone)} title={mark.label}>
                {mark.letter}
                <span className="sr-only"> {mark.label}</span>
              </span>
              <span className="min-w-0 flex-1 truncate text-text" title={t.name}>
                {t.name}
              </span>
              {view.schemaChanged && view.change === "modified" && (
                <Badge variant="muted" size="sm" className="hidden font-sans sm:inline-flex">
                  schema
                </Badge>
              )}
              <span className="hidden shrink-0 tabular-nums text-text-subtle sm:inline">
                {rows(view.rowsBefore)} → {rows(view.rowsAfter)}
              </span>
              <span
                className={cn(
                  "w-16 shrink-0 text-right tabular-nums",
                  delta === null ? "text-text-subtle" : delta > 0 ? "text-success" : delta < 0 ? "text-danger" : "text-text-subtle",
                )}
              >
                {delta === null ? (view.change === "added" ? `+${rows(view.rowsAfter)}` : view.change === "removed" ? `−${rows(view.rowsBefore)}` : "—") : signed(delta)}
              </span>
            </li>
          );
        })}
        {diff.codeChanged && (
          <li className={cn("flex items-center gap-3 px-3 text-label text-text-muted", dense ? "py-1.5" : "py-2")}>
            <Code2 aria-hidden className="size-3.5 shrink-0 text-warn" />
            Views, triggers, routines or events differ
          </li>
        )}
      </ul>
      {diff.unchangedTables > 0 && (
        <p className="mt-1.5 text-micro text-text-subtle">
          {pluralize(diff.unchangedTables, "other table")} identical
        </p>
      )}
    </div>
  );
}

function invert(t: CheckpointTableDiff): CheckpointTableDiff {
  return {
    name: t.name,
    change: t.change === "added" ? "removed" : t.change === "removed" ? "added" : "modified",
    schemaChanged: t.schemaChanged,
    rowsBefore: t.rowsAfter,
    rowsAfter: t.rowsBefore,
  };
}
