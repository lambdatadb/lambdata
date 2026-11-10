import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "./cn";

const spinner = cva("inline-block shrink-0 animate-spin text-current", {
  variants: {
    size: {
      xs: "size-3",
      sm: "size-3.5",
      md: "size-4",
      lg: "size-5",
      xl: "size-6",
    },
  },
  defaultVariants: { size: "md" },
});

interface Props extends VariantProps<typeof spinner> {
  className?: string;
  label?: string;
  decorative?: boolean;
}

export function Spinner({ className, size, label = "Loading", decorative = false }: Props) {
  const svg = (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      data-spinner=""
      aria-hidden
      className={cn(spinner({ size }), "text-text-muted", className)}
    >
      <circle cx="8" cy="8" r="6.25" stroke="currentColor" strokeOpacity="0.22" strokeWidth="1.75" />
      <path d="M14.25 8A6.25 6.25 0 0 0 8 1.75" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" />
    </svg>
  );
  if (decorative) return svg;
  return (
    <span role="status" className="inline-flex items-center">
      {svg}
      <span className="sr-only">{label}</span>
    </span>
  );
}
