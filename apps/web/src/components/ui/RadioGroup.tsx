import * as RadioGroupPrimitive from "@radix-ui/react-radio-group";
import { forwardRef, useId, type ComponentPropsWithoutRef, type ElementRef, type ReactNode } from "react";
import { cn } from "./cn";
import { focusRing } from "./styles";

export const RadioGroup = forwardRef<
  ElementRef<typeof RadioGroupPrimitive.Root>,
  ComponentPropsWithoutRef<typeof RadioGroupPrimitive.Root>
>(function RadioGroup({ className, ...rest }, ref) {
  return <RadioGroupPrimitive.Root ref={ref} className={cn("grid gap-2.5", className)} {...rest} />;
});

export interface RadioGroupItemProps extends ComponentPropsWithoutRef<typeof RadioGroupPrimitive.Item> {
  label?: ReactNode;
  description?: ReactNode;
}

export const RadioGroupItem = forwardRef<ElementRef<typeof RadioGroupPrimitive.Item>, RadioGroupItemProps>(
  function RadioGroupItem({ className, label, description, id, disabled, ...rest }, ref) {
    const autoId = useId();
    const controlId = id ?? `radio${autoId.replace(/:/g, "")}`;
    const descriptionId = description ? `${controlId}-description` : undefined;
    const item = (
      <RadioGroupPrimitive.Item
        ref={ref}
        id={controlId}
        disabled={disabled}
        aria-describedby={descriptionId}
        className={cn(
          "grid size-4 shrink-0 place-items-center rounded-full border border-border-control bg-bg-inset transition-colors hover:border-text-subtle",
          "data-[state=checked]:border-accent disabled:cursor-not-allowed disabled:opacity-45",
          focusRing,
          label ? "mt-0.5" : undefined,
          className,
        )}
        {...rest}
      >
        <RadioGroupPrimitive.Indicator className="size-2 rounded-full bg-accent" />
      </RadioGroupPrimitive.Item>
    );
    if (!label) return item;
    return (
      <div className="flex items-start gap-2.5">
        {item}
        <div className="min-w-0 space-y-0.5">
          <label
            htmlFor={controlId}
            className={cn(
              "block cursor-pointer select-none text-body font-medium text-text",
              disabled && "cursor-not-allowed opacity-50",
            )}
          >
            {label}
          </label>
          {description && (
            <p id={descriptionId} className="text-label text-text-muted">
              {description}
            </p>
          )}
        </div>
      </div>
    );
  },
);

export interface RadioCardProps extends Omit<ComponentPropsWithoutRef<typeof RadioGroupPrimitive.Item>, "title"> {
  title: ReactNode;
  description?: ReactNode;
  icon?: ReactNode;
  badge?: ReactNode;
  layout?: "stacked" | "inline";
}

function RadioCardIndicator() {
  return (
    <span
      aria-hidden
      className="grid size-4 shrink-0 place-items-center rounded-full border border-border-control transition-colors group-data-[state=checked]:border-accent"
    >
      <span className="size-2 scale-0 rounded-full bg-accent transition-transform group-data-[state=checked]:scale-100" />
    </span>
  );
}

export const RadioCard = forwardRef<ElementRef<typeof RadioGroupPrimitive.Item>, RadioCardProps>(function RadioCard(
  { className, title, description, icon, badge, layout = "stacked", ...rest },
  ref,
) {
  const stacked = layout === "stacked" && icon !== undefined;
  const iconSlot = icon !== undefined && (
    <span className="grid size-8 shrink-0 place-items-center rounded-md border border-border bg-bg-raised text-text-muted transition-colors group-data-[state=checked]:border-accent/30 group-data-[state=checked]:text-accent [&_svg:not([class*='size-'])]:size-4">
      {icon}
    </span>
  );
  const text = (
    <span className="flex min-w-0 flex-1 flex-col gap-0.5">
      <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-body font-medium text-text">
        {title}
        {badge}
      </span>
      {description && <span className="text-label text-text-muted">{description}</span>}
    </span>
  );
  return (
    <RadioGroupPrimitive.Item
      ref={ref}
      className={cn(
        "group relative flex w-full rounded-lg border border-border bg-bg-panel p-3.5 text-left transition-colors",
        stacked ? "flex-col items-stretch gap-3" : "items-start gap-3",
        "hover:border-border-strong hover:bg-bg-raised",
        "data-[state=checked]:border-accent/55 data-[state=checked]:bg-accent/[0.035]",
        "disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:border-border disabled:hover:bg-bg-panel",
        focusRing,
        className,
      )}
      {...rest}
    >
      {stacked ? (
        <>
          <span className="flex items-start justify-between gap-3">
            {iconSlot}
            <RadioCardIndicator />
          </span>
          {text}
        </>
      ) : (
        <>
          {iconSlot}
          {text}
          <span className="mt-0.5">
            <RadioCardIndicator />
          </span>
        </>
      )}
    </RadioGroupPrimitive.Item>
  );
});

export interface SegmentedOption {
  value: string;
  label: ReactNode;
  disabled?: boolean;
  "aria-label"?: string;
}

export interface SegmentedControlProps
  extends Omit<ComponentPropsWithoutRef<typeof RadioGroupPrimitive.Root>, "orientation" | "children"> {
  options: SegmentedOption[];
  size?: "xs" | "sm" | "md";
  fullWidth?: boolean;
}

const segmentSizes = {
  xs: "h-6 px-2 text-micro",
  sm: "h-7 px-2.5 text-label",
  md: "h-8 px-3 text-body",
};

export const SegmentedControl = forwardRef<ElementRef<typeof RadioGroupPrimitive.Root>, SegmentedControlProps>(
  function SegmentedControl({ options, size = "sm", fullWidth = false, className, ...rest }, ref) {
    return (
      <RadioGroupPrimitive.Root
        ref={ref}
        orientation="horizontal"
        className={cn(
          "inline-flex w-fit max-w-full items-center gap-0.5 rounded-md border border-border bg-bg-inset p-0.5",
          fullWidth && "flex w-full",
          className,
        )}
        {...rest}
      >
        {options.map((option) => (
          <RadioGroupPrimitive.Item
            key={option.value}
            value={option.value}
            disabled={option.disabled}
            aria-label={option["aria-label"]}
            className={cn(
              "inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-[5px] font-medium text-text-muted transition-colors",
              "hover:text-text data-[state=checked]:bg-bg-selected data-[state=checked]:text-text data-[state=checked]:shadow-[inset_0_0_0_1px_rgb(var(--edge-strong))]",
              "disabled:pointer-events-none disabled:opacity-45 [&_svg:not([class*='size-'])]:size-3.5",
              "outline-none focus-visible:ring-2 focus-visible:ring-ring/70",
              segmentSizes[size],
              fullWidth && "flex-1",
            )}
          >
            {option.label}
          </RadioGroupPrimitive.Item>
        ))}
      </RadioGroupPrimitive.Root>
    );
  },
);
