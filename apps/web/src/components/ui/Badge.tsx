import type { HTMLAttributes } from "react";
import { cn } from "./cn";

type Tone = "default" | "accent" | "success" | "warn" | "danger" | "muted";

const tones: Record<Tone, string> = {
  default: "bg-bg-subtle text-text border border-border",
  accent: "bg-accent/10 text-accent border border-accent/25",
  success: "bg-success/10 text-success border border-success/25",
  warn: "bg-warn/10 text-warn border border-warn/25",
  danger: "bg-danger/10 text-danger border border-danger/25",
  muted: "bg-bg-subtle text-text-muted border border-border",
};

export function Badge({
  tone = "default",
  className,
  ...rest
}: HTMLAttributes<HTMLSpanElement> & { tone?: Tone }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 px-2 h-5 rounded-md text-micro font-medium",
        tones[tone],
        className,
      )}
      {...rest}
    />
  );
}
