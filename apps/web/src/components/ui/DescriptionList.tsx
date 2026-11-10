import { createContext, useContext, type HTMLAttributes, type ReactNode } from "react";
import { cn } from "./cn";

type Layout = "rows" | "grid" | "stacked";

const LayoutContext = createContext<Layout>("rows");

export interface DescriptionEntry {
  term: ReactNode;
  value: ReactNode;
  mono?: boolean;
}

export interface DescriptionListProps extends HTMLAttributes<HTMLDListElement> {
  items?: DescriptionEntry[];
  layout?: Layout;
}

export function DescriptionList({ items, layout = "rows", className, children, ...rest }: DescriptionListProps) {
  return (
    <LayoutContext.Provider value={layout}>
      <dl
        className={cn(
          layout === "rows" && "divide-y divide-border",
          layout === "grid" && "grid grid-cols-1 gap-x-6 gap-y-4 sm:grid-cols-2",
          layout === "stacked" && "space-y-3",
          className,
        )}
        {...rest}
      >
        {items?.map((item, i) => (
          <DescriptionItem key={i} term={item.term} mono={item.mono}>
            {item.value}
          </DescriptionItem>
        ))}
        {children}
      </dl>
    </LayoutContext.Provider>
  );
}

export interface DescriptionItemProps {
  term: ReactNode;
  mono?: boolean;
  className?: string;
  children: ReactNode;
}

export function DescriptionItem({ term, mono = false, className, children }: DescriptionItemProps) {
  const layout = useContext(LayoutContext);
  return (
    <div
      className={cn(
        layout === "rows" ? "flex min-w-0 items-baseline justify-between gap-4 py-2.5 first:pt-0 last:pb-0" : "min-w-0 space-y-1",
        className,
      )}
    >
      <dt className="shrink-0 text-label text-text-muted">{term}</dt>
      <dd
        className={cn(
          "min-w-0 break-words text-text",
          layout === "rows" && "text-right",
          mono ? "font-mono text-code" : "text-body",
        )}
      >
        {children}
      </dd>
    </div>
  );
}
