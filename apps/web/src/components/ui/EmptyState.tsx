import type { ReactNode } from "react";
import { Icon } from "./Icon";
import { cn } from "./cn";

interface Props {
  icon?: string;
  title: string;
  description?: ReactNode;
  action?: ReactNode;
  className?: string;
}

export function EmptyState({ icon, title, description, action, className }: Props) {
  return (
    <div className={cn("card-surface flex flex-col items-center justify-center p-12 text-center", className)}>
      {icon && (
        <div className="mb-3 flex size-10 items-center justify-center rounded-lg bg-bg-subtle text-text-subtle">
          <Icon name={icon} size={20} />
        </div>
      )}
      <div className="text-body font-medium">{title}</div>
      {description && <div className="mt-1 max-w-sm text-body text-text-muted">{description}</div>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}
