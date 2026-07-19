import type { HTMLAttributes, ReactNode } from "react";
import { cn } from "./cn";

export function Card({ className, children, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={cn("card-surface relative p-5", className)} {...rest}>
      {children}
    </div>
  );
}

export function CardHeader({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("mb-4 flex items-start justify-between gap-3", className)} {...rest} />;
}

export function CardTitle({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return <h3 className={cn("text-[15px] font-semibold tracking-tight", className)} {...rest} />;
}

export function SectionLabel({ children }: { children: ReactNode; dot?: boolean }) {
  return <div className="mb-3 text-label font-medium text-text-muted">{children}</div>;
}
