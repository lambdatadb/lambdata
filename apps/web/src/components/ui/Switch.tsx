import * as SwitchPrimitive from "@radix-ui/react-switch";
import { forwardRef, useId, type ElementRef, type ReactNode } from "react";
import { useFieldControl } from "./Field";
import { cn } from "./cn";
import { focusRing } from "./styles";

const sizes = {
  sm: { root: "h-4 w-7", thumb: "size-2.5 data-[state=checked]:translate-x-[13px]" },
  md: { root: "h-5 w-9", thumb: "size-3.5 data-[state=checked]:translate-x-[17px]" },
};

export interface SwitchProps {
  checked?: boolean;
  defaultChecked?: boolean;
  onChange?: (checked: boolean) => void;
  onCheckedChange?: (checked: boolean) => void;
  disabled?: boolean;
  required?: boolean;
  name?: string;
  value?: string;
  id?: string;
  label?: ReactNode;
  description?: ReactNode;
  size?: keyof typeof sizes;
  side?: "left" | "right";
  className?: string;
  "aria-label"?: string;
  "aria-describedby"?: string;
}

export const Switch = forwardRef<ElementRef<typeof SwitchPrimitive.Root>, SwitchProps>(function Switch(
  {
    checked,
    defaultChecked,
    onChange,
    onCheckedChange,
    disabled,
    required,
    name,
    value,
    id,
    label,
    description,
    size = "md",
    side = "left",
    className,
    "aria-label": ariaLabel,
    "aria-describedby": ariaDescribedBy,
  },
  ref,
) {
  const autoId = useId();
  const field = useFieldControl({ id, disabled, required, "aria-describedby": ariaDescribedBy });
  const controlId = field.id ?? `switch${autoId.replace(/:/g, "")}`;
  const descriptionId = description ? `${controlId}-description` : undefined;
  const describedBy = [field["aria-describedby"], descriptionId].filter(Boolean).join(" ") || undefined;
  const control = (
    <SwitchPrimitive.Root
      ref={ref}
      id={controlId}
      checked={checked}
      defaultChecked={defaultChecked}
      onCheckedChange={(next) => {
        onCheckedChange?.(next);
        onChange?.(next);
      }}
      disabled={field.disabled}
      required={field.required}
      name={name}
      value={value}
      aria-label={ariaLabel}
      aria-describedby={describedBy}
      className={cn(
        "group inline-flex shrink-0 cursor-pointer items-center rounded-full border border-border-control bg-bg-raised p-px transition-colors",
        "data-[state=checked]:border-accent data-[state=checked]:bg-accent",
        "disabled:cursor-not-allowed disabled:opacity-45",
        focusRing,
        sizes[size].root,
        label && "mt-0.5",
        !label && className,
      )}
    >
      <SwitchPrimitive.Thumb
        className={cn(
          "pointer-events-none block translate-x-px rounded-full bg-text-muted transition-transform duration-150 ease-out data-[state=checked]:bg-accent-fg",
          sizes[size].thumb,
        )}
      />
    </SwitchPrimitive.Root>
  );
  if (!label && !description) return control;
  return (
    <div
      className={cn(
        "flex items-start gap-3",
        side === "right" && "flex-row-reverse justify-between",
        field.disabled && "opacity-60",
        className,
      )}
    >
      {control}
      <div className="min-w-0 flex-1 space-y-0.5">
        {label && (
          <label
            htmlFor={controlId}
            className={cn("block select-none text-body font-medium text-text", field.disabled ? "cursor-not-allowed" : "cursor-pointer")}
          >
            {label}
          </label>
        )}
        {description && (
          <p id={descriptionId} className="text-label text-text-muted">
            {description}
          </p>
        )}
      </div>
    </div>
  );
});
