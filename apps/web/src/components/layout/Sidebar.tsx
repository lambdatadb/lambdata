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

export function Sidebar() {
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

  return (
    <aside className="w-64 shrink-0 border-r border-border bg-bg flex flex-col z-20">
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
          const visible = g.items.filter((i) => !i.adminOnly || user?.role === "admin");
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
                    className={({ isActive }) =>
                      cn(
                        "relative flex items-center gap-2.5 px-3 py-2 rounded-md text-sm transition-colors",
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
                            layoutId="nav-active"
                            className="absolute left-0 top-1.5 bottom-1.5 w-0.5 rounded-r bg-accent"
                            transition={{ type: "spring", stiffness: 380, damping: 32 }}
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
          dot={health.data ? (health.data.mariadb.ok ? "success" : "warn") : "muted"}
          label="mariadb"
          value={`:${settings.data?.mariadbPort ?? 3307}`}
        />
        <StatusLine
          dot={ts.data?.running ? "success" : ts.data?.installed ? "warn" : "muted"}
          label="tailnet"
          value={ts.data?.tailnetIp ?? (ts.data?.installed ? "down" : "off")}
        />
      </div>
    </aside>
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
