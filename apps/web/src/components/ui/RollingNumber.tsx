import { useSyncExternalStore } from "react";
import { SlotText } from "slot-text/react";
import "slot-text/style.css";
import { cn } from "./cn";

const REDUCED_MOTION = "(prefers-reduced-motion: reduce)";

function useReducedMotion(): boolean {
  return useSyncExternalStore(
    (onChange) => {
      if (typeof window === "undefined" || !window.matchMedia) return () => undefined;
      const query = window.matchMedia(REDUCED_MOTION);
      query.addEventListener("change", onChange);
      return () => query.removeEventListener("change", onChange);
    },
    () => (typeof window !== "undefined" && window.matchMedia ? window.matchMedia(REDUCED_MOTION).matches : false),
    () => false,
  );
}

interface Props {
  value: number | null | undefined;
  format?: (n: number) => string;
  className?: string;
}

export function RollingNumber({ value, format, className }: Props) {
  const reduced = useReducedMotion();
  if (value === null || value === undefined) {
    return (
      <span className={cn("tabular-nums text-text-subtle", className)}>
        <span aria-hidden>—</span>
        <span className="sr-only">No data</span>
      </span>
    );
  }
  const text = format ? format(value) : String(value);
  if (reduced) {
    return <span className={cn("tabular-nums", className)}>{text}</span>;
  }
  return (
    <span className={cn("inline-flex tabular-nums", className)}>
      <span className="sr-only">{text}</span>
      <span aria-hidden>
        <SlotText text={text} options={{ skipUnchanged: true, interrupt: false, stagger: 25, duration: 260, bounce: 0.2 }} />
      </span>
    </span>
  );
}
