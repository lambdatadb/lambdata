import type { ColorTheme } from "@lambdata/shared";
import { cn } from "./cn";

const sizes = {
  sm: "size-2.5",
  md: "size-3",
  lg: "size-4",
};

export interface ThemeSwatchesProps {
  theme: ColorTheme;
  size?: keyof typeof sizes;
  className?: string;
}

export function ThemeSwatches({ theme, size = "md", className }: ThemeSwatchesProps) {
  return (
    <span aria-hidden className={cn("inline-flex shrink-0 items-center -space-x-1", className)}>
      {[1, 2, 3].map((n) => (
        <span
          key={n}
          className={cn("rounded-full ring-2 ring-bg-raised", sizes[size])}
          style={{ backgroundColor: `rgb(var(--palette-${theme}-${n}))` }}
        />
      ))}
    </span>
  );
}
