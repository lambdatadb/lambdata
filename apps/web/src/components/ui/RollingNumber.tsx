import { SlotText } from "slot-text/react";
import "slot-text/style.css";
import { useReducedMotion } from "framer-motion";
import { cn } from "./cn";

/* Live metric readouts only — never table cells, badges, or static values. */

interface Props {
  value: number | null | undefined;
  format?: (n: number) => string;
  className?: string;
}

export function RollingNumber({ value, format, className }: Props) {
  const reduced = useReducedMotion();
  if (value === null || value === undefined) {
    return <span className={cn("tabular-nums", className)}>—</span>;
  }
  const text = format ? format(value) : String(value);
  if (reduced) {
    return <span className={cn("tabular-nums", className)}>{text}</span>;
  }
  return (
    <SlotText
      text={text}
      options={{ skipUnchanged: true, interrupt: false, stagger: 25, duration: 260, bounce: 0.25 }}
      className={cn("tabular-nums", className)}
    />
  );
}
