import * as ProgressPrimitive from "@radix-ui/react-progress";
import { forwardRef, useId, type ComponentPropsWithoutRef, type ElementRef, type ReactNode } from "react";
import { cn } from "./cn";

const tones = {
  accent: "bg-accent",
  neutral: "bg-text-muted",
  success: "bg-success",
  warn: "bg-warn",
  danger: "bg-danger",
};

const heights = {
  xs: "h-1",
  sm: "h-1.5",
  md: "h-2",
};

export interface ProgressProps extends Omit<ComponentPropsWithoutRef<typeof ProgressPrimitive.Root>, "value"> {
  value?: number | null;
  tone?: keyof typeof tones;
  size?: keyof typeof heights;
  label?: ReactNode;
  showValue?: boolean;
  formatValue?: (value: number, max: number) => string;
}

export const Progress = forwardRef<ElementRef<typeof ProgressPrimitive.Root>, ProgressProps>(function Progress(
  { className, value = null, max = 100, tone = "accent", size = "sm", label, showValue = false, formatValue, ...rest },
  ref,
) {
  const labelId = useId();
  const indeterminate = value === null || value === undefined;
  const clamped = indeterminate ? 0 : Math.min(Math.max(value, 0), max);
  const percent = (clamped / max) * 100;
  const valueText = indeterminate
    ? undefined
    : formatValue
      ? formatValue(clamped, max)
      : `${Math.round(percent)}%`;
  const bar = (
    <ProgressPrimitive.Root
      ref={ref}
      value={indeterminate ? null : clamped}
      max={max}
      getValueLabel={valueText ? () => valueText : undefined}
      aria-labelledby={label ? labelId : undefined}
      className={cn("relative w-full overflow-hidden rounded-full bg-bg-hover", heights[size], !label && !showValue && className)}
      {...rest}
    >
      <ProgressPrimitive.Indicator
        data-progress-indeterminate={indeterminate ? "" : undefined}
        className={cn(
          "h-full rounded-full transition-[width] duration-300 ease-out",
          tones[tone],
          indeterminate && "w-2/5 animate-progress-indeterminate",
        )}
        style={indeterminate ? undefined : { width: `${percent}%` }}
      />
    </ProgressPrimitive.Root>
  );
  if (!label && !showValue) return bar;
  return (
    <div className={cn("space-y-1.5", className)}>
      <div className="flex items-baseline justify-between gap-3 text-label">
        <span id={labelId} className="min-w-0 truncate text-text-muted">
          {label}
        </span>
        {showValue && valueText && <span className="shrink-0 font-mono text-code text-text">{valueText}</span>}
      </div>
      {bar}
    </div>
  );
});
