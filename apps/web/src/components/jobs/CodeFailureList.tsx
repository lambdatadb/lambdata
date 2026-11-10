import type { CodeObjectFailure } from "@lambdata/shared";
import { Badge } from "../ui/Badge";
import { cn } from "../ui/cn";

export function CodeFailureList({
  failures,
  label = "Objects that could not be created",
  className,
}: {
  failures: CodeObjectFailure[];
  label?: string;
  className?: string;
}) {
  if (failures.length === 0) return null;
  return (
    <ul
      aria-label={label}
      className={cn("max-h-64 divide-y divide-border overflow-y-auto rounded-md border border-border bg-bg-inset", className)}
    >
      {failures.map((failure, i) => (
        <li key={`${failure.kind}:${failure.name}:${i}`} className="min-w-0 space-y-1 px-3 py-2">
          <div className="flex min-w-0 items-center gap-2">
            <Badge variant="muted" size="sm" className="shrink-0">
              {failure.kind.toLowerCase()}
            </Badge>
            <span className="min-w-0 break-all font-mono text-code text-text">{failure.name}</span>
          </div>
          <p className="whitespace-pre-line break-words text-label text-text-muted">{failure.error}</p>
        </li>
      ))}
    </ul>
  );
}
