import { Plus, ShieldCheck } from "lucide-react";
import type { NotificationKind } from "@lambdata/shared";
import { Card, cn } from "../ui";
import { focusRing } from "../ui/styles";
import { KIND_ORDER, KINDS } from "./model";
import { KindTile, MessagePreview } from "./parts";

export function KindCard({ kind, onPick }: { kind: NotificationKind; onPick: (kind: NotificationKind) => void }) {
  const meta = KINDS[kind];
  return (
    <button
      type="button"
      onClick={() => onPick(kind)}
      className={cn(
        "group flex w-full items-start gap-3 rounded-lg border border-border bg-bg-panel p-3.5 text-left transition-colors",
        "hover:border-accent/50 hover:bg-bg-raised",
        focusRing,
      )}
    >
      <KindTile kind={kind} className="transition-colors group-hover:border-accent/40 group-hover:text-accent" />
      <span className="min-w-0 flex-1">
        <span className="flex items-center justify-between gap-2 text-body font-medium text-text">
          {meta.label}
          <Plus aria-hidden className="size-4 shrink-0 text-text-subtle transition-colors group-hover:text-accent" />
        </span>
        <span className="mt-0.5 block text-label text-text-muted">{meta.description}</span>
      </span>
    </button>
  );
}

export function GetStarted({ onPick }: { onPick: (kind: NotificationKind) => void }) {
  return (
    <Card className="p-4 sm:p-6" data-notifications="empty">
      <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <div className="min-w-0 space-y-6">
          <div className="space-y-2">
            <h2 className="text-title font-semibold text-text">Get a message when something happens</h2>
            <p className="max-w-2xl text-body text-text-muted">
              LambData can post to Discord, Slack, your phone or your own endpoint when a database is created, a checkpoint is made, a
              mirror stops syncing or the disk runs low.
            </p>
            <p className="max-w-2xl text-body text-text">
              Nothing is sent until you add a destination, and each destination gets only the events you pick.
            </p>
          </div>

          <div className="space-y-3">
            <h3 className="text-label font-medium text-text-muted">Add your first destination</h3>
            <div className="grid gap-2.5 sm:grid-cols-2">
              {KIND_ORDER.map((kind) => (
                <KindCard key={kind} kind={kind} onPick={onPick} />
              ))}
            </div>
          </div>

          <p className="flex items-start gap-2 text-label text-text-muted">
            <ShieldCheck aria-hidden className="mt-px size-4 shrink-0 text-text-subtle" />
            <span>
              Messages carry names, short hashes, counts and who did it. Never row data, passwords, connection strings or email addresses.
            </span>
          </p>
        </div>
        <MessagePreview className="self-start" />
      </div>
    </Card>
  );
}
