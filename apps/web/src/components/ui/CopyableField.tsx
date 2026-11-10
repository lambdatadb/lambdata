import { Check, Copy, Eye, EyeOff, X } from "lucide-react";
import { forwardRef, useId, useRef, useState, type ButtonHTMLAttributes } from "react";
import { Button, type ButtonSize, type ButtonVariant } from "./Button";
import { SimpleTooltip } from "./Tooltip";
import { cn } from "./cn";
import { useCopyToClipboard } from "./useCopyToClipboard";

export interface CopyButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "value" | "onCopy"> {
  value: string;
  label?: string;
  variant?: ButtonVariant;
  size?: ButtonSize;
  showText?: boolean;
  text?: string;
  copiedText?: string;
  onCopied?: (ok: boolean) => void;
}

export const CopyButton = forwardRef<HTMLButtonElement, CopyButtonProps>(function CopyButton(
  {
    value,
    label = "value",
    variant = "ghost",
    size = "icon-sm",
    showText: showTextProp = false,
    text = "Copy",
    copiedText = "Copied",
    onCopied,
    className,
    ...rest
  },
  ref,
) {
  const showText = showTextProp || text !== "Copy";
  const { state, copy } = useCopyToClipboard();
  const [hovered, setHovered] = useState(false);
  const tip = state === "copied" ? copiedText : state === "failed" ? "Copy blocked: select and press Ctrl or ⌘ C" : `Copy ${label}`;
  const icon =
    state === "copied" ? (
      <Check aria-hidden className="text-success" />
    ) : state === "failed" ? (
      <X aria-hidden className="text-danger" />
    ) : (
      <Copy aria-hidden />
    );
  return (
    <>
      <SimpleTooltip content={tip} open={hovered || state !== "idle"} onOpenChange={setHovered}>
        <Button
          ref={ref}
          variant={variant}
          size={showText ? (size?.startsWith("icon") ? "xs" : size) : size}
          aria-label={showText ? undefined : `Copy ${label}`}
          onClick={async () => {
            const ok = await copy(value);
            onCopied?.(ok);
          }}
          className={cn(state === "copied" && "text-success", state === "failed" && "text-danger", className)}
          {...rest}
        >
          {icon}
          {showText && <span>{state === "copied" ? copiedText : state === "failed" ? "Copy blocked" : text}</span>}
        </Button>
      </SimpleTooltip>
      <span className="sr-only" aria-live="polite">
        {state === "copied" ? `${label} copied` : state === "failed" ? `Could not copy ${label}. Select the text and copy it manually.` : ""}
      </span>
    </>
  );
});

interface Props {
  value: string;
  label?: string;
  monospace?: boolean;
  secret?: boolean;
  copyLabel?: string;
  size?: "sm" | "md";
  className?: string;
}

export function CopyableField({ value, label, monospace = true, secret = false, copyLabel, size = "md", className }: Props) {
  const inputId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [revealed, setRevealed] = useState(!secret);
  const name = copyLabel ?? label?.toLowerCase() ?? "value";
  return (
    <div className={cn("min-w-0", className)}>
      {label && (
        <label htmlFor={inputId} className="mb-1.5 block text-label font-medium text-text-muted">
          {label}
        </label>
      )}
      <div
        className={cn(
          "flex min-w-0 items-stretch overflow-hidden rounded-md border border-border-input bg-bg-inset transition-colors",
          "focus-within:border-ring/70 focus-within:ring-2 focus-within:ring-ring/20",
          size === "sm" ? "h-8" : "h-9",
        )}
      >
        <input
          id={inputId}
          ref={inputRef}
          readOnly
          value={value}
          type={secret && !revealed ? "password" : "text"}
          aria-label={label ? undefined : name}
          spellCheck={false}
          autoComplete="off"
          title={secret && !revealed ? undefined : value}
          className={cn(
            "min-w-0 flex-1 bg-transparent px-3 text-text outline-none",
            monospace ? "font-mono text-code" : "text-body",
          )}
        />
        <div className="flex shrink-0 items-center gap-0.5 border-l border-border px-0.5">
          {secret && (
            <SimpleTooltip content={revealed ? `Hide ${name}` : `Show ${name}`}>
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label={revealed ? `Hide ${name}` : `Show ${name}`}
                aria-pressed={revealed}
                onClick={() => setRevealed((v) => !v)}
              >
                {revealed ? <EyeOff aria-hidden /> : <Eye aria-hidden />}
              </Button>
            </SimpleTooltip>
          )}
          <CopyButton
            value={value}
            label={name}
            size="icon-xs"
            onCopied={(ok) => {
              if (!ok) {
                setRevealed(true);
                requestAnimationFrame(() => inputRef.current?.select());
              }
            }}
          />
        </div>
      </div>
    </div>
  );
}
