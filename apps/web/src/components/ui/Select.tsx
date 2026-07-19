import { forwardRef, type SelectHTMLAttributes } from "react";
import { Icon } from "./Icon";
import { cn } from "./cn";

export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(
  function Select({ className, children, ...rest }, ref) {
    return (
      <span className="relative inline-block w-full">
        <select
          ref={ref}
          className={cn("field-input appearance-none pr-8", className)}
          {...rest}
        >
          {children}
        </select>
        <Icon
          name="expand_more"
          size={16}
          className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-text-subtle"
        />
      </span>
    );
  },
);
