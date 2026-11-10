import type { ReactNode } from "react";
import { ExternalLink } from "lucide-react";
import type { NotificationKind } from "@lambdata/shared";
import { cn } from "../ui";
import { DEFAULT_ICON_SRC, DOCS_URL, KINDS } from "./model";

export function KindTile({ kind, tone = "default", className }: { kind: NotificationKind; tone?: "default" | "warn" | "muted"; className?: string }) {
  const Icon = KINDS[kind].icon;
  return (
    <span
      aria-hidden
      className={cn(
        "grid size-9 shrink-0 place-items-center rounded-md border bg-bg-raised",
        tone === "warn" ? "border-warn/45 text-warn" : tone === "muted" ? "border-border text-text-subtle" : "border-border-strong text-text-muted",
        className,
      )}
    >
      <Icon className="size-4" />
    </span>
  );
}

export function DocsLink({ children = "Payload reference" }: { children?: ReactNode }) {
  return (
    <a
      href={DOCS_URL}
      target="_blank"
      rel="noreferrer"
      className="inline-flex items-center gap-1 text-text underline decoration-border-control underline-offset-4 hover:decoration-accent"
    >
      {children}
      <ExternalLink aria-hidden className="size-3.5" />
    </a>
  );
}

interface PreviewProps {
  tone: "accent" | "warn";
  title: string;
  body: string;
  fields: [string, string][];
  time: string;
}

function PreviewMessage({ tone, title, body, fields, time }: PreviewProps) {
  return (
    <div className="flex gap-3">
      <img src={DEFAULT_ICON_SRC} alt="" className="size-9 shrink-0 rounded-full border border-border bg-bg-raised" />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-x-2">
          <span className="text-body font-semibold text-text">LambData</span>
          <span className="text-micro text-text-subtle">today at {time}</span>
        </div>
        <div className={cn("mt-1.5 rounded-md border-l-[3px] bg-bg-panel px-3 py-2.5", tone === "warn" ? "border-l-warn" : "border-l-accent")}>
          <p className="text-body font-semibold text-text [overflow-wrap:anywhere]">{title}</p>
          <p className="mt-0.5 text-label text-text-muted">{body}</p>
          <dl className="mt-2 flex flex-wrap gap-x-5 gap-y-1 text-micro">
            {fields.map(([term, value]) => (
              <div key={term}>
                <dt className="font-medium text-text-subtle">{term}</dt>
                <dd className="text-text">{value}</dd>
              </div>
            ))}
          </dl>
        </div>
      </div>
    </div>
  );
}

export function MessagePreview({ className }: { className?: string }) {
  return (
    <figure className={cn("rounded-lg border border-border bg-bg-inset p-4", className)} aria-label="Two example messages">
      <figcaption className="mb-3 text-micro font-medium text-text-subtle">Example messages</figcaption>
      <div className="space-y-4">
        <PreviewMessage
          tone="accent"
          title="Checkpoint made: Before the wipe (a41f9c2)"
          body="Avery Chen made a checkpoint of Storefront."
          fields={[
            ["Database", "Storefront"],
            ["By", "Avery Chen"],
          ]}
          time="14:02"
        />
        <PreviewMessage
          tone="warn"
          title="Rollback refused: Ledger"
          body="Nothing was changed. 2 views cannot be re-created here."
          fields={[
            ["Database", "Ledger"],
            ["By", "Priya Nair"],
          ]}
          time="14:09"
        />
      </div>
    </figure>
  );
}
