import { useId, useMemo, useState, type ReactNode } from "react";
import { ChevronRight, ChevronsDownUp, ChevronsUpDown, Code2, Search, TriangleAlert } from "lucide-react";
import type {
  ImportColumnPlan,
  ImportIndexPlan,
  ImportPlan,
  ImportSkippedObject,
  ImportTablePlan,
  SqlImportPlan,
  SqliteImportPlan,
} from "@lambdata/shared";
import { Badge } from "../ui/Badge";
import { Button } from "../ui/Button";
import { CodeBlock } from "../ui/CodeBlock";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "../ui/Collapsible";
import { DescriptionItem, DescriptionList } from "../ui/DescriptionList";
import { Input } from "../ui/Input";
import { cn } from "../ui/cn";
import { focusRingInset } from "../ui/styles";
import { formatBytes, formatDate, formatNumber, formatRelativeTime, pluralize } from "../../lib/format";
import {
  SKIPPED_KIND_LABEL,
  countSkipped,
  groupSkipped,
  generalWarnings,
  maxLengthLabel,
  observedSummary,
  splitType,
} from "./format";

export type PlanMode = "create" | "replace";

export interface PlanReviewProps {
  plan: ImportPlan;
  mode: PlanMode;
  targetLabel?: ReactNode;
  className?: string;
}

const FILTER_THRESHOLD = 12;

export function PlanReview({ plan, mode, targetLabel, className }: PlanReviewProps) {
  if (plan.format === "sql") return <SqlPlanReview plan={plan} mode={mode} targetLabel={targetLabel} className={className} />;
  return <SqlitePlanReview plan={plan} mode={mode} className={className} />;
}

function Dot({ className }: { className?: string }) {
  return <span aria-hidden className={cn("inline-block size-1.5 shrink-0 rounded-full", className)} />;
}

function Fact({ value, label }: { value: ReactNode; label: ReactNode }) {
  return (
    <span className="whitespace-nowrap">
      <span className="font-mono tabular-nums text-text">{value}</span> <span className="text-text-muted">{label}</span>
    </span>
  );
}

function SqlitePlanReview({ plan, mode, className }: { plan: SqliteImportPlan; mode: PlanMode; className?: string }) {
  const headingId = useId();
  const [open, setOpen] = useState<Set<string>>(() => new Set());
  const [filter, setFilter] = useState("");
  const skippedCount = countSkipped(plan.skipped);
  const tablesWithWarnings = plan.tables.filter((t) => t.warnings.length > 0).length;
  const query = filter.trim().toLowerCase();
  const visible = useMemo(
    () =>
      query
        ? plan.tables.filter((t) => t.targetName.toLowerCase().includes(query) || t.sourceName.toLowerCase().includes(query))
        : plan.tables,
    [plan.tables, query],
  );
  const allOpen = visible.length > 0 && visible.every((t) => open.has(t.sourceName));

  const toggle = (name: string, next: boolean) =>
    setOpen((prev) => {
      const copy = new Set(prev);
      if (next) copy.add(name);
      else copy.delete(name);
      return copy;
    });

  const toggleAll = () =>
    setOpen((prev) => {
      const copy = new Set(prev);
      for (const t of visible) {
        if (allOpen) copy.delete(t.sourceName);
        else copy.add(t.sourceName);
      }
      return copy;
    });

  return (
    <section aria-labelledby={headingId} className={cn("min-w-0 space-y-4", className)}>
      <div className="flex flex-wrap items-end justify-between gap-x-4 gap-y-3">
        <div className="min-w-0 flex-[1_1_20rem] space-y-1">
          <h3 id={headingId} className="text-heading font-semibold text-text">
            Migration plan
          </h3>
          <p className="flex flex-wrap items-center gap-x-4 gap-y-1 text-body sm:gap-x-2.5">
            <Fact value={formatNumber(plan.totals.tables)} label={plan.totals.tables === 1 ? "table" : "tables"} />
            <span aria-hidden className="hidden text-text-subtle sm:inline">·</span>
            <Fact value={formatNumber(plan.totals.rows)} label={plan.totals.rows === 1 ? "row" : "rows"} />
            <span aria-hidden className="hidden text-text-subtle sm:inline">·</span>
            {plan.totals.warnings > 0 ? (
              <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
                <Dot className="bg-warn" />
                <Fact value={formatNumber(plan.totals.warnings)} label={plan.totals.warnings === 1 ? "warning" : "warnings"} />
              </span>
            ) : (
              <span className="text-text-muted">no warnings</span>
            )}
            {skippedCount > 0 && (
              <>
                <span aria-hidden className="hidden text-text-subtle sm:inline">·</span>
                <Fact value={formatNumber(skippedCount)} label="not copied" />
              </>
            )}
          </p>
        </div>
        {plan.tables.length > 0 && (
          <div className="flex w-full items-center gap-2 sm:w-auto">
            {plan.tables.length > FILTER_THRESHOLD && (
              <Input
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                placeholder="Filter tables"
                aria-label="Filter tables"
                inputSize="sm"
                leading={<Search aria-hidden />}
                wrapperClassName="min-w-0 flex-1 sm:w-48 sm:flex-none"
              />
            )}
            <Button
              size="sm"
              variant="ghost"
              onClick={toggleAll}
              disabled={visible.length === 0}
              className={cn("shrink-0", plan.tables.length <= FILTER_THRESHOLD && "-ml-3 sm:ml-0")}
            >
              {allOpen ? <ChevronsDownUp /> : <ChevronsUpDown />}
              {allOpen ? "Collapse all" : "Expand all"}
            </Button>
          </div>
        )}
      </div>

      <p className="max-w-3xl text-label text-text-muted">
        Each SQLite table becomes one MariaDB table. SQLite types are only hints, so every column&apos;s type was chosen from the
        values it actually holds, and every judgement call is noted. Nothing is created until you{" "}
        {mode === "create" ? "create the database" : "confirm the replacement"}.
        {tablesWithWarnings > 0 && ` ${pluralize(tablesWithWarnings, "table has", "tables have")} warnings worth a read.`}
      </p>

      {plan.warnings.length > 0 && <NoteList items={plan.warnings} tone="warn" />}

      {plan.tables.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border-strong px-4 py-8 text-center text-body text-text-muted">
          This file has no tables to import.
        </div>
      ) : (
        <div className="overflow-hidden rounded-lg border border-border bg-bg-panel">
          <div
            aria-hidden
            className="hidden h-8 grid-cols-[1rem_minmax(0,1fr)_5.5rem_7.5rem_7.5rem] items-center gap-x-3 border-b border-border bg-bg-raised/40 px-3 text-label text-text-subtle sm:grid"
          >
            <span />
            <span>Table</span>
            <span className="text-right">Columns</span>
            <span className="text-right">Rows</span>
            <span>Warnings</span>
          </div>
          <ul className="divide-y divide-border">
            {visible.map((table) => (
              <TableRow
                key={table.sourceName}
                table={table}
                open={open.has(table.sourceName)}
                onOpenChange={(next) => toggle(table.sourceName, next)}
              />
            ))}
          </ul>
          {visible.length === 0 && (
            <div className="px-4 py-6 text-center text-body text-text-muted">No table names contain &ldquo;{filter.trim()}&rdquo;.</div>
          )}
        </div>
      )}

      {plan.skipped.length > 0 && <SkippedList items={plan.skipped} />}
    </section>
  );
}

function NoteList({ items, tone }: { items: string[]; tone: "warn" | "note" }) {
  return (
    <ul className="space-y-1.5">
      {items.map((item, i) => (
        <li key={i} className="flex gap-2 text-label text-text-muted">
          {tone === "warn" ? (
            <TriangleAlert aria-label="Warning" className="mt-px size-3.5 shrink-0 text-warn" />
          ) : (
            <span aria-hidden className="mt-[7px] size-1 shrink-0 rounded-full bg-text-subtle" />
          )}
          <span className="min-w-0 break-words">{item}</span>
        </li>
      ))}
    </ul>
  );
}

function TableRow({ table, open, onOpenChange }: { table: ImportTablePlan; open: boolean; onOpenChange: (open: boolean) => void }) {
  const renamed = table.sourceName !== table.targetName;
  const warnings = table.warnings.length;
  return (
    <li>
      <Collapsible open={open} onOpenChange={onOpenChange}>
        <CollapsibleTrigger
          className={cn(
            "group grid w-full grid-cols-[1rem_minmax(0,1fr)_auto] items-center gap-x-3 px-3 py-2.5 text-left transition-colors hover:bg-bg-raised/50 sm:grid-cols-[1rem_minmax(0,1fr)_5.5rem_7.5rem_7.5rem]",
            "data-[state=open]:bg-bg-raised/40",
            focusRingInset,
          )}
        >
          <ChevronRight aria-hidden className="size-4 text-text-subtle transition-transform group-data-[state=open]:rotate-90" />
          <span className="min-w-0">
            <span className="block truncate font-mono text-code text-text" title={table.targetName}>
              {table.targetName}
            </span>
            {renamed && (
              <span className="block truncate text-micro text-text-subtle" title={table.sourceName}>
                from {table.sourceName}
              </span>
            )}
            <span className="flex items-center gap-1.5 text-micro text-text-subtle sm:hidden">
              {pluralize(table.columns.length, "column")}
              {warnings > 0 && (
                <>
                  <span aria-hidden>·</span>
                  <Dot className="bg-warn" />
                  <span className="text-text-muted">{pluralize(warnings, "warning")}</span>
                </>
              )}
            </span>
          </span>
          <span className="hidden text-right font-mono text-code tabular-nums text-text-muted sm:block">{formatNumber(table.columns.length)}</span>
          <span className="text-right font-mono text-code tabular-nums text-text">
            {formatNumber(table.rowCount)}
            <span className="block font-sans text-micro text-text-subtle sm:sr-only">{table.rowCount === 1 ? " row" : " rows"}</span>
          </span>
          <span className="hidden items-center gap-1.5 text-label sm:flex">
            {warnings > 0 ? (
              <>
                <Dot className="bg-warn" />
                <span className="text-text-muted">{pluralize(warnings, "warning")}</span>
              </>
            ) : (
              <span className="text-text-subtle">none</span>
            )}
          </span>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <TableDetail table={table} />
        </CollapsibleContent>
      </Collapsible>
    </li>
  );
}

function TableDetail({ table }: { table: ImportTablePlan }) {
  const [showSql, setShowSql] = useState(false);
  const warnings = generalWarnings(table);
  const hasKeys = table.indexes.length > 0 || table.foreignKeys.length > 0;
  return (
    <div className="space-y-4 border-t border-border bg-bg-inset/60 px-3 pb-4 pt-3 sm:pl-10 sm:pr-4">
      {warnings.length > 0 && <NoteList items={warnings} tone="warn" />}
      <ColumnTable table={table} />
      {hasKeys && <KeyList table={table} />}
      <Collapsible open={showSql} onOpenChange={setShowSql}>
        <CollapsibleTrigger asChild>
          <Button size="xs" variant="ghost" className="group -ml-2">
            <Code2 />
            {showSql ? "Hide CREATE TABLE" : "View CREATE TABLE"}
            <ChevronRight className="transition-transform group-data-[state=open]:rotate-90" />
          </Button>
        </CollapsibleTrigger>
        <CollapsibleContent className="pt-2">
          <CodeBlock code={table.createSql} language="sql" title={`${table.targetName}`} maxHeight={360} />
        </CollapsibleContent>
      </Collapsible>
    </div>
  );
}

const COLUMN_GRID = "grid grid-cols-[minmax(0,1fr)_auto] gap-x-4 sm:grid-cols-[minmax(0,0.95fr)_minmax(0,1.25fr)_minmax(0,1.15fr)]";

function ColumnTable({ table }: { table: ImportTablePlan }) {
  return (
    <div role="table" aria-label={`Columns of ${table.targetName}`} className="min-w-0">
      <div role="rowgroup">
        <div role="row" className={cn(COLUMN_GRID, "hidden pb-1.5 text-micro text-text-subtle sm:grid")}>
          <span role="columnheader">Column</span>
          <span role="columnheader">In SQLite: declared, then stored</span>
          <span role="columnheader">MariaDB type</span>
        </div>
      </div>
      <div role="rowgroup">
        {table.columns.map((column) => (
          <ColumnRow key={column.sourceName} column={column} />
        ))}
      </div>
    </div>
  );
}

function ColumnRow({ column }: { column: ImportColumnPlan }) {
  const { base, collation } = splitType(column.mariadbType);
  const renamed = column.sourceName !== column.targetName;
  const longest = maxLengthLabel(column);
  return (
    <div role="row" className={cn(COLUMN_GRID, "gap-y-1 border-t border-border/70 py-2.5 text-label first:border-t-0 sm:first:border-t")}>
      <div role="cell" className="min-w-0">
        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
          <span className="min-w-0 truncate font-mono text-code text-text" title={column.targetName}>
            {column.targetName}
          </span>
          {column.primaryKey && (
            <Badge size="sm" variant="muted" mono>
              PK
            </Badge>
          )}
          {column.autoIncrement && (
            <Badge size="sm" variant="muted" mono>
              auto
            </Badge>
          )}
        </div>
        {renamed && <div className="truncate text-micro text-text-subtle">from {column.sourceName}</div>}
      </div>
      <div role="cell" className="col-span-2 row-start-2 min-w-0 sm:col-span-1 sm:row-start-auto">
        <div className="truncate">
          <span className="text-text-subtle sm:sr-only">Declared </span>
          {column.declaredType ? (
            <span className="font-mono text-code text-text-muted">{column.declaredType}</span>
          ) : (
            <span className="italic text-text-subtle">no declared type</span>
          )}
        </div>
        <div className="text-text-muted">
          <span className="text-text-subtle sm:sr-only">Stored </span>
          {observedSummary(column)}
          {longest && <span className="text-text-subtle"> · {longest}</span>}
        </div>
      </div>
      <div role="cell" className="col-start-2 row-start-1 min-w-0 text-right sm:col-start-auto sm:row-start-auto sm:text-left">
        <div className="break-words font-mono text-code text-text">
          {base}
          {!column.nullable && !column.primaryKey && <span className="text-text-subtle"> NOT NULL</span>}
        </div>
        {collation && <div className="truncate font-mono text-micro text-text-subtle">{collation}</div>}
        {column.defaultSql !== null && (
          <div className="truncate font-mono text-micro text-text-subtle">default {column.defaultSql}</div>
        )}
      </div>
      {column.notes.length > 0 && (
        <div role="cell" className="col-span-2 min-w-0 pt-0.5 sm:col-span-3">
          <NoteList items={column.notes} tone="note" />
        </div>
      )}
    </div>
  );
}

function indexKind(index: ImportIndexPlan): string {
  if (index.name === "PRIMARY") return "PRIMARY KEY";
  return index.unique ? "UNIQUE" : "INDEX";
}

function KeyList({ table }: { table: ImportTablePlan }) {
  return (
    <div className="space-y-1.5">
      <div className="text-micro text-text-subtle">Keys, indexes and foreign keys</div>
      <ul className="space-y-1.5 text-label">
        {table.indexes.map((index) => (
          <li key={`i:${index.name}`} className="min-w-0">
            <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
              <Badge size="sm" variant="muted" mono>
                {indexKind(index)}
              </Badge>
              <span className={cn("min-w-0 break-all font-mono text-code", index.skippedReason ? "text-text-muted" : "text-text")}>
                {index.name === "PRIMARY" ? "" : `${index.name} `}({index.columns.join(", ") || "expression"})
              </span>
              {index.skippedReason && (
                <span className="inline-flex items-center gap-1.5 text-text-muted">
                  <Dot className="bg-warn" /> not created
                </span>
              )}
            </div>
            {index.skippedReason && <p className="mt-0.5 break-words pl-0.5 text-text-muted">{index.skippedReason}</p>}
          </li>
        ))}
        {table.foreignKeys.map((fk, i) => (
          <li key={`f:${i}`} className="min-w-0">
            <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
              <Badge size="sm" variant="muted" mono>
                FOREIGN KEY
              </Badge>
              <span className={cn("min-w-0 break-all font-mono text-code", fk.skippedReason ? "text-text-muted" : "text-text")}>
                ({fk.columns.join(", ")}) → {fk.refTable}({fk.refColumns.join(", ")})
              </span>
              {fk.skippedReason ? (
                <span className="inline-flex items-center gap-1.5 text-text-muted">
                  <Dot className="bg-warn" /> not created
                </span>
              ) : (
                <span className="text-text-subtle">added after the rows are loaded</span>
              )}
            </div>
            {fk.skippedReason && <p className="mt-0.5 break-words pl-0.5 text-text-muted">{fk.skippedReason}</p>}
          </li>
        ))}
      </ul>
    </div>
  );
}

function SkippedList({ items }: { items: ImportSkippedObject[] }) {
  const headingId = useId();
  const groups = groupSkipped(items);
  const hasCode = items.some((s) => s.kind !== "internal");
  return (
    <section aria-labelledby={headingId} className="space-y-2">
      <div className="space-y-0.5">
        <h4 id={headingId} className="text-body font-medium text-text">
          Not copied <span className="font-mono text-code font-normal text-text-subtle">{groups.length}</span>
        </h4>
        <p className="max-w-3xl text-label text-text-muted">
          {hasCode
            ? "SQLite views, triggers and extension tables are written in SQL that doesn't translate to MariaDB mechanically, so they are listed here instead of guessed at. Recreate any you need after the import."
            : "SQLite's own bookkeeping, used while planning and not needed in MariaDB."}
        </p>
      </div>
      <ul className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-bg-panel">
        {groups.map((group) => (
          <SkippedRow key={`${group.item.kind}:${group.item.name}`} item={group.item} storage={group.storage} />
        ))}
      </ul>
    </section>
  );
}

function SkippedRow({ item, storage }: { item: ImportSkippedObject; storage: ImportSkippedObject[] }) {
  const [open, setOpen] = useState(false);
  return (
    <li className="px-3 py-2.5">
      <Collapsible open={open} onOpenChange={setOpen}>
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          <Badge size="sm" variant="muted">
            {SKIPPED_KIND_LABEL[item.kind]}
          </Badge>
          <span className="min-w-0 break-all font-mono text-code text-text">{item.name}</span>
          {item.sql && (
            <CollapsibleTrigger asChild>
              <Button size="xs" variant="ghost" className="group ml-auto h-6 px-2">
                SQL
                <ChevronRight className="transition-transform group-data-[state=open]:rotate-90" />
              </Button>
            </CollapsibleTrigger>
          )}
        </div>
        <p className="mt-0.5 break-words text-label text-text-muted">{item.reason}</p>
        {storage.length > 0 && (
          <p className="mt-0.5 break-words text-label text-text-subtle">
            Its {pluralize(storage.length, "storage table")} stay behind with it:{" "}
            <span className="font-mono text-micro">{storage.map((s) => s.name).join(", ")}</span>
          </p>
        )}
        {item.sql && (
          <CollapsibleContent className="pt-2">
            <CodeBlock code={item.sql} language="sqlite" wrap maxHeight={240} />
          </CollapsibleContent>
        )}
      </Collapsible>
    </li>
  );
}

function SqlPlanReview({
  plan,
  mode,
  targetLabel,
  className,
}: {
  plan: SqlImportPlan;
  mode: PlanMode;
  targetLabel?: ReactNode;
  className?: string;
}) {
  const headingId = useId();
  const target = targetLabel ?? (mode === "create" ? "the new database" : "this database");
  return (
    <section aria-labelledby={headingId} className={cn("min-w-0 space-y-4", className)}>
      <div className="space-y-1">
        <h3 id={headingId} className="text-heading font-semibold text-text">
          SQL dump
        </h3>
        <p className="max-w-3xl text-body text-text-muted">
          A dump is a script, so there is no table plan to review. LambData runs it as written
          {mode === "create" ? <> inside {target} only</> : <> into a staging copy of {target}, then swaps it in for the current contents</>},
          signed in as that database&apos;s own MariaDB user. The dump&apos;s own CREATE DATABASE and USE statements are skipped, so
          everything lands in {target}; anything that needs server-wide rights (GRANT, CREATE USER) stops the load instead of running.
          Tables, rows, views and triggers come out exactly as the dump defines them.
        </p>
      </div>
      <DescriptionList layout="grid" className="rounded-lg border border-border bg-bg-panel p-4">
        <DescriptionItem term="Format">{plan.compressed ? "MySQL/MariaDB dump, gzip-compressed" : "MySQL/MariaDB dump"}</DescriptionItem>
        <DescriptionItem term={plan.compressed ? "Size (compressed)" : "Size"}>{formatBytes(plan.upload.sizeBytes)}</DescriptionItem>
        <DescriptionItem term="SHA-256" mono>
          <span className="break-all">{plan.upload.sha256}</span>
        </DescriptionItem>
        <DescriptionItem term="Upload kept until">
          {formatDate(plan.upload.expiresAt)}{" "}
          <span className="text-text-subtle">({formatRelativeTime(plan.upload.expiresAt)})</span>
        </DescriptionItem>
      </DescriptionList>
      {plan.warnings.length > 0 && (
        <div className="space-y-2">
          <div className="text-body font-medium text-text">Noticed in the dump</div>
          <NoteList items={plan.warnings} tone="note" />
        </div>
      )}
    </section>
  );
}
