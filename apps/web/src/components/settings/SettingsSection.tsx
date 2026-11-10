import type { ReactNode } from "react";

interface Props {
  id: string;
  title: string;
  description?: ReactNode;
  children: ReactNode;
}

export function SettingsSection({ id, title, description, children }: Props) {
  return (
    <section
      id={id}
      aria-labelledby={`${id}-title`}
      className="grid scroll-mt-6 gap-4 border-t border-border py-8 first:border-t-0 first:pt-0 lg:grid-cols-[15rem_minmax(0,1fr)] lg:gap-10"
    >
      <div className="space-y-1">
        <h2 id={`${id}-title`} className="text-heading font-semibold text-text">
          {title}
        </h2>
        {description && <p className="text-body text-text-muted">{description}</p>}
      </div>
      <div className="min-w-0 space-y-4">{children}</div>
    </section>
  );
}
