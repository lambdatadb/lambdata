import { useState, useEffect, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { useAuth } from "../../lib/auth";
import { api } from "../../lib/api";
import { Badge } from "../ui/Badge";
import { Icon } from "../ui/Icon";
import { formatRelativeTime } from "../../lib/format";
import type { AuditLogEntry, Database } from "@kilndb/shared";

export function Topbar() {
  const { user, logout } = useAuth();
  const nav = useNavigate();
  const [busy, setBusy] = useState(false);
  const [showDropdown, setShowDropdown] = useState(false);
  const [showNotifications, setShowNotifications] = useState(false);
  const [notificationsCleared, setNotificationsCleared] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchFocused, setSearchFocused] = useState(false);
  const searchInputRef = useRef<HTMLInputElement>(null);

  const notifications = useQuery({
    queryKey: ["recent-audit-logs"],
    queryFn: () => api.get<{ logs: AuditLogEntry[] }>("/system/audit-logs?limit=5"),
    refetchInterval: 30_000,
    enabled: !!user,
  });

  const databasesQuery = useQuery({
    queryKey: ["databases"],
    queryFn: () => api.get<{ databases: Database[] }>("/databases"),
    enabled: !!user,
  });

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (
        e.key === "/" &&
        document.activeElement?.tagName !== "INPUT" &&
        document.activeElement?.tagName !== "TEXTAREA"
      ) {
        e.preventDefault();
        searchInputRef.current?.focus();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  if (!user) return null;

  const databasesList = databasesQuery.data?.databases ?? [];
  const filteredDbs = searchQuery.trim() === ""
    ? []
    : databasesList.filter(db =>
        db.displayName.toLowerCase().includes(searchQuery.toLowerCase()) ||
        db.name.toLowerCase().includes(searchQuery.toLowerCase())
      );

  const initial = (user.displayName ?? user.email)[0]?.toUpperCase() ?? "?";

  const rawLogs = notifications.data?.logs ?? [];
  const displayLogs = rawLogs.slice(0, 5);

  return (
    <header className="relative h-14 border-b border-border flex items-center justify-between px-6 gap-4 bg-bg z-10">
      {/* Global Search Bar */}
      <div className="flex-1 max-w-md relative">
        <span className="absolute inset-y-0 left-3 flex items-center text-text-subtle pointer-events-none">
          <Icon name="search" size={15} />
        </span>
        <input
          ref={searchInputRef}
          type="text"
          placeholder="Global search (press / to focus)"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          onFocus={() => setSearchFocused(true)}
          onBlur={() => {
            // Delay hide dropdown to allow click handlers to fire
            setTimeout(() => setSearchFocused(false), 200);
          }}
          className="w-full h-8 pl-9 pr-3 rounded-md bg-bg-panel border border-border text-xs text-text placeholder-text-subtle focus:outline-none focus:border-accent/60 transition-colors"
        />

        {/* Search Results Dropdown */}
        {searchFocused && (searchQuery.trim() !== "" || filteredDbs.length > 0) && (
          <div className="absolute left-0 right-0 mt-2 rounded-lg border border-border bg-bg-overlay shadow-overlay py-2 z-40 max-h-72 overflow-y-auto">
            {filteredDbs.length > 0 ? (
              <div className="space-y-1">
                <div className="px-3 py-1 text-micro font-medium text-text-subtle">Databases</div>
                {filteredDbs.map((db) => (
                  <button
                    key={db.id}
                    onClick={() => {
                      setSearchQuery("");
                      nav(`/databases/${db.id}`);
                    }}
                    className="w-full text-left px-4 py-2 hover:bg-bg-subtle/40 flex items-center justify-between text-xs text-text transition-colors cursor-pointer"
                  >
                    <div className="flex items-center gap-2">
                      <Icon name="database" size={14} className="text-accent" />
                      <span className="font-medium">{db.displayName}</span>
                      <span className="font-mono text-micro text-text-muted">{db.name}</span>
                    </div>
                    <Badge tone={db.status === "active" ? "success" : "warn"}>{db.status}</Badge>
                  </button>
                ))}
              </div>
            ) : (
              <div className="px-4 py-4 text-center text-xs text-text-muted">
                No databases matching "{searchQuery}"
              </div>
            )}
          </div>
        )}
      </div>

      {/* Right Side Actions */}
      <div className="flex items-center gap-4">
        {/* Notification Bell */}
        <div className="relative">
          <button
            onClick={() => {
              setShowNotifications(!showNotifications);
              setShowDropdown(false);
              setNotificationsCleared(true);
            }}
            className="relative p-1.5 text-text-muted hover:text-text hover:bg-bg-subtle/40 rounded-full transition-all cursor-pointer"
          >
            <Icon name="notifications" size={18} />
            {displayLogs.length > 0 && !notificationsCleared && (
              <span className="absolute top-0 right-0 size-4 rounded-full bg-danger border border-bg flex items-center justify-center text-[8px] font-bold text-white">
                {displayLogs.length}
              </span>
            )}
          </button>

          {showNotifications && (
            <div className="absolute right-0 mt-2 w-80 rounded-lg border border-border bg-bg-overlay shadow-overlay py-2 z-30">
              <div className="px-4 py-2 border-b border-border flex items-center justify-between">
                <span className="text-label font-medium">Notifications</span>
                <button
                  onClick={() => {
                    setShowNotifications(false);
                    nav("/activity");
                  }}
                  className="text-micro font-medium text-accent hover:underline"
                >
                  View all
                </button>
              </div>
              <div className="max-h-64 overflow-y-auto divide-y divide-border">
                {displayLogs.length === 0 && (
                  <div className="px-4 py-4 text-center text-xs text-text-muted">
                    No recent activity
                  </div>
                )}
                {displayLogs.map((log) => (
                  <div key={log.id} className="p-3 hover:bg-bg-subtle/30 transition-colors">
                    <div className="flex items-start gap-2.5">
                      <span className="mt-1.5 size-1.5 rounded-full bg-accent shrink-0" />
                      <div className="flex-1 min-w-0">
                        <p className="text-micro text-text leading-normal break-words">
                          <strong className="font-semibold">{log.user_display_name}</strong> performed{" "}
                          <code className="text-accent font-mono px-1 py-0.5 rounded bg-accent/10 text-[10px]">
                            {log.action}
                          </code>{" "}
                          on <strong className="text-text-muted">{log.target}</strong>
                        </p>
                        <p className="text-micro text-text-subtle font-mono mt-1">
                          {formatRelativeTime(log.at)}
                        </p>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* User Capsule */}
        <div className="relative">
          <button
            onClick={() => {
              setShowDropdown(!showDropdown);
              setShowNotifications(false);
            }}
            className="flex items-center gap-2.5 pl-2.5 pr-2 py-1 rounded-md border border-border bg-bg-panel hover:bg-bg-subtle hover:border-border-strong transition-colors cursor-pointer"
          >
            <div className="size-6 rounded-full bg-accent/20 border border-accent/40 flex items-center justify-center text-accent text-micro font-semibold">
              {initial}
            </div>
            <div className="leading-tight text-left">
              <div className="text-label font-semibold text-text leading-none">{user.displayName ?? "User"}</div>
              <div className="text-micro font-mono text-text-subtle mt-0.5">{user.email}</div>
            </div>
            <Icon name="expand_more" size={14} className="text-text-subtle" />
          </button>

          {showDropdown && (
            <div className="absolute right-0 mt-2 w-48 rounded-lg border border-border bg-bg-overlay shadow-overlay py-1 z-30">
              <div className="px-4 py-2 border-b border-border text-xs text-text-muted">
                Signed in as <strong className="text-text">{user.displayName ?? user.email}</strong>
              </div>
              <button
                onClick={async () => {
                  setBusy(true);
                  await logout();
                  nav("/login");
                }}
                disabled={busy}
                className="w-full text-left px-4 py-2 text-xs text-danger hover:bg-bg-subtle/50 transition-colors flex items-center gap-2"
              >
                <Icon name="logout" size={14} />
                {busy ? "Signing out..." : "Sign out"}
              </button>
            </div>
          )}
        </div>
      </div>
    </header>
  );
}
