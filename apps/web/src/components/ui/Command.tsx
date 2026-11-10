import * as DialogPrimitive from "@radix-ui/react-dialog";
import { Command as CommandPrimitive } from "cmdk";
import { Search } from "lucide-react";
import { forwardRef, type ComponentPropsWithoutRef, type ElementRef, type HTMLAttributes, type ReactNode } from "react";
import { DialogContent } from "./Dialog";
import { cn } from "./cn";

export const Command = forwardRef<
  ElementRef<typeof CommandPrimitive>,
  ComponentPropsWithoutRef<typeof CommandPrimitive>
>(function Command({ className, ...rest }, ref) {
  return (
    <CommandPrimitive
      ref={ref}
      className={cn("flex h-full w-full flex-col overflow-hidden bg-transparent text-text", className)}
      {...rest}
    />
  );
});

export interface CommandDialogProps extends ComponentPropsWithoutRef<typeof DialogPrimitive.Root> {
  title?: string;
  description?: string;
  children: ReactNode;
  commandProps?: ComponentPropsWithoutRef<typeof CommandPrimitive>;
  className?: string;
}

export function CommandDialog({
  title = "Command menu",
  description = "Search for a page, database or action",
  children,
  commandProps,
  className,
  ...rest
}: CommandDialogProps) {
  return (
    <DialogPrimitive.Root {...rest}>
      <DialogContent
        size="xl"
        hideClose
        overlayClassName="items-start justify-items-center pt-[12dvh]"
        className={cn("my-0 max-h-[min(30rem,calc(100dvh-14dvh-1rem))] bg-bg-overlay", className)}
      >
        <DialogPrimitive.Title className="sr-only">{title}</DialogPrimitive.Title>
        <DialogPrimitive.Description className="sr-only">{description}</DialogPrimitive.Description>
        <Command {...commandProps} className={cn("min-h-0", commandProps?.className)}>
          {children}
        </Command>
      </DialogContent>
    </DialogPrimitive.Root>
  );
}

export const CommandInput = forwardRef<
  ElementRef<typeof CommandPrimitive.Input>,
  ComponentPropsWithoutRef<typeof CommandPrimitive.Input> & { trailing?: ReactNode }
>(function CommandInput({ className, trailing, ...rest }, ref) {
  return (
    <div className="flex shrink-0 items-center gap-2.5 border-b border-border px-4" cmdk-input-wrapper="">
      <Search className="size-4 shrink-0 text-text-subtle" aria-hidden />
      <CommandPrimitive.Input
        ref={ref}
        className={cn(
          "flex h-12 w-full min-w-0 bg-transparent text-body text-text outline-none placeholder:text-text-subtle disabled:cursor-not-allowed disabled:opacity-50",
          className,
        )}
        {...rest}
      />
      {trailing}
    </div>
  );
});

export const CommandList = forwardRef<
  ElementRef<typeof CommandPrimitive.List>,
  ComponentPropsWithoutRef<typeof CommandPrimitive.List>
>(function CommandList({ className, ...rest }, ref) {
  return (
    <CommandPrimitive.List
      ref={ref}
      className={cn("max-h-[22rem] min-h-0 flex-1 scroll-py-1 overflow-y-auto overflow-x-hidden p-1.5", className)}
      {...rest}
    />
  );
});

export const CommandEmpty = forwardRef<
  ElementRef<typeof CommandPrimitive.Empty>,
  ComponentPropsWithoutRef<typeof CommandPrimitive.Empty>
>(function CommandEmpty({ className, ...rest }, ref) {
  return <CommandPrimitive.Empty ref={ref} className={cn("py-10 text-center text-body text-text-muted", className)} {...rest} />;
});

export const CommandLoading = CommandPrimitive.Loading;

export const CommandGroup = forwardRef<
  ElementRef<typeof CommandPrimitive.Group>,
  ComponentPropsWithoutRef<typeof CommandPrimitive.Group>
>(function CommandGroup({ className, ...rest }, ref) {
  return (
    <CommandPrimitive.Group
      ref={ref}
      className={cn(
        "overflow-hidden text-text [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:pt-2 [&_[cmdk-group-heading]]:text-micro [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:text-text-subtle",
        className,
      )}
      {...rest}
    />
  );
});

export const CommandSeparator = forwardRef<
  ElementRef<typeof CommandPrimitive.Separator>,
  ComponentPropsWithoutRef<typeof CommandPrimitive.Separator>
>(function CommandSeparator({ className, ...rest }, ref) {
  return <CommandPrimitive.Separator ref={ref} className={cn("-mx-1.5 my-1.5 h-px bg-border", className)} {...rest} />;
});

export const CommandItem = forwardRef<
  ElementRef<typeof CommandPrimitive.Item>,
  ComponentPropsWithoutRef<typeof CommandPrimitive.Item>
>(function CommandItem({ className, ...rest }, ref) {
  return (
    <CommandPrimitive.Item
      ref={ref}
      className={cn(
        "relative flex min-h-9 cursor-default select-none items-center gap-2.5 rounded-md px-2.5 py-1.5 text-body text-text outline-none",
        "data-[disabled=true]:pointer-events-none data-[selected=true]:bg-bg-hover data-[disabled=true]:opacity-45",
        "[&_svg:not([class*='size-'])]:size-4 [&_svg]:shrink-0 [&_svg]:text-text-subtle data-[selected=true]:[&_svg]:text-text-muted",
        className,
      )}
      {...rest}
    />
  );
});

export function CommandShortcut({ className, ...rest }: HTMLAttributes<HTMLSpanElement>) {
  return <span className={cn("ml-auto font-mono text-micro tracking-wide text-text-subtle", className)} {...rest} />;
}
