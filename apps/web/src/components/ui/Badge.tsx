import { cva, type VariantProps } from "class-variance-authority";
import { forwardRef, type HTMLAttributes } from "react";
import { cn } from "./cn";

export const badgeVariants = cva(
  "inline-flex max-w-full shrink-0 items-center gap-1.5 whitespace-nowrap rounded-[5px] border font-medium [&_svg:not([class*='size-'])]:size-3 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default: "border-border-strong bg-bg-raised text-text",
        muted: "border-border bg-transparent text-text-muted",
        outline: "border-border-input bg-transparent text-text",
        accent: "border-accent/30 bg-accent/[0.08] text-accent",
        success: "border-success/30 bg-success/[0.08] text-success",
        warn: "border-warn/30 bg-warn/[0.08] text-warn",
        danger: "border-danger/35 bg-danger/[0.08] text-danger",
        info: "border-info/30 bg-info/[0.08] text-info",
        solid: "border-transparent bg-accent text-accent-fg",
      },
      size: {
        sm: "h-[18px] px-1.5 text-micro",
        md: "h-5 px-2 text-micro",
        lg: "h-6 px-2.5 text-label",
      },
      mono: {
        true: "font-mono font-normal tracking-tight",
        false: "",
      },
    },
    defaultVariants: { variant: "default", size: "md", mono: false },
  },
);

export type BadgeVariant = NonNullable<VariantProps<typeof badgeVariants>["variant"]>;
export type BadgeTone = "default" | "accent" | "success" | "warn" | "danger" | "muted" | "info" | "outline";

const dotColor: Record<BadgeVariant, string> = {
  default: "bg-text-muted",
  muted: "bg-text-subtle",
  outline: "bg-text-muted",
  accent: "bg-accent",
  success: "bg-success",
  warn: "bg-warn",
  danger: "bg-danger",
  info: "bg-info",
  solid: "bg-accent-fg",
};

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  variant?: BadgeVariant;
  tone?: BadgeTone;
  size?: "sm" | "md" | "lg";
  mono?: boolean;
  dot?: boolean;
}

export const Badge = forwardRef<HTMLSpanElement, BadgeProps>(function Badge(
  { variant, tone, size, mono, dot, className, children, ...rest },
  ref,
) {
  const resolved: BadgeVariant = variant ?? tone ?? "default";
  return (
    <span ref={ref} className={cn(badgeVariants({ variant: resolved, size, mono }), className)} {...rest}>
      {dot && <span aria-hidden className={cn("size-1.5 shrink-0 rounded-full", dotColor[resolved])} />}
      {children}
    </span>
  );
});

export type StatusTone = "success" | "warn" | "danger" | "info" | "accent" | "muted";

const statusColor: Record<StatusTone, string> = {
  success: "bg-success",
  warn: "bg-warn",
  danger: "bg-danger",
  info: "bg-info",
  accent: "bg-accent",
  muted: "bg-text-subtle",
};

export interface StatusDotProps extends HTMLAttributes<HTMLSpanElement> {
  tone?: StatusTone;
  pulse?: boolean;
  label?: string;
}

export function StatusDot({ tone = "muted", pulse = false, label, className, ...rest }: StatusDotProps) {
  return (
    <span className={cn("relative inline-flex size-2 shrink-0", className)} {...rest}>
      {pulse && (
        <span
          aria-hidden
          className={cn("absolute inset-0 animate-ping rounded-full opacity-50 motion-reduce:hidden", statusColor[tone])}
        />
      )}
      <span aria-hidden className={cn("relative size-2 rounded-full", statusColor[tone])} />
      {label && <span className="sr-only">{label}</span>}
    </span>
  );
}
