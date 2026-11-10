import type { HTMLAttributes } from "react";
import { cn } from "./cn";

export function Kbd({ className, ...rest }: HTMLAttributes<HTMLElement>) {
  return (
    <kbd
      className={cn(
        "pointer-events-none inline-flex h-5 min-w-5 select-none items-center justify-center gap-0.5 rounded-[4px] border border-border-strong bg-bg-raised px-1 font-mono text-micro font-medium leading-none text-text-muted shadow-[inset_0_-1px_0_rgb(var(--edge-strong))] [&_svg:not([class*='size-'])]:size-3",
        className,
      )}
      {...rest}
    />
  );
}

export function KbdGroup({ className, ...rest }: HTMLAttributes<HTMLSpanElement>) {
  return <span className={cn("inline-flex items-center gap-1", className)} {...rest} />;
}
