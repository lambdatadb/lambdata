import * as AlertDialogPrimitive from "@radix-ui/react-alert-dialog";
import { forwardRef, type ComponentPropsWithoutRef, type ElementRef, type HTMLAttributes } from "react";
import { buttonVariants } from "./Button";
import { dialogContentVariants, type DialogSize } from "./Dialog";
import { cn } from "./cn";
import { scrimMotion } from "./styles";

export const AlertDialog = AlertDialogPrimitive.Root;
export const AlertDialogTrigger = AlertDialogPrimitive.Trigger;
export const AlertDialogPortal = AlertDialogPrimitive.Portal;

export interface AlertDialogContentProps extends ComponentPropsWithoutRef<typeof AlertDialogPrimitive.Content> {
  size?: DialogSize;
}

export const AlertDialogContent = forwardRef<ElementRef<typeof AlertDialogPrimitive.Content>, AlertDialogContentProps>(
  function AlertDialogContent({ className, size = "sm", ...rest }, ref) {
    return (
      <AlertDialogPrimitive.Portal>
        <AlertDialogPrimitive.Overlay
          className={cn(
            "fixed inset-0 z-50 grid place-items-center overflow-y-auto bg-scrim/75 p-4 backdrop-blur-[2px]",
            scrimMotion,
          )}
        >
          <AlertDialogPrimitive.Content ref={ref} className={cn(dialogContentVariants({ size }), className)} {...rest} />
        </AlertDialogPrimitive.Overlay>
      </AlertDialogPrimitive.Portal>
    );
  },
);

export function AlertDialogHeader({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("flex flex-col gap-1.5 px-6 pt-5", className)} {...rest} />;
}

export function AlertDialogBody({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("relative min-h-0 flex-1 overflow-y-auto px-6 py-4", className)} {...rest} />;
}

export function AlertDialogFooter({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        "flex shrink-0 flex-col-reverse gap-2 border-t border-border px-6 py-3.5 sm:flex-row sm:items-center sm:justify-end",
        className,
      )}
      {...rest}
    />
  );
}

export const AlertDialogTitle = forwardRef<
  ElementRef<typeof AlertDialogPrimitive.Title>,
  ComponentPropsWithoutRef<typeof AlertDialogPrimitive.Title>
>(function AlertDialogTitle({ className, ...rest }, ref) {
  return <AlertDialogPrimitive.Title ref={ref} className={cn("text-title font-semibold text-text", className)} {...rest} />;
});

export const AlertDialogDescription = forwardRef<
  ElementRef<typeof AlertDialogPrimitive.Description>,
  ComponentPropsWithoutRef<typeof AlertDialogPrimitive.Description>
>(function AlertDialogDescription({ className, ...rest }, ref) {
  return (
    <AlertDialogPrimitive.Description ref={ref} className={cn("text-body text-text-muted", className)} {...rest} />
  );
});

export const AlertDialogAction = forwardRef<
  ElementRef<typeof AlertDialogPrimitive.Action>,
  ComponentPropsWithoutRef<typeof AlertDialogPrimitive.Action>
>(function AlertDialogAction({ className, ...rest }, ref) {
  return <AlertDialogPrimitive.Action ref={ref} className={cn(buttonVariants(), className)} {...rest} />;
});

export const AlertDialogCancel = forwardRef<
  ElementRef<typeof AlertDialogPrimitive.Cancel>,
  ComponentPropsWithoutRef<typeof AlertDialogPrimitive.Cancel>
>(function AlertDialogCancel({ className, ...rest }, ref) {
  return <AlertDialogPrimitive.Cancel ref={ref} className={cn(buttonVariants({ variant: "ghost" }), className)} {...rest} />;
});
