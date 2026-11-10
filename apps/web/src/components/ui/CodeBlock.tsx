import { WrapText } from "lucide-react";
import { useState, type ReactNode } from "react";
import { Button } from "./Button";
import { CopyButton } from "./CopyableField";
import { SimpleTooltip } from "./Tooltip";
import { cn } from "./cn";

export interface CodeBlockProps {
  code: string;
  language?: string;
  title?: ReactNode;
  wrap?: boolean;
  wrapToggle?: boolean;
  copy?: boolean;
  lineNumbers?: boolean;
  maxHeight?: number | string;
  actions?: ReactNode;
  className?: string;
}

export function CodeBlock({
  code,
  language,
  title,
  wrap: initialWrap = false,
  wrapToggle = true,
  copy = true,
  lineNumbers = false,
  maxHeight,
  actions,
  className,
}: CodeBlockProps) {
  const [wrap, setWrap] = useState(initialWrap);
  const lines = lineNumbers ? code.replace(/\n$/, "").split("\n") : null;
  const hasHeader = Boolean(title || language || actions || wrapToggle);
  const label = typeof title === "string" ? title : language ? `${language} code` : "Code";
  return (
    <div className={cn("relative min-w-0 overflow-hidden rounded-lg border border-border bg-bg-inset", className)}>
      {hasHeader && (
        <div className="flex h-9 items-center justify-between gap-2 border-b border-border pl-3.5 pr-1">
          <div className="flex min-w-0 items-center gap-2 text-label">
            {title && <span className="truncate font-medium text-text">{title}</span>}
            {language && <span className="font-mono text-micro uppercase tracking-wider text-text-subtle">{language}</span>}
          </div>
          <div className="flex shrink-0 items-center gap-0.5">
            {actions}
            {wrapToggle && (
              <SimpleTooltip content={wrap ? "Disable line wrap" : "Wrap long lines"}>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  aria-label="Wrap long lines"
                  aria-pressed={wrap}
                  className={cn(wrap && "bg-bg-hover text-text")}
                  onClick={() => setWrap((v) => !v)}
                >
                  <WrapText aria-hidden />
                </Button>
              </SimpleTooltip>
            )}
            {copy && <CopyButton value={code} label={typeof title === "string" ? title.toLowerCase() : "code"} size="icon-xs" />}
          </div>
        </div>
      )}
      <div className="flex min-w-0 items-start">
        <pre
          tabIndex={0}
          aria-label={label}
          style={maxHeight !== undefined ? { maxHeight } : undefined}
          className={cn(
            "min-w-0 flex-1 overflow-auto px-4 py-3 font-mono text-code text-text outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70",
            wrap ? "whitespace-pre-wrap break-all" : "whitespace-pre",
          )}
        >
          {lines ? (
            <code className="grid grid-cols-[auto_1fr] gap-x-4">
              {lines.map((line, i) => (
                <span key={i} className="contents">
                  <span aria-hidden className="select-none text-right text-text-subtle">
                    {i + 1}
                  </span>
                  <span>{line || " "}</span>
                </span>
              ))}
            </code>
          ) : (
            <code>{code}</code>
          )}
        </pre>
        {!hasHeader && copy && (
          <div className="shrink-0 p-1.5">
            <CopyButton value={code} label="code" size="icon-xs" />
          </div>
        )}
      </div>
    </div>
  );
}
