import { forwardRef, type TextareaHTMLAttributes } from "react";
import { cn } from "./cn";

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(
  function Textarea({ className, ...rest }, ref) {
    return <textarea ref={ref} className={cn("field-input min-h-[6rem] font-mono", className)} {...rest} />;
  },
);
