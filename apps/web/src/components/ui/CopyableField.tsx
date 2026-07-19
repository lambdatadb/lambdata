import { useState } from "react";
import { SlotText } from "slot-text/react";
import "slot-text/style.css";
import { cn } from "./cn";

interface Props {
  value: string;
  label?: string;
  monospace?: boolean;
  className?: string;
}

export function CopyableField({ value, label, monospace = true, className }: Props) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    } catch {
      // ignore
    }
  };
  return (
    <div className={className}>
      {label && <div className="mb-1.5 text-label font-medium text-text-muted">{label}</div>}
      <div className="flex items-stretch gap-2">
        <div
          className={cn(
            "flex-1 px-3 py-2 rounded-md bg-bg-subtle border border-border text-sm truncate",
            monospace && "font-mono",
          )}
          title={value}
        >
          {value}
        </div>
        <button
          onClick={copy}
          className={cn(
            "px-3 rounded-md bg-bg-subtle border border-border text-label transition-colors",
            copied ? "text-success border-success/40" : "text-text-muted hover:text-text hover:border-border-strong",
          )}
          aria-label="Copy"
        >
          <SlotText text={copied ? "Copied" : "Copy"} options={{ stagger: 30, duration: 240, bounce: 0.3 }} />
        </button>
      </div>
    </div>
  );
}
