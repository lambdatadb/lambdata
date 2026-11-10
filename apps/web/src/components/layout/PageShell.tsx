import { useEffect, useRef, useState, type ReactNode } from "react";
import { Link, useLocation } from "react-router-dom";
import { HardDrive } from "lucide-react";
import { useIsAdmin } from "../../lib/auth";
import { formatBytes } from "../../lib/format";
import { useAppSettings } from "../../lib/queries";
import { Alert } from "../ui/Alert";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "../ui/Sheet";
import { cn } from "../ui/cn";
import { SidebarBody } from "./Sidebar";
import { Topbar } from "./Topbar";

interface Props {
  children: ReactNode;
}

export function PageShell({ children }: Props) {
  const { pathname, hash } = useLocation();
  const [navOpen, setNavOpen] = useState(false);
  const mainRef = useRef<HTMLElement>(null);

  useEffect(() => {
    setNavOpen(false);
    if (!hash) {
      mainRef.current?.scrollTo({ top: 0 });
      return;
    }
    let tries = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const reveal = () => {
      const target = document.getElementById(decodeURIComponent(hash.slice(1)));
      if (target) target.scrollIntoView({ block: "start" });
      else if (tries++ < 20) timer = setTimeout(reveal, 150);
    };
    reveal();
    return () => clearTimeout(timer);
  }, [pathname, hash]);

  return (
    <div className="flex h-dvh overflow-hidden bg-bg">
      <a
        href="#main-content"
        className="sr-only z-[70] rounded-md bg-bg-overlay px-3 py-2 text-body text-text focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:ring-2 focus:ring-ring/70"
      >
        Skip to content
      </a>
      <aside className="hidden w-60 shrink-0 border-r border-border bg-bg lg:block">
        <SidebarBody />
      </aside>
      <Sheet open={navOpen} onOpenChange={setNavOpen}>
        <SheetContent side="left" className="w-[min(17rem,86vw)] bg-bg lg:hidden">
          <SheetTitle className="sr-only">Navigation</SheetTitle>
          <SheetDescription className="sr-only">Pages and system status</SheetDescription>
          <SidebarBody onNavigate={() => setNavOpen(false)} />
        </SheetContent>
      </Sheet>
      <div className="flex min-w-0 flex-1 flex-col">
        <Topbar onOpenNavigation={() => setNavOpen(true)} />
        <main ref={mainRef} id="main-content" tabIndex={-1} className="min-h-0 flex-1 overflow-y-auto outline-none">
          <div className="mx-auto w-full max-w-[84rem] px-4 pb-16 pt-6 sm:px-6 lg:px-8 lg:pt-8">
            <DiskNotice />
            {children}
          </div>
        </main>
      </div>
    </div>
  );
}

function DiskNotice() {
  const isAdmin = useIsAdmin();
  const settings = useAppSettings({ enabled: isAdmin, poll: 5 * 60_000 });
  const limits = settings.data?.limits;
  if (!isAdmin || !limits?.diskLow) return null;
  const free = settings.data?.dataDirFreeBytes;
  return (
    <Alert
      variant="warning"
      icon={<HardDrive aria-hidden />}
      title="The data directory is running out of space"
      className="mb-6"
      action={
        <Link to="/settings#storage" className="text-label text-text underline underline-offset-4">
          Storage settings
        </Link>
      }
    >
      {free != null ? `${formatBytes(free)} free. ` : ""}Below {formatBytes(limits.diskFloorBytes)} LambData stops taking checkpoints,
      imports and uploads. Free up space or move the data directory.
    </Alert>
  );
}

interface HeaderProps {
  title: string;
  subtitle?: ReactNode;
  actions?: ReactNode;
  breadcrumb?: ReactNode;
  badges?: ReactNode;
  icon?: ReactNode;
  documentTitle?: string;
  className?: string;
}

export function useDocumentTitle(title: string | null | undefined): void {
  useEffect(() => {
    if (!title) return;
    const previous = document.title;
    document.title = `${title} · LambData`;
    return () => {
      document.title = previous;
    };
  }, [title]);
}

export function PageHeader({ title, subtitle, actions, breadcrumb, badges, icon, documentTitle, className }: HeaderProps) {
  useDocumentTitle(documentTitle ?? title);
  return (
    <header className={cn("mb-6 lg:mb-8", className)}>
      {breadcrumb && <div className="mb-3">{breadcrumb}</div>}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex min-w-0 items-start gap-3">
          {icon && (
            <div className="mt-0.5 grid size-10 shrink-0 place-items-center rounded-lg border border-border-strong bg-bg-raised text-text-muted [&_svg]:size-5">
              {icon}
            </div>
          )}
          <div className="min-w-0 space-y-1">
            <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1.5">
              <h1 className="min-w-0 text-display font-semibold text-text [overflow-wrap:anywhere]">{title}</h1>
              {badges && <div className="flex flex-wrap items-center gap-1.5">{badges}</div>}
            </div>
            {subtitle && <div className="text-body text-text-muted">{subtitle}</div>}
          </div>
        </div>
        {actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
      </div>
    </header>
  );
}

export function PageSection({
  title,
  description,
  actions,
  children,
  className,
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={cn("space-y-3", className)}>
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-heading font-semibold text-text">{title}</h2>
          {description && <p className="text-body text-text-muted">{description}</p>}
        </div>
        {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
      </div>
      {children}
    </section>
  );
}
