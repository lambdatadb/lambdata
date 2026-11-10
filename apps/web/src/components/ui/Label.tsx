import * as LabelPrimitive from "@radix-ui/react-label";
import { forwardRef, type ComponentPropsWithoutRef, type ElementRef } from "react";
import { cn } from "./cn";

export interface LabelProps extends ComponentPropsWithoutRef<typeof LabelPrimitive.Root> {
  required?: boolean;
}

export const Label = forwardRef<ElementRef<typeof LabelPrimitive.Root>, LabelProps>(function Label(
  { className, required, children, ...rest },
  ref,
) {
  return (
    <LabelPrimitive.Root
      ref={ref}
      className={cn(
        "inline-flex select-none items-center gap-1 text-label font-medium text-text-muted peer-disabled:cursor-not-allowed peer-disabled:opacity-50",
        className,
      )}
      {...rest}
    >
      {children}
      {required && (
        <span aria-hidden className="text-danger">
          *
        </span>
      )}
    </LabelPrimitive.Root>
  );
});
