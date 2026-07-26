import { useEffect, useState, type ReactNode } from "react";
import { useLocation } from "react-router-dom";
import { Sidebar } from "./Sidebar";
import { Topbar } from "./Topbar";
import { Icon } from "../ui/Icon";

interface Props {
  children: ReactNode;
}

export function PageShell({ children }: Props) {
  const location = useLocation();
  const [mobileNavigationOpen, setMobileNavigationOpen] = useState(false);

  useEffect(() => {
    setMobileNavigationOpen(false);
  }, [location.pathname]);

  useEffect(() => {
    if (!mobileNavigationOpen) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMobileNavigationOpen(false);
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [mobileNavigationOpen]);

  return (
    <div className="relative flex h-screen overflow-hidden bg-bg">
      <button
        type="button"
        aria-label="Open navigation"
        aria-expanded={mobileNavigationOpen}
        onClick={() => setMobileNavigationOpen(true)}
        className="absolute left-1.5 top-1.5 z-30 grid size-11 place-items-center rounded-md text-text-muted transition-colors hover:bg-bg-subtle hover:text-text focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent lg:hidden"
      >
        <Icon name="view_list" size={20} />
      </button>
      <Sidebar
        mobileOpen={mobileNavigationOpen}
        onMobileClose={() => setMobileNavigationOpen(false)}
      />
      <div className="flex min-w-0 flex-1 flex-col">
        <Topbar />
        <main className="flex-1 overflow-y-auto overflow-x-clip bg-bg">
          <div className="mx-auto max-w-7xl px-4 py-5 sm:px-6 lg:px-8 lg:py-7">{children}</div>
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
    <div className="mb-5 flex flex-col items-start gap-3 sm:flex-row sm:items-end sm:justify-between lg:mb-7">
      <div className="min-w-0 space-y-1.5">
        <h1 className="min-w-0 [overflow-wrap:anywhere] text-display font-semibold leading-none">{title}</h1>
        {subtitle && <p className="text-body text-text-muted">{subtitle}</p>}
      </div>
      {actions && <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto">{actions}</div>}
    </div>
  );
}
