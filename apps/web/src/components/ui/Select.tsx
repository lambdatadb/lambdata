import * as SelectPrimitive from "@radix-ui/react-select";
import { Check, ChevronDown, ChevronUp } from "lucide-react";
import {
  forwardRef,
  type ComponentPropsWithoutRef,
  type ElementRef,
  type ReactNode,
  type SelectHTMLAttributes,
} from "react";
import { useFieldControl } from "./Field";
import { cn } from "./cn";
import { controlBase, controlFocus, floatingMotion, floatingSurface, menuItem } from "./styles";

const LAYOUT_CLASS =
  /^(?:[a-z0-9-]+:)*-?(?:w-|min-w-|max-w-|flex-|grow|shrink|basis-|self-|justify-self-|col-|row-|order-|m[trblxy]?-|hidden$|block$|inline-block$|inline-flex$|flex$)/;

function splitLayoutClasses(className?: string): [string, string] {
  if (!className) return ["", ""];
  const outer: string[] = [];
  const inner: string[] = [];
  for (const token of className.split(/\s+/).filter(Boolean)) {
    (LAYOUT_CLASS.test(token) ? outer : inner).push(token);
  }
  return [outer.join(" "), inner.join(" ")];
}

const nativeHeights = {
  sm: "h-8 pl-2.5 pr-8",
  md: "h-9 pl-3 pr-9",
};

export interface NativeSelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  selectSize?: keyof typeof nativeHeights;
  invalid?: boolean;
  wrapperClassName?: string;
}

export const NativeSelect = forwardRef<HTMLSelectElement, NativeSelectProps>(function NativeSelect(
  { className, selectSize = "md", invalid, wrapperClassName, children, ...rest },
  ref,
) {
  const [outer, inner] = splitLayoutClasses(className);
  const props = useFieldControl({ ...rest, "aria-invalid": invalid || rest["aria-invalid"] || undefined });
  return (
    <span className={cn("relative inline-flex w-full min-w-0", outer, wrapperClassName)}>
      <select
        ref={ref}
        className={cn(
          controlBase,
          controlFocus,
          nativeHeights[selectSize],
          "cursor-pointer appearance-none truncate [&>option]:bg-bg-overlay [&>option]:text-text",
          inner,
        )}
        {...props}
      >
        {children}
      </select>
      <ChevronDown
        aria-hidden
        className="pointer-events-none absolute right-2.5 top-1/2 size-4 -translate-y-1/2 text-text-subtle"
      />
    </span>
  );
});

export const SelectRoot = SelectPrimitive.Root;
export const SelectGroup = SelectPrimitive.Group;
export const SelectValue = SelectPrimitive.Value;

const triggerHeights = {
  sm: "h-8 px-2.5",
  md: "h-9 px-3",
};

export interface SelectTriggerProps extends ComponentPropsWithoutRef<typeof SelectPrimitive.Trigger> {
  size?: keyof typeof triggerHeights;
  invalid?: boolean;
}

export const SelectTrigger = forwardRef<ElementRef<typeof SelectPrimitive.Trigger>, SelectTriggerProps>(
  function SelectTrigger({ className, size = "md", invalid, children, ...rest }, ref) {
    const props = useFieldControl({ ...rest, "aria-invalid": invalid || rest["aria-invalid"] || undefined });
    return (
      <SelectPrimitive.Trigger
        ref={ref}
        className={cn(
          controlBase,
          controlFocus,
          triggerHeights[size],
          "flex items-center justify-between gap-2 text-left data-[placeholder]:text-text-subtle data-[state=open]:border-border-control/70 [&>span]:min-w-0 [&>span]:truncate",
          className,
        )}
        {...props}
      >
        {children}
        <SelectPrimitive.Icon asChild>
          <ChevronDown aria-hidden className="size-4 shrink-0 text-text-subtle" />
        </SelectPrimitive.Icon>
      </SelectPrimitive.Trigger>
    );
  },
);

export const SelectContent = forwardRef<
  ElementRef<typeof SelectPrimitive.Content>,
  ComponentPropsWithoutRef<typeof SelectPrimitive.Content>
>(function SelectContent({ className, children, position = "popper", sideOffset = 4, ...rest }, ref) {
  return (
    <SelectPrimitive.Portal>
      <SelectPrimitive.Content
        ref={ref}
        position={position}
        sideOffset={sideOffset}
        className={cn(
          floatingSurface,
          floatingMotion,
          "relative max-h-[min(var(--radix-select-content-available-height),22rem)] min-w-[8rem] overflow-hidden",
          position === "popper" && "w-full min-w-[var(--radix-select-trigger-width)]",
          className,
        )}
        {...rest}
      >
        <SelectPrimitive.ScrollUpButton className="flex h-6 cursor-default items-center justify-center text-text-subtle">
          <ChevronUp className="size-4" aria-hidden />
        </SelectPrimitive.ScrollUpButton>
        <SelectPrimitive.Viewport className="p-1">{children}</SelectPrimitive.Viewport>
        <SelectPrimitive.ScrollDownButton className="flex h-6 cursor-default items-center justify-center text-text-subtle">
          <ChevronDown className="size-4" aria-hidden />
        </SelectPrimitive.ScrollDownButton>
      </SelectPrimitive.Content>
    </SelectPrimitive.Portal>
  );
});

export const SelectLabel = forwardRef<
  ElementRef<typeof SelectPrimitive.Label>,
  ComponentPropsWithoutRef<typeof SelectPrimitive.Label>
>(function SelectLabel({ className, ...rest }, ref) {
  return (
    <SelectPrimitive.Label
      ref={ref}
      className={cn("px-2 pb-1 pt-2 text-micro font-medium uppercase tracking-wider text-text-subtle", className)}
      {...rest}
    />
  );
});

export interface SelectItemProps extends ComponentPropsWithoutRef<typeof SelectPrimitive.Item> {
  description?: ReactNode;
}

export const SelectItem = forwardRef<ElementRef<typeof SelectPrimitive.Item>, SelectItemProps>(function SelectItem(
  { className, children, description, ...rest },
  ref,
) {
  return (
    <SelectPrimitive.Item ref={ref} className={cn(menuItem, "pr-8", className)} {...rest}>
      <span className="flex min-w-0 flex-col">
        <SelectPrimitive.ItemText>{children}</SelectPrimitive.ItemText>
        {description && <span className="text-micro text-text-subtle">{description}</span>}
      </span>
      <span className="absolute right-2 flex size-4 items-center justify-center">
        <SelectPrimitive.ItemIndicator>
          <Check className="size-4 !text-accent" aria-hidden />
        </SelectPrimitive.ItemIndicator>
      </span>
    </SelectPrimitive.Item>
  );
});

export const SelectSeparator = forwardRef<
  ElementRef<typeof SelectPrimitive.Separator>,
  ComponentPropsWithoutRef<typeof SelectPrimitive.Separator>
>(function SelectSeparator({ className, ...rest }, ref) {
  return <SelectPrimitive.Separator ref={ref} className={cn("-mx-1 my-1 h-px bg-border", className)} {...rest} />;
});

export interface SelectMenuOption {
  value: string;
  label: ReactNode;
  description?: ReactNode;
  disabled?: boolean;
}

export interface SelectMenuProps {
  options: SelectMenuOption[];
  value?: string;
  defaultValue?: string;
  onValueChange?: (value: string) => void;
  placeholder?: ReactNode;
  disabled?: boolean;
  required?: boolean;
  name?: string;
  id?: string;
  size?: "sm" | "md";
  invalid?: boolean;
  className?: string;
  contentClassName?: string;
  "aria-label"?: string;
}

export function SelectMenu({
  options,
  value,
  defaultValue,
  onValueChange,
  placeholder,
  disabled,
  required,
  name,
  id,
  size,
  invalid,
  className,
  contentClassName,
  "aria-label": ariaLabel,
}: SelectMenuProps) {
  return (
    <SelectRoot
      value={value}
      defaultValue={defaultValue}
      onValueChange={onValueChange}
      disabled={disabled}
      required={required}
      name={name}
    >
      <SelectTrigger id={id} size={size} invalid={invalid} className={className} aria-label={ariaLabel}>
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent className={contentClassName}>
        {options.map((option) => (
          <SelectItem
            key={option.value}
            value={option.value}
            disabled={option.disabled}
            description={option.description}
          >
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </SelectRoot>
  );
}
