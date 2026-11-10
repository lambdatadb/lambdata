import * as DialogPrimitive from "@radix-ui/react-dialog";
import { cva, type VariantProps } from "class-variance-authority";
import { X } from "lucide-react";
import { forwardRef, type ComponentPropsWithoutRef, type ElementRef, type HTMLAttributes } from "react";
import { cn } from "./cn";
import { focusRing, scrimMotion } from "./styles";

export const Sheet = DialogPrimitive.Root;
export const SheetTrigger = DialogPrimitive.Trigger;
export const SheetClose = DialogPrimitive.Close;
export const SheetPortal = DialogPrimitive.Portal;

const sheetVariants = cva(
  [
    "fixed z-50 flex flex-col bg-bg-panel text-text shadow-overlay outline-none",
    "data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=open]:duration-300 data-[state=closed]:duration-200 ease-out",
  ],
  {
    variants: {
      side: {
        left: "inset-y-0 left-0 h-dvh border-r border-border-strong data-[state=closed]:slide-out-to-left data-[state=open]:slide-in-from-left",
        right:
          "inset-y-0 right-0 h-dvh border-l border-border-strong data-[state=closed]:slide-out-to-right data-[state=open]:slide-in-from-right",
        top: "inset-x-0 top-0 max-h-[85dvh] border-b border-border-strong data-[state=closed]:slide-out-to-top data-[state=open]:slide-in-from-top",
        bottom:
          "inset-x-0 bottom-0 max-h-[85dvh] rounded-t-xl border-t border-border-strong data-[state=closed]:slide-out-to-bottom data-[state=open]:slide-in-from-bottom",
      },
    },
    defaultVariants: { side: "right" },
  },
);

export type SheetSize = "sm" | "md" | "lg" | "xl";

const sheetWidths: Record<SheetSize, string> = {
  sm: "w-[min(20rem,88vw)]",
  md: "w-[min(26rem,92vw)]",
  lg: "w-[min(40rem,100vw)]",
  xl: "w-[min(52rem,100vw)]",
};

export interface SheetContentProps
  extends ComponentPropsWithoutRef<typeof DialogPrimitive.Content>,
    VariantProps<typeof sheetVariants> {
  hideClose?: boolean;
  size?: SheetSize;
}

export const SheetContent = forwardRef<ElementRef<typeof DialogPrimitive.Content>, SheetContentProps>(
  function SheetContent({ side = "right", size, className, children, hideClose = false, ...rest }, ref) {
    const horizontal = side === "left" || side === "right";
    const width = horizontal ? sheetWidths[size ?? (side === "left" ? "sm" : "md")] : null;
    return (
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className={cn("fixed inset-0 z-50 bg-scrim/70 backdrop-blur-[2px]", scrimMotion)} />
        <DialogPrimitive.Content ref={ref} className={cn(sheetVariants({ side }), width, className)} {...rest}>
          {children}
          {!hideClose && (
            <DialogPrimitive.Close
              className={cn(
                "absolute right-3 top-3 grid size-8 place-items-center rounded-md text-text-subtle transition-colors hover:bg-bg-hover hover:text-text",
                focusRing,
              )}
            >
              <X className="size-4" aria-hidden />
              <span className="sr-only">Close</span>
            </DialogPrimitive.Close>
          )}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    );
  },
);

export function SheetHeader({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("flex shrink-0 flex-col gap-1 border-b border-border px-5 py-4 pr-14", className)} {...rest} />;
}

export function SheetBody({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("relative min-h-0 flex-1 overflow-y-auto px-5 py-4", className)} {...rest} />;
}

export function SheetFooter({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn("flex shrink-0 flex-col-reverse gap-2 border-t border-border px-5 py-3.5 sm:flex-row sm:justify-end", className)}
      {...rest}
    />
  );
}

export const SheetTitle = forwardRef<
  ElementRef<typeof DialogPrimitive.Title>,
  ComponentPropsWithoutRef<typeof DialogPrimitive.Title>
>(function SheetTitle({ className, ...rest }, ref) {
  return <DialogPrimitive.Title ref={ref} className={cn("text-heading font-semibold text-text", className)} {...rest} />;
});

export const SheetDescription = forwardRef<
  ElementRef<typeof DialogPrimitive.Description>,
  ComponentPropsWithoutRef<typeof DialogPrimitive.Description>
>(function SheetDescription({ className, ...rest }, ref) {
  return <DialogPrimitive.Description ref={ref} className={cn("text-body text-text-muted", className)} {...rest} />;
});
