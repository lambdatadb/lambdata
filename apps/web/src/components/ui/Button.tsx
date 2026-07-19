import { forwardRef, type ButtonHTMLAttributes } from "react";
import { cn } from "./cn";

type Variant = "primary" | "secondary" | "ghost" | "danger";
type Size = "xs" | "sm" | "md";

interface Props extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  loading?: boolean;
}

const variants: Record<Variant, string> = {
  primary:
    "bg-accent text-accent-fg hover:bg-accent-hover disabled:bg-accent/50 focus-visible:ring-accent",
  secondary:
    "bg-bg-subtle text-text border border-border hover:bg-bg-panel focus-visible:ring-border-strong",
  ghost: "text-text-muted hover:text-text hover:bg-bg-subtle focus-visible:ring-border",
  danger: "bg-danger text-white hover:bg-danger-hover focus-visible:ring-danger",
};

const sizes: Record<Size, string> = {
  xs: "h-7 px-2.5 text-label rounded-md",
  sm: "h-8 px-3 text-sm rounded-md",
  md: "h-9 px-3.5 text-sm rounded-md",
};

export const Button = forwardRef<HTMLButtonElement, Props>(function Button(
  { variant = "primary", size = "md", loading, className, children, disabled, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      disabled={disabled || loading}
      className={cn(
        "inline-flex items-center justify-center gap-2 font-medium transition-colors",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-0",
        "disabled:cursor-not-allowed disabled:opacity-60",
        variants[variant],
        sizes[size],
        className,
      )}
      {...rest}
    >
      {loading && (
        <span className="inline-block size-3 rounded-full border-2 border-current/30 border-t-current animate-spin" />
      )}
      {children}
    </button>
  );
});
