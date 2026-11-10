import * as CheckboxPrimitive from "@radix-ui/react-checkbox";
import { Check, Minus } from "lucide-react";
import { forwardRef, useId, type ComponentPropsWithoutRef, type ElementRef, type ReactNode } from "react";
import { useFieldControl } from "./Field";
import { cn } from "./cn";
import { focusRing } from "./styles";

export interface CheckboxProps extends ComponentPropsWithoutRef<typeof CheckboxPrimitive.Root> {
  label?: ReactNode;
  description?: ReactNode;
}

export const Checkbox = forwardRef<ElementRef<typeof CheckboxPrimitive.Root>, CheckboxProps>(function Checkbox(
  { className, label, description, id, ...rest },
  ref,
) {
  const autoId = useId();
  const props = useFieldControl({ ...rest, id });
  const controlId = props.id ?? (label ? `checkbox${autoId.replace(/:/g, "")}` : undefined);
  const descriptionId = description && controlId ? `${controlId}-description` : undefined;
  const box = (
    <CheckboxPrimitive.Root
      ref={ref}
      {...props}
      id={controlId}
      aria-describedby={[props["aria-describedby"], descriptionId].filter(Boolean).join(" ") || undefined}
      className={cn(
        "peer grid size-4 shrink-0 place-items-center rounded-[4px] border border-border-control bg-bg-inset text-accent-fg transition-colors",
        "hover:border-text-subtle data-[state=checked]:border-accent data-[state=checked]:bg-accent data-[state=indeterminate]:border-accent data-[state=indeterminate]:bg-accent",
        "disabled:cursor-not-allowed disabled:opacity-45 aria-[invalid=true]:border-danger",
        focusRing,
        label ? "mt-0.5" : undefined,
        className,
      )}
    >
      <CheckboxPrimitive.Indicator className="grid place-items-center">
        {props.checked === "indeterminate" ? (
          <Minus className="size-3" strokeWidth={3} aria-hidden />
        ) : (
          <Check className="size-3" strokeWidth={3} aria-hidden />
        )}
      </CheckboxPrimitive.Indicator>
    </CheckboxPrimitive.Root>
  );
  if (!label) return box;
  return (
    <div className="flex items-start gap-2.5">
      {box}
      <div className="min-w-0 space-y-0.5">
        <label
          htmlFor={controlId}
          className={cn(
            "block cursor-pointer select-none text-body font-medium text-text",
            props.disabled && "cursor-not-allowed opacity-50",
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
});
