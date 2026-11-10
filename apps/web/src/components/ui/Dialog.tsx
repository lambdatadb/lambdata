import * as DialogPrimitive from "@radix-ui/react-dialog";
import { cva, type VariantProps } from "class-variance-authority";
import { X } from "lucide-react";
import {
  forwardRef,
  type ComponentPropsWithoutRef,
  type ElementRef,
  type HTMLAttributes,
  type ReactNode,
  type RefObject,
} from "react";
import { cn } from "./cn";
import { focusRing, scrimMotion } from "./styles";

export const DialogRoot = DialogPrimitive.Root;
export const DialogTrigger = DialogPrimitive.Trigger;
export const DialogPortal = DialogPrimitive.Portal;
export const DialogClose = DialogPrimitive.Close;

export const dialogContentVariants = cva(
  [
    "relative my-auto flex max-h-[calc(100dvh-2rem)] w-full flex-col overflow-hidden rounded-xl border border-border-strong bg-bg-panel text-text shadow-overlay outline-none",
    "data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0",
    "data-[state=closed]:zoom-out-[0.98] data-[state=open]:zoom-in-[0.98] data-[state=open]:slide-in-from-bottom-2 duration-200",
  ],
  {
    variants: {
      size: {
        sm: "max-w-sm",
        md: "max-w-md",
        lg: "max-w-lg",
        xl: "max-w-xl",
        "2xl": "max-w-2xl",
        "3xl": "max-w-3xl",
        "4xl": "max-w-4xl",
      },
    },
    defaultVariants: { size: "md" },
  },
);

export type DialogSize = NonNullable<VariantProps<typeof dialogContentVariants>["size"]>;

export const DialogOverlay = forwardRef<
  ElementRef<typeof DialogPrimitive.Overlay>,
  ComponentPropsWithoutRef<typeof DialogPrimitive.Overlay>
>(function DialogOverlay({ className, ...rest }, ref) {
  return (
    <DialogPrimitive.Overlay
      ref={ref}
      className={cn(
        "fixed inset-0 z-50 grid place-items-center overflow-y-auto bg-scrim/75 p-4 backdrop-blur-[2px]",
        scrimMotion,
        className,
      )}
      {...rest}
    />
  );
});

export interface DialogContentProps extends ComponentPropsWithoutRef<typeof DialogPrimitive.Content> {
  size?: DialogSize;
  hideClose?: boolean;
  dismissible?: boolean;
  overlayClassName?: string;
  initialFocus?: RefObject<HTMLElement | null>;
}

export const DialogContent = forwardRef<ElementRef<typeof DialogPrimitive.Content>, DialogContentProps>(
  function DialogContent(
    {
      className,
      overlayClassName,
      size,
      hideClose = false,
      dismissible = true,
      initialFocus,
      children,
      onEscapeKeyDown,
      onPointerDownOutside,
      onInteractOutside,
      onOpenAutoFocus,
      ...rest
    },
    ref,
  ) {
    return (
      <DialogPrimitive.Portal>
        <DialogOverlay className={overlayClassName}>
          <DialogPrimitive.Content
            ref={ref}
            className={cn(dialogContentVariants({ size }), className)}
            onOpenAutoFocus={(event) => {
              onOpenAutoFocus?.(event);
              if (initialFocus?.current && !event.defaultPrevented) {
                event.preventDefault();
                initialFocus.current.focus();
              }
            }}
            onEscapeKeyDown={(event) => {
              if (!dismissible) event.preventDefault();
              onEscapeKeyDown?.(event);
            }}
            onPointerDownOutside={(event) => {
              if (!dismissible) event.preventDefault();
              onPointerDownOutside?.(event);
            }}
            onInteractOutside={(event) => {
              if (!dismissible) event.preventDefault();
              onInteractOutside?.(event);
            }}
            {...rest}
          >
            {children}
            {!hideClose && dismissible && (
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
        </DialogOverlay>
      </DialogPrimitive.Portal>
    );
  },
);

export function DialogHeader({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("flex shrink-0 flex-col gap-1 px-6 pb-1 pr-14 pt-5", className)} {...rest} />;
}

export function DialogBody({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("relative min-h-0 flex-1 overflow-y-auto px-6 py-4", className)} {...rest} />;
}

export function DialogFooter({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        "flex shrink-0 flex-col-reverse gap-2 border-t border-border bg-bg-panel px-6 py-3.5 sm:flex-row sm:items-center sm:justify-end",
        className,
      )}
      {...rest}
    />
  );
}

export const DialogTitle = forwardRef<
  ElementRef<typeof DialogPrimitive.Title>,
  ComponentPropsWithoutRef<typeof DialogPrimitive.Title>
>(function DialogTitle({ className, ...rest }, ref) {
  return <DialogPrimitive.Title ref={ref} className={cn("text-title font-semibold text-text", className)} {...rest} />;
});

export const DialogDescription = forwardRef<
  ElementRef<typeof DialogPrimitive.Description>,
  ComponentPropsWithoutRef<typeof DialogPrimitive.Description>
>(function DialogDescription({ className, ...rest }, ref) {
  return <DialogPrimitive.Description ref={ref} className={cn("text-body text-text-muted", className)} {...rest} />;
});

export interface DialogProps {
  open: boolean;
  onClose: () => void;
  title?: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  size?: DialogSize;
  hideClose?: boolean;
  dismissible?: boolean;
  label?: string;
  initialFocus?: RefObject<HTMLElement | null>;
  className?: string;
  bodyClassName?: string;
}

export function Dialog({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  size = "md",
  hideClose = false,
  dismissible = true,
  label = "Dialog",
  initialFocus,
  className,
  bodyClassName,
}: DialogProps) {
  return (
    <DialogPrimitive.Root
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogContent
        size={size}
        hideClose={hideClose}
        dismissible={dismissible}
        initialFocus={initialFocus}
        className={className}
        {...(description ? {} : { "aria-describedby": undefined })}
      >
        {title ? (
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            {description && <DialogDescription>{description}</DialogDescription>}
          </DialogHeader>
        ) : (
          <DialogPrimitive.Title className="sr-only">{label}</DialogPrimitive.Title>
        )}
        <DialogBody className={cn(!title && "pt-6", !footer && "pb-6", bodyClassName)}>{children}</DialogBody>
        {footer && <DialogFooter>{footer}</DialogFooter>}
      </DialogContent>
    </DialogPrimitive.Root>
  );
}
