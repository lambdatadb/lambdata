import { useQuery } from "@tanstack/react-query";
import type { EdgeFunction } from "@lambdata/shared";
import { Lock, RotateCcw } from "lucide-react";
import { Alert, Badge, Button, Kbd, Skeleton, Textarea } from "../ui";
import { api, errorMessage } from "../../lib/api";
import { formatBytes, formatRelativeTime } from "../../lib/format";
import { functionSourceKey } from "./keys";

interface Props {
  fn: EdgeFunction;
  isAdmin: boolean;
  draft: string | undefined;
  saving: boolean;
  onDraftChange: (value: string | undefined) => void;
  onSave: (source: string) => void;
}

export function useFunctionSource(name: string) {
  return useQuery({
    queryKey: functionSourceKey(name),
    queryFn: () => api.get<{ source: string }>(`/functions/${encodeURIComponent(name)}/source`),
  });
}

export function SourceEditor({ fn, isAdmin, draft, saving, onDraftChange, onSave }: Props) {
  const sourceQuery = useFunctionSource(fn.name);
  const saved = sourceQuery.data?.source;
  const value = draft ?? saved ?? "";
  const dirty = draft !== undefined && saved !== undefined && draft !== saved;
  const modifier = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform) ? "⌘" : "Ctrl";

  if (sourceQuery.isError) {
    return (
      <Alert
        variant="danger"
        title={`Could not load the source of ${fn.name}`}
        action={
          <Button size="xs" variant="secondary" onClick={() => sourceQuery.refetch()}>
            <RotateCcw aria-hidden /> Retry
          </Button>
        }
      >
        {errorMessage(sourceQuery.error, "The server did not answer.")} Editing stays off until the saved source loads.
      </Alert>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0 truncate text-label text-text-muted">
          <span className="font-mono text-text" title={fn.entrypoint}>
            {fn.entrypoint.split("/").pop() || fn.entrypoint}
          </span>
          <span className="px-1.5 text-text-subtle">·</span>
          {formatBytes(Number(fn.sourceSizeBytes))}
          <span className="px-1.5 text-text-subtle">·</span>
          saved {formatRelativeTime(fn.sourceUpdatedAt)}
        </div>
        {isAdmin ? (
          <div className="flex items-center gap-2">
            {dirty && (
              <Badge variant="warn" dot>
                Unsaved
              </Badge>
            )}
            <Button variant="ghost" size="sm" disabled={!dirty || saving} onClick={() => onDraftChange(undefined)}>
              Discard
            </Button>
            <Button
              size="sm"
              variant={dirty ? "primary" : "secondary"}
              disabled={!dirty}
              loading={saving}
              onClick={() => onSave(value)}
            >
              Save
            </Button>
          </div>
        ) : (
          <Badge variant="muted">
            <Lock aria-hidden /> Read only
          </Badge>
        )}
      </div>
      {sourceQuery.isPending ? (
        <Skeleton className="h-72 w-full sm:h-[26rem]" />
      ) : (
        <Textarea
          aria-label={`Source of ${fn.name}`}
          value={value}
          readOnly={!isAdmin}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          wrap="off"
          rows={22}
          className="min-h-72 whitespace-pre leading-5 sm:min-h-[26rem]"
          onChange={(e) => onDraftChange(e.target.value === saved ? undefined : e.target.value)}
          onKeyDown={(e) => {
            if (isAdmin && dirty && !saving && (e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
              e.preventDefault();
              onSave(value);
            }
          }}
        />
      )}
      <p className="text-micro text-text-subtle">
        {isAdmin ? (
          <>
            Press <Kbd>{modifier}</Kbd> <Kbd>S</Kbd> to save. The next invocation runs the new source.
          </>
        ) : (
          "Only admins can change function source."
        )}
      </p>
    </div>
  );
}
