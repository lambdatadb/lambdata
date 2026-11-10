import type { ReactNode } from "react";
import { renderIcon, type IconLike } from "./Icon";
import { cn } from "./cn";

interface Props {
  icon?: IconLike;
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  variant?: "card" | "bare" | "dashed";
  size?: "sm" | "md";
  headingLevel?: 2 | 3 | 4;
  className?: string;
}

export function EmptyState({
  icon,
  title,
  description,
  action,
  variant = "card",
  size = "md",
  headingLevel = 3,
  className,
}: Props) {
  const Heading = `h${headingLevel}` as "h2" | "h3" | "h4";
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center text-center",
        variant === "card" && "rounded-lg border border-border bg-bg-panel",
        variant === "dashed" && "rounded-lg border border-dashed border-border-strong",
        size === "md" ? "px-6 py-12" : "px-4 py-8",
        className,
      )}
    >
      {icon !== undefined && (
        <div
          className={cn(
            "mb-4 grid place-items-center rounded-lg border border-border-strong bg-bg-raised text-text-muted",
            size === "md" ? "size-10" : "size-8",
          )}
        >
          {renderIcon(icon, size === "md" ? 18 : 16)}
        </div>
      )}
      <Heading className="text-body font-medium text-text">{title}</Heading>
      {description && <div className="mt-1 max-w-sm text-body text-text-muted">{description}</div>}
      {action && <div className="mt-5 flex flex-wrap items-center justify-center gap-2">{action}</div>}
    </div>
  );
}
