import { cn } from "./cn";

export function Skeleton({ className }: { className?: string }) {
  return (
    <div
      className={cn(
        "animate-pulse rounded bg-bg-subtle motion-reduce:animate-none",
        className,
      )}
    />
  );
}

export function SkeletonRows({ rows = 3, className }: { rows?: number; className?: string }) {
  return (
    <div className={cn("space-y-2.5", className)}>
      {Array.from({ length: rows }, (_, i) => (
        <Skeleton key={i} className={cn("h-3.5", i % 3 === 0 ? "w-3/4" : i % 3 === 1 ? "w-1/2" : "w-2/3")} />
      ))}
    </div>
  );
}
