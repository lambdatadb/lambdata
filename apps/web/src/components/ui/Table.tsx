import type { HTMLAttributes, ReactNode, TdHTMLAttributes, ThHTMLAttributes } from "react";
import { Skeleton } from "./Skeleton";
import { cn } from "./cn";

interface TableProps extends HTMLAttributes<HTMLTableElement> {
  flush?: boolean;
}

export function Table({ className, flush, ...rest }: TableProps) {
  return (
    <div className={cn("overflow-x-auto", !flush && "card-surface p-0")}>
      <table className={cn("w-full text-body", className)} {...rest} />
    </div>
  );
}

export function THead({ className, ...rest }: HTMLAttributes<HTMLTableSectionElement>) {
  return <thead className={cn("bg-bg-subtle/50", className)} {...rest} />;
}

export function TBody(props: HTMLAttributes<HTMLTableSectionElement>) {
  return <tbody {...props} />;
}

export function TR({ className, ...rest }: HTMLAttributes<HTMLTableRowElement>) {
  return (
    <tr
      className={cn("border-t border-border first:border-t-0 hover:bg-bg-subtle/40", className)}
      {...rest}
    />
  );
}

export function TH({ className, ...rest }: ThHTMLAttributes<HTMLTableCellElement>) {
  return (
    <th
      className={cn("text-left text-label font-medium text-text-subtle px-4 py-2.5", className)}
      {...rest}
    />
  );
}

interface TDProps extends TdHTMLAttributes<HTMLTableCellElement> {
  numeric?: boolean;
}

export function TD({ className, numeric, ...rest }: TDProps) {
  return (
    <td
      className={cn("px-4 py-2.5", numeric && "text-right font-mono tabular-nums", className)}
      {...rest}
    />
  );
}

export function TableEmpty({ colSpan, children }: { colSpan: number; children: ReactNode }) {
  return (
    <tr>
      <td colSpan={colSpan} className="px-4 py-10 text-center text-body text-text-subtle">
        {children}
      </td>
    </tr>
  );
}

export function TableSkeleton({ rows = 4, cols }: { rows?: number; cols: number }) {
  return (
    <>
      {Array.from({ length: rows }, (_, r) => (
        <tr key={r} className="border-t border-border first:border-t-0">
          {Array.from({ length: cols }, (_, c) => (
            <td key={c} className="px-4 py-2.5">
              <Skeleton className={cn("h-3.5", c === 0 ? "w-32" : "w-16")} />
            </td>
          ))}
        </tr>
      ))}
    </>
  );
}
