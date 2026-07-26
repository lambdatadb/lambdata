import { NavLink } from "react-router-dom";
import { motion } from "framer-motion";
import { useQuery } from "@tanstack/react-query";
import type { AppSettings, HealthDetail, TailscaleStatus } from "@kilndb/shared";
import { api } from "../../lib/api";
import { useAuth } from "../../lib/auth";
import { Icon } from "../ui/Icon";
import { cn } from "../ui/cn";

interface Item {
  to: string;
  label: string;
  icon: string;
  adminOnly?: boolean;
}

interface Group {
  title?: string;
  items: Item[];
}

const groups: Group[] = [
  {
    items: [
      { to: "/", label: "Dashboard", icon: "dashboard" },
      { to: "/databases", label: "Databases", icon: "database" },
    ],
  },
  {
    title: "Platform",
    items: [
      { to: "/auth", label: "Auth", icon: "admin_panel_settings" },
      { to: "/data-api", label: "Data API", icon: "api" },
      { to: "/storage", label: "Storage", icon: "folder" },
      { to: "/realtime", label: "Realtime", icon: "sensors" },
      { to: "/functions", label: "Functions", icon: "functions" },
    ],
  },
  {
    title: "Operate",
    items: [
      { to: "/activity", label: "Activity", icon: "history" },
      { to: "/users", label: "Users", icon: "group", adminOnly: true },
      { to: "/tailscale", label: "Tailscale", icon: "network" },
      { to: "/settings", label: "Settings", icon: "settings" },
    ],
  },
];

export function Sidebar({
  mobileOpen,
  onMobileClose,
}: {
  mobileOpen: boolean;
  onMobileClose: () => void;
}) {
  const { user } = useAuth();
  const settings = useQuery({
    queryKey: ["settings"],
    queryFn: () => api.get<AppSettings>("/settings"),
  });
  const ts = useQuery({
    queryKey: ["tailscale", "status"],
    queryFn: () => api.get<TailscaleStatus>("/tailscale/status"),
    refetchInterval: 30_000,
  });
  const health = useQuery({
    queryKey: ["health", "detail"],
    queryFn: () => api.get<HealthDetail>("/health/detail"),
    refetchInterval: 30_000,
  });

  const bodyProps: Omit<SidebarBodyProps, "activeLayoutId" | "onNavigate"> = {
    role: user?.role,
    mariadbPort: settings.data?.mariadbPort ?? 3307,
    mariadbOk: health.data?.mariadb.ok,
    tailnetRunning: ts.data?.running,
    tailnetInstalled: ts.data?.installed,
    tailnetIp: ts.data?.tailnetIp,
  };

  return (
    <>
      <aside className="z-20 hidden w-64 shrink-0 flex-col border-r border-border bg-bg lg:flex">
        <SidebarBody {...bodyProps} activeLayoutId="nav-active-desktop" />
      </aside>
      <motion.button
        type="button"
        aria-label="Close navigation"
        aria-hidden={!mobileOpen}
        tabIndex={mobileOpen ? 0 : -1}
        className={cn(
          "fixed inset-0 z-40 bg-bg/80 lg:hidden",
          mobileOpen ? "pointer-events-auto" : "pointer-events-none",
        )}
        initial={false}
        animate={{ opacity: mobileOpen ? 1 : 0 }}
        transition={{ duration: 0.18, ease: [0.16, 1, 0.3, 1] }}
        onClick={onMobileClose}
      />
      <motion.aside
        aria-label="Primary navigation"
        aria-hidden={!mobileOpen}
        className="fixed inset-y-0 left-0 z-50 flex w-[min(17rem,86vw)] flex-col border-r border-border bg-bg shadow-overlay lg:hidden"
        initial={false}
        animate={{ x: mobileOpen ? 0 : "-100%" }}
        transition={{ duration: 0.26, ease: [0.16, 1, 0.3, 1] }}
      >
        <SidebarBody
          {...bodyProps}
          activeLayoutId="nav-active-mobile"
          navigationEnabled={mobileOpen}
          onNavigate={onMobileClose}
        />
      </motion.aside>
    </>
  );
}

interface SidebarBodyProps {
  role?: string;
  mariadbPort: number;
  mariadbOk?: boolean;
  tailnetRunning?: boolean;
  tailnetInstalled?: boolean;
  tailnetIp?: string | null;
  activeLayoutId: string;
  navigationEnabled?: boolean;
  onNavigate?: () => void;
}

function SidebarBody({
  role,
  mariadbPort,
  mariadbOk,
  tailnetRunning,
  tailnetInstalled,
  tailnetIp,
  activeLayoutId,
  navigationEnabled = true,
  onNavigate,
}: SidebarBodyProps) {
  return (
    <>
      <div className="h-14 flex items-center px-4 border-b border-border">
        <div className="flex items-center gap-2.5">
          <div className="relative size-7 rounded-md border border-border bg-bg-panel flex items-center justify-center">
            <img src="/kilndb-mark.png" alt="" className="size-6" />
          </div>
          <div className="brand-wordmark text-sm text-text">KilnDB</div>
        </div>
      </div>

      <nav className="flex-1 overflow-y-auto p-2">
        {groups.map((g, gi) => {
          const visible = g.items.filter((i) => !i.adminOnly || role === "admin");
          if (visible.length === 0) return null;
          return (
            <div key={gi} className={cn(gi > 0 && "mt-4")}>
              {g.title && (
                <div className="px-3 pb-1 text-micro font-medium text-text-subtle">{g.title}</div>
              )}
              <div className="space-y-0.5">
                {visible.map((i) => (
                  <NavLink
                    key={i.to}
                    to={i.to}
                    end={i.to === "/"}
                    tabIndex={navigationEnabled ? undefined : -1}
                    onClick={onNavigate}
                    className={({ isActive }) =>
                      cn(
                        "relative flex min-h-11 items-center gap-2.5 rounded-md px-3 py-2 text-sm transition-colors",
                        isActive
                          ? "text-text bg-bg-subtle"
                          : "text-text-muted hover:text-text hover:bg-bg-subtle/60",
                      )
                    }
                  >
                    {({ isActive }) => (
                      <>
                        {isActive && (
                          <motion.span
                            layoutId={activeLayoutId}
                            className="absolute left-0 top-1.5 bottom-1.5 w-0.5 rounded-r bg-accent"
                            transition={{ duration: 0.22, ease: [0.16, 1, 0.3, 1] }}
                          />
                        )}
                        <Icon
                          name={i.icon}
                          size={18}
                          className={isActive ? "text-accent" : "text-text-muted"}
                        />
                        <span>{i.label}</span>
                      </>
                    )}
                  </NavLink>
                ))}
              </div>
            </div>
          );
        })}
      </nav>

      <div className="p-3 border-t border-border space-y-1.5">
        <StatusLine
          dot={mariadbOk === undefined ? "muted" : mariadbOk ? "success" : "warn"}
          label="mariadb"
          value={`:${mariadbPort}`}
        />
        <StatusLine
          dot={tailnetRunning ? "success" : tailnetInstalled ? "warn" : "muted"}
          label="tailnet"
          value={tailnetIp ?? (tailnetInstalled ? "down" : "off")}
        />
      </div>
    </>
  );
}

function StatusLine({
  dot,
  label,
  value,
}: {
  dot: "success" | "warn" | "muted";
  label: string;
  value: string;
}) {
  const dotCls = dot === "success" ? "bg-success" : dot === "warn" ? "bg-warn" : "bg-text-subtle";
  return (
    <div className="flex items-center gap-2 font-mono text-micro text-text-muted">
      <span className={`size-1.5 rounded-full ${dotCls}`} />
      <span className="text-text-subtle">{label}</span>
      <span className="flex-1 border-b border-dashed border-border" />
      <span className="text-text-muted">{value}</span>
    </div>
  );
}
