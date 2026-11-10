import { Fragment, type ReactNode } from "react";
import { t, type TerminologyKey } from "@lambdata/shared";
import { useAuth } from "./auth";

export function useTerminology(): (key: TerminologyKey) => string {
  const { user } = useAuth();
  const level = user?.experienceLevel ?? "advanced";
  return (key) => t(level, key);
}

export function renderInlineCode(text: string): ReactNode {
  const parts = text.split("`");
  if (parts.length < 3) return text;
  return parts.map((part, i) =>
    i % 2 === 1 ? (
      <code key={i} className="rounded-[4px] bg-bg-raised px-1 py-px font-mono text-code text-text">
        {part}
      </code>
    ) : (
      <Fragment key={i}>{part}</Fragment>
    ),
  );
}

export function useTermNode(): (key: TerminologyKey) => ReactNode {
  const term = useTerminology();
  return (key) => renderInlineCode(term(key));
}
