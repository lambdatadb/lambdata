import type { ReactNode } from "react";
import { Sidebar } from "./Sidebar";
import { Topbar } from "./Topbar";

interface Props {
  children: ReactNode;
}

export function PageShell({ children }: Props) {
  return (
    <div className="h-screen flex bg-bg">
      <Sidebar />
      <div className="flex-1 flex flex-col min-w-0">
        <Topbar />
        <main className="flex-1 overflow-y-auto bg-bg">
          <div className="max-w-7xl mx-auto px-8 py-7">{children}</div>
        </main>
      </div>
    </div>
  );
}

interface HeaderProps {
  title: string;
  subtitle?: ReactNode;
  actions?: ReactNode;
}

export function PageHeader({ title, subtitle, actions }: HeaderProps) {
  return (
    <div className="mb-7 flex items-end justify-between gap-4">
      <div className="space-y-1.5">
        <h1 className="text-display font-semibold leading-none">{title}</h1>
        {subtitle && <p className="text-body text-text-muted">{subtitle}</p>}
      </div>
      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </div>
  );
}
