import { forwardRef, type InputHTMLAttributes } from "react";
import { cn } from "./cn";

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  function Input({ className, ...rest }, ref) {
    return <input ref={ref} className={cn("field-input", className)} {...rest} />;
  },
);

interface FieldProps {
  label: string;
  hint?: string;
  required?: boolean;
  children: React.ReactNode;
}

export function Field({ label, hint, required, children }: FieldProps) {
  return (
    <label className="block space-y-1.5">
      <span className="block text-label font-medium text-text-muted">
        {label}
        {required && <span className="ml-1 text-danger">*</span>}
      </span>
      {children}
      {hint && <span className="block text-micro text-text-subtle">{hint}</span>}
    </label>
  );
}
