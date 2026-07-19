import type { ReactNode } from "react";
import { Card } from "./Card";
import { Icon } from "./Icon";
import { RollingNumber } from "./RollingNumber";
import { cn } from "./cn";

interface Props {
  label: string;
  value: number | null | undefined;
  format?: (n: number) => string;
  hint?: ReactNode;
  icon?: string;
  className?: string;
  children?: ReactNode;
}

export function StatTile({ label, value, format, hint, icon, className, children }: Props) {
  return (
    <Card className={cn("p-4", className)}>
      <div className="flex items-center justify-between gap-2">
        <div className="text-label font-medium text-text-muted">{label}</div>
        {icon && <Icon name={icon} size={15} className="text-text-subtle" />}
      </div>
      <div className="mt-1.5 text-[22px] leading-7 font-semibold tracking-tight">
        <RollingNumber value={value} format={format} />
      </div>
      {hint && <div className="mt-1 text-micro text-text-subtle">{hint}</div>}
      {children && <div className="mt-3">{children}</div>}
    </Card>
  );
}
