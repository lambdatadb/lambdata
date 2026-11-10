import * as TabsPrimitive from "@radix-ui/react-tabs";
import {
  createContext,
  forwardRef,
  useContext,
  type ComponentPropsWithoutRef,
  type ElementRef,
  type ReactNode,
} from "react";
import { cn } from "./cn";
import { focusRing, focusRingInset } from "./styles";

type TabsVariant = "underline" | "pills";

const VariantContext = createContext<TabsVariant>("underline");

export type TabsProps = ComponentPropsWithoutRef<typeof TabsPrimitive.Root>;

export const Tabs = forwardRef<ElementRef<typeof TabsPrimitive.Root>, TabsProps>(function Tabs({ className, ...rest }, ref) {
  return <TabsPrimitive.Root ref={ref} className={cn("flex min-w-0 flex-col gap-4", className)} {...rest} />;
});

export const TabsRoot = TabsPrimitive.Root;

export interface TabsListProps extends ComponentPropsWithoutRef<typeof TabsPrimitive.List> {
  variant?: TabsVariant;
}

export const TabsList = forwardRef<ElementRef<typeof TabsPrimitive.List>, TabsListProps>(function TabsList(
  { className, variant = "underline", ...rest },
  ref,
) {
  return (
    <VariantContext.Provider value={variant}>
      <TabsPrimitive.List
        ref={ref}
        className={cn(
          variant === "underline"
            ? "scrollbar-none flex min-w-0 items-stretch gap-1 overflow-x-auto border-b border-border"
            : "scrollbar-none inline-flex w-fit max-w-full items-center gap-0.5 self-start overflow-x-auto rounded-md border border-border bg-bg-inset p-0.5",
          className,
        )}
        {...rest}
      />
    </VariantContext.Provider>
  );
});

export interface TabsTriggerProps extends ComponentPropsWithoutRef<typeof TabsPrimitive.Trigger> {
  icon?: ReactNode;
  count?: ReactNode;
}

export const TabsTrigger = forwardRef<ElementRef<typeof TabsPrimitive.Trigger>, TabsTriggerProps>(function TabsTrigger(
  { className, icon, count, children, asChild, ...rest },
  ref,
) {
  const variant = useContext(VariantContext);
  return (
    <TabsPrimitive.Trigger
      ref={ref}
      className={cn(
        "inline-flex shrink-0 items-center justify-center gap-1.5 whitespace-nowrap font-medium text-text-muted transition-colors hover:text-text disabled:pointer-events-none disabled:opacity-45 data-[state=active]:text-text [&_svg:not([class*='size-'])]:size-4 [&_svg]:shrink-0",
        variant === "underline"
          ? [
              "relative h-9 rounded-t-md px-3 text-body",
              "after:absolute after:inset-x-2 after:bottom-0 after:h-0.5 after:rounded-full after:bg-transparent after:transition-colors data-[state=active]:after:bg-accent",
              focusRingInset,
            ]
          : [
              "h-7 rounded-[5px] px-2.5 text-label data-[state=active]:bg-bg-selected data-[state=active]:shadow-[inset_0_0_0_1px_rgb(var(--edge-strong))]",
              "outline-none focus-visible:ring-2 focus-visible:ring-ring/70",
            ],
        className,
      )}
      asChild={asChild}
      {...rest}
    >
      {asChild ? (
        children
      ) : (
        <>
          {icon}
          {children}
          {count !== undefined && count !== null && (
            <span className="rounded-[4px] bg-bg-raised px-1.5 font-mono text-micro text-text-subtle">{count}</span>
          )}
        </>
      )}
    </TabsPrimitive.Trigger>
  );
});

export const TabsContent = forwardRef<
  ElementRef<typeof TabsPrimitive.Content>,
  ComponentPropsWithoutRef<typeof TabsPrimitive.Content>
>(function TabsContent({ className, ...rest }, ref) {
  return <TabsPrimitive.Content ref={ref} className={cn("min-w-0 rounded-md", focusRing, className)} {...rest} />;
});
