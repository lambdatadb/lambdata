import { Slot } from "@radix-ui/react-slot";
import { ChevronRight, Ellipsis } from "lucide-react";
import { forwardRef, type AnchorHTMLAttributes, type HTMLAttributes, type LiHTMLAttributes } from "react";
import { cn } from "./cn";
import { focusRing } from "./styles";

export function Breadcrumb({ className, ...rest }: HTMLAttributes<HTMLElement>) {
  return <nav aria-label="Breadcrumb" className={cn("min-w-0", className)} {...rest} />;
}

export function BreadcrumbList({ className, ...rest }: HTMLAttributes<HTMLOListElement>) {
  return (
    <ol
      className={cn("flex min-w-0 flex-wrap items-center gap-1 break-words text-label text-text-muted", className)}
      {...rest}
    />
  );
}

export function BreadcrumbItem({ className, ...rest }: LiHTMLAttributes<HTMLLIElement>) {
  return <li className={cn("inline-flex min-w-0 items-center gap-1", className)} {...rest} />;
}

export interface BreadcrumbLinkProps extends AnchorHTMLAttributes<HTMLAnchorElement> {
  asChild?: boolean;
}

export const BreadcrumbLink = forwardRef<HTMLAnchorElement, BreadcrumbLinkProps>(function BreadcrumbLink(
  { className, asChild = false, ...rest },
  ref,
) {
  const Comp = asChild ? Slot : "a";
  return (
    <Comp
      ref={ref}
      className={cn("truncate rounded-sm transition-colors hover:text-text", focusRing, className)}
      {...rest}
    />
  );
});

export function BreadcrumbPage({ className, ...rest }: HTMLAttributes<HTMLSpanElement>) {
  return <span aria-current="page" className={cn("truncate font-medium text-text", className)} {...rest} />;
}

export function BreadcrumbSeparator({ className, children, ...rest }: LiHTMLAttributes<HTMLLIElement>) {
  return (
    <li role="presentation" aria-hidden className={cn("text-text-subtle [&>svg]:size-3.5", className)} {...rest}>
      {children ?? <ChevronRight />}
    </li>
  );
}

export function BreadcrumbEllipsis({ className, ...rest }: HTMLAttributes<HTMLSpanElement>) {
  return (
    <span role="presentation" aria-hidden className={cn("flex size-5 items-center justify-center", className)} {...rest}>
      <Ellipsis className="size-4" />
    </span>
  );
}
