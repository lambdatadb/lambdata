import type { ReactNode } from "react";
import { Alert, Button, cn } from "../ui";
import { errorMessage } from "../../lib/api";
import { isLockout } from "./model";

interface SectionProps {
  id: string;
  step: number;
  title: string;
  description?: ReactNode;
  children: ReactNode;
}

export function NetworkSection({ id, step, title, description, children }: SectionProps) {
  return (
    <section
      id={id}
      aria-labelledby={`${id}-title`}
      className="grid scroll-mt-6 gap-4 border-t border-border py-8 first:border-t-0 first:pt-0 lg:grid-cols-[15rem_minmax(0,1fr)] lg:gap-10"
    >
      <div className="flex items-start gap-3 lg:block lg:space-y-3">
        <span
          aria-hidden
          className="grid size-6 shrink-0 place-items-center rounded-full border border-border-strong bg-bg-raised font-mono text-micro text-text-muted"
        >
          {step}
        </span>
        <div className="min-w-0 space-y-1">
          <h2 id={`${id}-title`} className="text-heading font-semibold text-text">
            <span className="sr-only">Step {step}: </span>
            {title}
          </h2>
          {description && <p className="text-body text-text-muted">{description}</p>}
        </div>
      </div>
      <div className="min-w-0 space-y-4">{children}</div>
    </section>
  );
}

export function Refusal({ error, onDismiss, className }: { error: unknown; onDismiss?: () => void; className?: string }) {
  if (!error) return null;
  const lockout = isLockout(error);
  return (
    <Alert
      variant="danger"
      title={lockout ? "Not saved: this would lock you out" : "Not saved"}
      className={className}
      action={
        onDismiss ? (
          <Button size="xs" variant="ghost" onClick={onDismiss}>
            Dismiss
          </Button>
        ) : undefined
      }
    >
      {errorMessage(error)}
    </Alert>
  );
}

export function Steps({ items, className }: { items: ReactNode[]; className?: string }) {
  return (
    <ol className={cn("space-y-2.5", className)}>
      {items.map((item, i) => (
        <li key={i} className="flex gap-3 text-body text-text-muted">
          <span
            aria-hidden
            className="mt-px grid size-5 shrink-0 place-items-center rounded-full bg-bg-inset font-mono text-micro text-text-muted"
          >
            {i + 1}
          </span>
          <span className="min-w-0 [&_code]:rounded [&_code]:bg-bg-inset [&_code]:px-1 [&_code]:font-mono [&_code]:text-code [&_code]:text-text [&_strong]:font-medium [&_strong]:text-text">
            {item}
          </span>
        </li>
      ))}
    </ol>
  );
}

export function Code({ children }: { children: ReactNode }) {
  return <code className="rounded bg-bg-inset px-1 font-mono text-code text-text">{children}</code>;
}
