import { useEffect, useState } from "react";
import { ImageOff } from "lucide-react";
import type { NotificationKind } from "@lambdata/shared";
import { Badge, Button, Field, Input } from "../ui";
import { DEFAULT_ICON_SRC, iconUrlError, type DestinationDraft } from "./model";

function Thumb({ src }: { src: string }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [src]);
  if (failed) {
    return (
      <span className="grid size-10 shrink-0 place-items-center rounded-full border border-border bg-bg-raised text-text-subtle">
        <ImageOff aria-hidden className="size-4" />
        <span className="sr-only">The image could not be loaded</span>
      </span>
    );
  }
  return <img src={src} alt="" onError={() => setFailed(true)} className="size-10 shrink-0 rounded-full border border-border bg-bg-raised object-cover" />;
}

interface Props {
  kind: NotificationKind;
  draft: DestinationDraft;
  patch: (next: Partial<DestinationDraft>) => void;
  defaultIconUrl: string;
  error?: string;
}

export function IconField({ kind, draft, patch, defaultIconUrl, error }: Props) {
  const custom = draft.iconMode === "custom";
  const src = custom && !iconUrlError(draft.iconUrl) ? draft.iconUrl.trim() : DEFAULT_ICON_SRC;
  const where =
    kind === "webhook"
      ? "Sent as iconUrl in the payload, for your endpoint to use or ignore."
      : kind === "ntfy"
        ? "Shown on the notification, on phones that support it."
        : "Shown next to every message, with the sender name LambData.";
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3 rounded-md border border-border bg-bg-inset px-3 py-2.5">
        <Thumb src={src} />
        <div className="min-w-0 flex-[1_1_12rem]">
          <p className="flex flex-wrap items-center gap-1.5 text-body font-medium text-text">
            {custom ? "Your own icon" : "LambData icon"}
            {!custom && (
              <Badge variant="muted" size="sm" title={defaultIconUrl}>
                default
              </Badge>
            )}
          </p>
          <p className="text-label text-text-muted">{where}</p>
        </div>
        <Button
          variant="ghost"
          size="xs"
          onClick={() => patch(custom ? { iconMode: "default" } : { iconMode: "custom" })}
          aria-expanded={custom}
        >
          {custom ? "Use the LambData icon" : "Use your own"}
        </Button>
      </div>
      {custom && (
        <Field label="Image address" error={error} hint="An https:// link to a square PNG or JPEG. Chat apps download it themselves.">
          <Input
            mono
            value={draft.iconUrl}
            onChange={(e) => patch({ iconUrl: e.target.value })}
            placeholder="https://example.com/icon.png"
            autoComplete="off"
            spellCheck={false}
            inputMode="url"
          />
        </Field>
      )}
    </div>
  );
}
