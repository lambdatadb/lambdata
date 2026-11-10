import type { HTMLAttributes, ReactNode } from "react";
import { cn } from "./cn";

export function Skeleton({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      aria-hidden
      className={cn("animate-pulse rounded-md bg-bg-hover motion-reduce:animate-none", className)}
      {...rest}
    />
  );
}

export function SkeletonRows({
  rows = 3,
  className,
  label = "Loading",
}: {
  rows?: number;
  className?: string;
  label?: string;
}) {
  return (
    <div role="status" aria-busy="true" className={cn("space-y-2.5", className)}>
      {Array.from({ length: rows }, (_, i) => (
        <Skeleton key={i} className={cn("h-3.5", i % 3 === 0 ? "w-3/4" : i % 3 === 1 ? "w-1/2" : "w-2/3")} />
      ))}
      <span className="sr-only">{label}</span>
    </div>
  );
}

export function LoadingRegion({
  loading,
  label = "Loading",
  className,
  children,
}: {
  loading: boolean;
  label?: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div aria-busy={loading || undefined} className={className}>
      {loading && (
        <span role="status" className="sr-only">
          {label}
        </span>
      )}
      {children}
    </div>
  );
}
