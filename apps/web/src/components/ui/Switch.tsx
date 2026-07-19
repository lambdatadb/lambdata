import { cn } from "./cn";

interface Props {
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
  label?: string;
  description?: string;
}

export function Switch({ checked, onChange, disabled, label, description }: Props) {
  return (
    <label className={cn("flex items-start gap-3 cursor-pointer select-none", disabled && "opacity-60 cursor-not-allowed")}>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={cn(
          "relative inline-flex h-5 w-9 shrink-0 mt-0.5 rounded-full transition-colors",
          checked ? "bg-accent" : "bg-border-strong",
        )}
      >
        <span
          className={cn(
            "absolute top-0.5 size-4 rounded-full bg-white transition-transform",
            checked ? "translate-x-[18px]" : "translate-x-0.5",
          )}
        />
      </button>
      {(label || description) && (
        <div className="flex-1 -mt-0.5">
          {label && <div className="text-sm font-medium">{label}</div>}
          {description && <div className="text-xs text-text-muted">{description}</div>}
        </div>
      )}
    </label>
  );
}
