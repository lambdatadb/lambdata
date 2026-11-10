import type { ReactNode } from "react";
import { Card } from "./Card";
import { renderIcon, type IconLike } from "./Icon";
import { RollingNumber } from "./RollingNumber";
import { Skeleton } from "./Skeleton";
import { cn } from "./cn";

interface Props {
  label: ReactNode;
  value: number | null | undefined;
  format?: (n: number) => string;
  hint?: ReactNode;
  icon?: IconLike;
  loading?: boolean;
  mono?: boolean;
  className?: string;
  children?: ReactNode;
}

export function StatTile({
  label,
  value,
  format,
  hint,
  icon,
  loading = false,
  mono = true,
  className,
  children,
}: Props) {
  return (
    <Card className={cn("p-4", className)} aria-busy={loading || undefined}>
      <div className="flex items-center justify-between gap-2">
        <div className="truncate text-label font-medium text-text-muted">{label}</div>
        {renderIcon(icon, 15, "text-text-subtle")}
      </div>
      <div className={cn("mt-2 text-metric font-medium text-text", mono && "font-mono tracking-[-0.04em]")}>
        {loading ? (
          <>
            <Skeleton className="my-1 h-[22px] w-20" />
            <span className="sr-only" role="status">
              Loading
            </span>
          </>
        ) : (
          <RollingNumber value={value} format={format} />
        )}
      </div>
      {hint && (
        <div className="mt-1 truncate text-micro text-text-subtle">{loading ? <Skeleton className="h-3 w-28" /> : hint}</div>
      )}
      {children && <div className="mt-3">{children}</div>}
    </Card>
  );
}
