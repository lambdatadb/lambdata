import { Slot } from "@radix-ui/react-slot";
import { createContext, forwardRef, useContext, type HTMLAttributes, type ReactNode } from "react";
import { cn } from "./cn";

const CardContext = createContext<{ flush: boolean }>({ flush: false });

export interface CardProps extends HTMLAttributes<HTMLDivElement> {
  flush?: boolean;
  variant?: "panel" | "inset" | "outline";
  interactive?: boolean;
  asChild?: boolean;
}

const variants = {
  panel: "border-border bg-bg-panel",
  inset: "border-border bg-bg-inset",
  outline: "border-border bg-transparent",
};

export const Card = forwardRef<HTMLDivElement, CardProps>(function Card(
  { className, flush = false, variant = "panel", interactive = false, asChild = false, children, ...rest },
  ref,
) {
  const Comp = asChild ? Slot : "div";
  return (
    <CardContext.Provider value={{ flush }}>
      <Comp
        ref={ref}
        className={cn(
          "relative min-w-0 rounded-lg border",
          variants[variant],
          !flush && "p-5",
          flush && "flex flex-col overflow-hidden",
          interactive && "transition-colors hover:border-border-strong focus-within:border-border-strong",
          className,
        )}
        {...rest}
      >
        {children}
      </Comp>
    </CardContext.Provider>
  );
});

export interface CardHeaderProps extends Omit<HTMLAttributes<HTMLDivElement>, "title"> {
  divided?: boolean;
  title?: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
}

export function CardHeader({ className, divided, title, description, action, children, ...rest }: CardHeaderProps) {
  const { flush } = useContext(CardContext);
  return (
    <div
      className={cn(
        "flex min-w-0 flex-wrap items-start justify-between gap-x-4 gap-y-2",
        flush ? "px-5 py-4" : "mb-4",
        divided && "border-b border-border",
        divided && !flush && "pb-4",
        className,
      )}
      {...rest}
    >
      {title !== undefined || description !== undefined ? (
        <div className="min-w-0 flex-[1_1_16rem] space-y-0.5">
          {title !== undefined && <CardTitle>{title}</CardTitle>}
          {description !== undefined && <CardDescription>{description}</CardDescription>}
        </div>
      ) : null}
      {children}
      {action !== undefined && <CardAction>{action}</CardAction>}
    </div>
  );
}

export function CardTitle({ className, ...rest }: HTMLAttributes<HTMLHeadingElement>) {
  return <h3 className={cn("text-heading font-semibold text-text", className)} {...rest} />;
}

export function CardDescription({ className, ...rest }: HTMLAttributes<HTMLParagraphElement>) {
  return <p className={cn("text-body text-text-muted", className)} {...rest} />;
}

export function CardAction({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("flex shrink-0 items-center gap-2", className)} {...rest} />;
}

export function CardContent({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  const { flush } = useContext(CardContext);
  return <div className={cn("min-w-0", flush && "px-5 py-4", className)} {...rest} />;
}

export function CardFooter({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  const { flush } = useContext(CardContext);
  return (
    <div
      className={cn(
        "flex flex-wrap items-center justify-end gap-2 border-t border-border",
        flush ? "px-5 py-3" : "-mx-5 -mb-5 mt-5 px-5 py-3",
        className,
      )}
      {...rest}
    />
  );
}

export interface SectionLabelProps extends HTMLAttributes<HTMLDivElement> {
  dot?: boolean;
}

export function SectionLabel({ children, dot = false, className, ...rest }: SectionLabelProps) {
  return (
    <div className={cn("mb-3 flex items-center gap-2 text-label font-medium text-text-muted", className)} {...rest}>
      {dot && <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-text-subtle" />}
      {children}
    </div>
  );
}
