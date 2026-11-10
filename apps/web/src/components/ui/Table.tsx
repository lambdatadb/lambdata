import type { HTMLAttributes, ReactNode, TdHTMLAttributes, ThHTMLAttributes } from "react";
import { Skeleton } from "./Skeleton";
import { cn } from "./cn";

interface TableProps extends HTMLAttributes<HTMLTableElement> {
  flush?: boolean;
  caption?: ReactNode;
  wrapperClassName?: string;
}

export function Table({ className, flush, caption, wrapperClassName, children, ...rest }: TableProps) {
  return (
    <div
      className={cn(
        "relative w-full overflow-x-auto",
        !flush && "rounded-lg border border-border bg-bg-panel",
        wrapperClassName,
      )}
    >
      <table className={cn("w-full caption-bottom border-collapse text-body", className)} {...rest}>
        {caption && <caption className="sr-only">{caption}</caption>}
        {children}
      </table>
    </div>
  );
}

export function THead({ className, ...rest }: HTMLAttributes<HTMLTableSectionElement>) {
  return <thead className={cn("border-b border-border bg-bg-raised/40", className)} {...rest} />;
}

export function TBody({ className, ...rest }: HTMLAttributes<HTMLTableSectionElement>) {
  return <tbody className={cn("[&>tr:last-child]:border-b-0", className)} {...rest} />;
}

export function TFoot({ className, ...rest }: HTMLAttributes<HTMLTableSectionElement>) {
  return <tfoot className={cn("border-t border-border bg-bg-raised/40 font-medium", className)} {...rest} />;
}

interface TRProps extends HTMLAttributes<HTMLTableRowElement> {
  interactive?: boolean;
  selected?: boolean;
}

export function TR({ className, interactive, selected, ...rest }: TRProps) {
  return (
    <tr
      data-state={selected ? "selected" : undefined}
      aria-selected={selected || undefined}
      className={cn(
        "border-b border-border transition-colors [thead_&]:border-b-0",
        "hover:bg-bg-raised/50 data-[state=selected]:bg-bg-selected/60",
        interactive && "relative cursor-pointer focus-within:bg-bg-raised/60",
        className,
      )}
      {...rest}
    />
  );
}

interface THProps extends ThHTMLAttributes<HTMLTableCellElement> {
  numeric?: boolean;
}

export function TH({ className, numeric, scope = "col", ...rest }: THProps) {
  return (
    <th
      scope={scope}
      className={cn(
        "h-9 whitespace-nowrap px-4 text-left align-middle text-label font-medium text-text-subtle",
        numeric && "text-right",
        className,
      )}
      {...rest}
    />
  );
}

interface TDProps extends TdHTMLAttributes<HTMLTableCellElement> {
  numeric?: boolean;
  mono?: boolean;
}

export function TD({ className, numeric, mono, ...rest }: TDProps) {
  return (
    <td
      className={cn(
        "px-4 py-2.5 align-middle",
        (numeric || mono) && "font-mono text-code",
        numeric && "whitespace-nowrap text-right tabular-nums",
        className,
      )}
      {...rest}
    />
  );
}

export function TableEmpty({ colSpan, children }: { colSpan: number; children: ReactNode }) {
  return (
    <tr>
      <td colSpan={colSpan} className="px-4 py-10 text-center text-body text-text-muted">
        {children}
      </td>
    </tr>
  );
}

export function TableSkeleton({ rows = 4, cols }: { rows?: number; cols: number }) {
  return (
    <>
      {Array.from({ length: rows }, (_, r) => (
        <tr key={r} aria-hidden className="border-b border-border last:border-b-0">
          {Array.from({ length: cols }, (_, c) => (
            <td key={c} className="px-4 py-3">
              <Skeleton className={cn("h-3.5", c === 0 ? "w-32" : "w-16")} />
            </td>
          ))}
        </tr>
      ))}
    </>
  );
}

export const TableHeader = THead;
export const TableBody = TBody;
export const TableFooter = TFoot;
export const TableRow = TR;
export const TableHead = TH;
export const TableCell = TD;
