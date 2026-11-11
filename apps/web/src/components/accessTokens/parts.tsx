import { Check, X } from "lucide-react";
import type { AccessToken, AccessTokenPresetInfo, AccessTokenVia } from "@lambdata/shared";
import { Badge } from "../ui/Badge";
import { cn } from "../ui/cn";
import { tokenStatus } from "../../lib/accessTokens";

export function TokenStatusBadge({ token, allPaused = false }: { token: Pick<AccessToken, "status">; allPaused?: boolean }) {
  const view = tokenStatus(token, allPaused);
  return (
    <Badge variant={view.variant} dot={view.dot} size="sm" data-token-status={token.status}>
      {view.label}
    </Badge>
  );
}

export function ViaBadge({ via }: { via: AccessTokenVia | null }) {
  if (!via) return null;
  return (
    <Badge variant="muted" size="sm" mono>
      {via === "mcp" ? "MCP" : "API"}
    </Badge>
  );
}

export function PresetLists({ info, compact = false, className }: { info: AccessTokenPresetInfo; compact?: boolean; className?: string }) {
  const item = compact ? "text-label" : "text-body";
  return (
    <span className={cn("grid gap-3 sm:grid-cols-2", className)} data-preset-lists={info.preset}>
      <span className="block space-y-1">
        <span className="block text-micro font-medium uppercase tracking-wide text-text-subtle">Can</span>
        {info.can.map((line, i) => (
          <span key={i} className={cn("flex items-start gap-1.5 text-text", item)}>
            <Check aria-hidden className="mt-0.5 size-3.5 shrink-0 text-success" />
            <span>{line}</span>
          </span>
        ))}
      </span>
      <span className="block space-y-1">
        <span className="block text-micro font-medium uppercase tracking-wide text-text-subtle">Cannot</span>
        {info.cannot.map((line, i) => (
          <span key={i} className={cn("flex items-start gap-1.5 text-text-muted", item)}>
            <X aria-hidden className="mt-0.5 size-3.5 shrink-0 text-text-subtle" />
            <span>{line}</span>
          </span>
        ))}
      </span>
    </span>
  );
}
