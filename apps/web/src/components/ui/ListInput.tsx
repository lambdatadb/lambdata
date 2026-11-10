import { Plus, X } from "lucide-react";
import { useState, type ReactNode } from "react";
import { Button } from "./Button";
import { FieldError, useFieldContext } from "./Field";
import { Input } from "./Input";
import { cn } from "./cn";

export interface ListInputProps {
  values: string[];
  onChange: (values: string[]) => void;
  placeholder?: string;
  addLabel?: string;
  emptyText?: ReactNode;
  disabled?: boolean;
  mono?: boolean;
  validate?: (value: string) => string | null;
  normalize?: (value: string) => string;
  "aria-label"?: string;
  className?: string;
}

export function ListInput({
  values,
  onChange,
  placeholder,
  addLabel = "Add",
  emptyText,
  disabled = false,
  mono = true,
  validate,
  normalize = (value) => value.trim(),
  "aria-label": ariaLabel,
  className,
}: ListInputProps) {
  const field = useFieldContext();
  const [draft, setDraft] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const locked = disabled || field?.disabled;
  const labelledBy = !ariaLabel && field ? `${field.id}-label` : undefined;

  const add = () => {
    const value = normalize(draft);
    if (!value) return;
    const invalid = validate?.(value) ?? null;
    if (invalid) {
      setProblem(invalid);
      return;
    }
    if (!values.includes(value)) onChange([...values, value]);
    setDraft("");
    setProblem(null);
  };

  return (
    <div className={cn("min-w-0 space-y-2", className)}>
      {values.length === 0 ? (
        emptyText ? (
          <p className="text-label text-text-subtle">{emptyText}</p>
        ) : null
      ) : (
        <ul
          className="flex flex-wrap gap-1.5"
          aria-label={ariaLabel}
          aria-labelledby={labelledBy}
        >
          {values.map((value) => (
            <li
              key={value}
              className={cn(
                "inline-flex h-7 max-w-full items-center gap-1 rounded-md border border-border-strong bg-bg-raised pl-2.5 text-text",
                mono ? "font-mono text-code" : "text-body",
                locked ? "pr-2.5" : "pr-0.5",
              )}
            >
              <span className="min-w-0 truncate" title={value}>
                {value}
              </span>
              {!locked && (
                <Button
                  variant="ghost"
                  size="icon-xs"
                  aria-label={`Remove ${value}`}
                  onClick={() => onChange(values.filter((v) => v !== value))}
                >
                  <X />
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
      {!locked && (
        <div className="flex gap-2">
          <Input
            mono={mono}
            inputSize="sm"
            value={draft}
            placeholder={placeholder}
            invalid={!!problem}
            autoComplete="off"
            spellCheck={false}
            onChange={(e) => {
              setDraft(e.target.value);
              setProblem(null);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                add();
              }
            }}
          />
          <Button variant="secondary" size="sm" onClick={add} disabled={!draft.trim()} className="shrink-0">
            <Plus aria-hidden /> {addLabel}
          </Button>
        </div>
      )}
      {problem && <FieldError>{problem}</FieldError>}
    </div>
  );
}
