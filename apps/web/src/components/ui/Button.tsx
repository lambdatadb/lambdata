import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import { forwardRef, type ButtonHTMLAttributes } from "react";
import { Spinner } from "./Spinner";
import { cn } from "./cn";
import { focusRing } from "./styles";

export const buttonVariants = cva(
  [
    "relative inline-flex shrink-0 select-none items-center justify-center gap-2 whitespace-nowrap rounded-md font-medium",
    "transition-[color,background-color,border-color,opacity] duration-150",
    "disabled:pointer-events-none disabled:opacity-45 aria-disabled:pointer-events-none aria-disabled:opacity-45 data-[loading]:pointer-events-none",
    "[&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
    focusRing,
  ],
  {
    variants: {
      variant: {
        primary:
          "bg-accent text-accent-fg hover:bg-accent-hover active:bg-accent disabled:bg-bg-hover disabled:text-text-subtle disabled:opacity-100",
        default:
          "bg-accent text-accent-fg hover:bg-accent-hover active:bg-accent disabled:bg-bg-hover disabled:text-text-subtle disabled:opacity-100",
        secondary: "border border-border-strong bg-bg-raised text-text hover:border-border-input hover:bg-bg-hover",
        outline: "border border-border-input bg-transparent text-text hover:border-border-control/70 hover:bg-bg-hover",
        ghost: "text-text-muted hover:bg-bg-hover hover:text-text data-[state=open]:bg-bg-hover data-[state=open]:text-text",
        danger: "bg-danger text-danger-fg hover:bg-danger-hover",
        destructive: "bg-danger text-danger-fg hover:bg-danger-hover",
        "danger-soft": "border border-danger/35 bg-danger/10 text-danger hover:border-danger/55 hover:bg-danger/15",
        link: "h-auto rounded-sm px-0 text-text underline decoration-border-control underline-offset-4 hover:decoration-accent",
      },
      size: {
        xs: "h-7 gap-1.5 px-2.5 text-label [&_svg:not([class*='size-'])]:size-3.5",
        sm: "h-8 gap-1.5 px-3 text-body",
        md: "h-9 px-3.5 text-body",
        lg: "h-10 px-4 text-body",
        icon: "size-9",
        "icon-sm": "size-8",
        "icon-xs": "size-7 [&_svg:not([class*='size-'])]:size-3.5",
      },
    },
    compoundVariants: [{ variant: "link", class: "h-auto px-0" }],
    defaultVariants: { variant: "primary", size: "md" },
  },
);

export type ButtonVariant = NonNullable<VariantProps<typeof buttonVariants>["variant"]>;
export type ButtonSize = NonNullable<VariantProps<typeof buttonVariants>["size"]>;

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
  asChild?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant, size, loading = false, asChild = false, className, children, disabled, type, onClick, ...rest },
  ref,
) {
  const classes = cn(buttonVariants({ variant, size }), className);
  if (asChild) {
    return (
      <Slot ref={ref} className={classes} aria-busy={loading || undefined} onClick={onClick} {...rest}>
        {children}
      </Slot>
    );
  }
  return (
    <button
      ref={ref}
      type={type ?? "button"}
      disabled={disabled}
      aria-busy={loading || undefined}
      data-loading={loading ? "" : undefined}
      onClick={(event) => {
        if (loading) {
          event.preventDefault();
          return;
        }
        onClick?.(event);
      }}
      className={classes}
      {...rest}
    >
      {loading && <Spinner decorative size={size === "xs" || size === "icon-xs" ? "xs" : "sm"} className="text-current" />}
      {loading && size?.startsWith("icon") ? null : children}
      {loading && <span className="sr-only">Working</span>}
    </button>
  );
});
