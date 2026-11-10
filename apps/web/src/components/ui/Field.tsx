import { CircleAlert } from "lucide-react";
import { createContext, useContext, useId, type HTMLAttributes, type ReactNode } from "react";
import { Label } from "./Label";
import { cn } from "./cn";

interface FieldContextValue {
  id: string;
  hintId?: string;
  errorId?: string;
  invalid: boolean;
  required: boolean;
  disabled: boolean;
}

const FieldContext = createContext<FieldContextValue | null>(null);

export function useFieldContext(): FieldContextValue | null {
  return useContext(FieldContext);
}

interface ControlProps {
  id?: string;
  "aria-describedby"?: string;
  "aria-invalid"?: boolean | "true" | "false" | "grammar" | "spelling";
  required?: boolean;
  disabled?: boolean;
}

export function useFieldControl<T extends ControlProps>(props: T): T {
  const field = useContext(FieldContext);
  if (!field) return props;
  const describedBy = [props["aria-describedby"], field.hintId, field.errorId].filter(Boolean).join(" ") || undefined;
  return {
    ...props,
    id: props.id ?? field.id,
    "aria-describedby": describedBy,
    "aria-invalid": props["aria-invalid"] ?? (field.invalid || undefined),
    required: props.required ?? (field.required || undefined),
    disabled: props.disabled ?? (field.disabled || undefined),
  };
}

export interface FieldProps {
  label?: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  required?: boolean;
  disabled?: boolean;
  id?: string;
  labelAction?: ReactNode;
  hideLabel?: boolean;
  className?: string;
  children: ReactNode;
}

export function Field({
  label,
  hint,
  error,
  required = false,
  disabled = false,
  id,
  labelAction,
  hideLabel = false,
  className,
  children,
}: FieldProps) {
  const autoId = useId();
  const controlId = id ?? `field${autoId.replace(/:/g, "")}`;
  const hintId = hint ? `${controlId}-hint` : undefined;
  const errorId = error ? `${controlId}-error` : undefined;
  const value: FieldContextValue = { id: controlId, hintId, errorId, invalid: !!error, required, disabled };

  return (
    <FieldContext.Provider value={value}>
      <div className={cn("flex min-w-0 flex-col gap-1.5", className)} data-invalid={error ? "" : undefined}>
        {(label || labelAction) && (
          <div className={cn("flex min-h-4 items-center justify-between gap-3", hideLabel && "sr-only")}>
            {label && (
              <Label id={`${controlId}-label`} htmlFor={controlId} required={required}>
                {label}
              </Label>
            )}
            {labelAction && <div className="text-label text-text-muted">{labelAction}</div>}
          </div>
        )}
        {children}
        {hint && !error && (
          <p id={hintId} className="text-micro text-text-subtle">
            {hint}
          </p>
        )}
        {hint && error && (
          <p id={hintId} className="sr-only">
            {hint}
          </p>
        )}
        {error && <FieldError id={errorId}>{error}</FieldError>}
      </div>
    </FieldContext.Provider>
  );
}

export function FieldError({ className, children, ...rest }: HTMLAttributes<HTMLParagraphElement>) {
  return (
    <p role="alert" className={cn("flex items-start gap-1.5 text-micro text-danger", className)} {...rest}>
      <CircleAlert aria-hidden className="mt-px size-3.5 shrink-0" />
      <span>{children}</span>
    </p>
  );
}

export function FieldHint({ className, ...rest }: HTMLAttributes<HTMLParagraphElement>) {
  return <p className={cn("text-micro text-text-subtle", className)} {...rest} />;
}

export function FieldGroup({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("grid grid-cols-1 gap-4 sm:grid-cols-2", className)} {...rest} />;
}

export interface FieldsetProps extends HTMLAttributes<HTMLFieldSetElement> {
  legend: ReactNode;
  description?: ReactNode;
  disabled?: boolean;
}

export function Fieldset({ legend, description, className, children, ...rest }: FieldsetProps) {
  return (
    <fieldset className={cn("min-w-0", className)} {...rest}>
      <legend className="text-heading font-semibold text-text">{legend}</legend>
      {description && <p className="mt-1 text-body text-text-muted">{description}</p>}
      <div className="mt-4 space-y-4">{children}</div>
    </fieldset>
  );
}
