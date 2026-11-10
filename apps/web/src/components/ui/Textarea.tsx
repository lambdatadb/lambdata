import { forwardRef, type TextareaHTMLAttributes } from "react";
import { useFieldControl } from "./Field";
import { cn } from "./cn";
import { controlBase, controlFocus } from "./styles";

export interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  mono?: boolean;
  invalid?: boolean;
}

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea(
  { className, mono = true, invalid, ...rest },
  ref,
) {
  const props = useFieldControl({ ...rest, "aria-invalid": invalid || rest["aria-invalid"] || undefined });
  return (
    <textarea
      ref={ref}
      className={cn(
        controlBase,
        controlFocus,
        "block min-h-24 resize-y px-3 py-2",
        mono ? "font-mono text-code" : "text-body",
        className,
      )}
      {...props}
    />
  );
});
