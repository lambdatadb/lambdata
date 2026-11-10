import { forwardRef, type InputHTMLAttributes, type ReactNode } from "react";
import { useFieldControl } from "./Field";
import { cn } from "./cn";
import { controlBase, controlFocus } from "./styles";

const heights = {
  sm: "h-8 px-2.5",
  md: "h-9 px-3",
  lg: "h-10 px-3.5",
};

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  inputSize?: keyof typeof heights;
  mono?: boolean;
  invalid?: boolean;
  leading?: ReactNode;
  trailing?: ReactNode;
  wrapperClassName?: string;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { className, inputSize = "md", mono = false, invalid, leading, trailing, wrapperClassName, type = "text", ...rest },
  ref,
) {
  const props = useFieldControl({ ...rest, "aria-invalid": invalid || rest["aria-invalid"] || undefined });
  const input = (
    <input
      ref={ref}
      type={type}
      className={cn(
        controlBase,
        controlFocus,
        heights[inputSize],
        "min-w-0 file:mr-3 file:border-0 file:bg-transparent file:text-label file:font-medium file:text-text",
        mono && "font-mono text-code",
        leading && "pl-9",
        trailing && "pr-9",
        className,
      )}
      {...props}
    />
  );
  if (!leading && !trailing) return input;
  return (
    <div className={cn("relative w-full", wrapperClassName)}>
      {leading && (
        <span className="pointer-events-none absolute inset-y-0 left-0 flex w-9 items-center justify-center text-text-subtle [&_svg:not([class*='size-'])]:size-4">
          {leading}
        </span>
      )}
      {input}
      {trailing && (
        <span className="absolute inset-y-0 right-0 flex min-w-9 items-center justify-center pr-1 text-text-subtle [&_svg:not([class*='size-'])]:size-4">
          {trailing}
        </span>
      )}
    </div>
  );
});
