import { useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { Bell, ChevronDown, Command as CommandIcon, LogOut, Menu, Palette, Search, Settings } from "lucide-react";
import type { AuditLogEntry, ColorTheme } from "@lambdata/shared";
import { roleLabel, useAuth } from "../../lib/auth";
import { useAuditLogs, useAuditTargets } from "../../lib/queries";
import { updateColorTheme } from "../../lib/preferences";
import { COLOR_THEMES } from "../../lib/theme";
import { errorMessage } from "../../lib/api";
import { formatRelativeTime } from "../../lib/format";
import { Avatar } from "../ui/Avatar";
import { Badge } from "../ui/Badge";
import { Button } from "../ui/Button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "../ui/DropdownMenu";
import { Kbd, KbdGroup } from "../ui/Kbd";
import { Logo } from "../ui/Brand";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/Popover";
import { SimpleTooltip } from "../ui/Tooltip";
import { toast } from "../ui/Toast";
import { useCommandPalette } from "../command/CommandPalette";
import { JobsIndicator } from "../jobs/JobsIndicator";

const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);

export function Topbar({ onOpenNavigation }: { onOpenNavigation: () => void }) {
  const palette = useCommandPalette();
  const { user } = useAuth();

  return (
    <header className="flex h-14 shrink-0 items-center gap-2 border-b border-border bg-bg px-3 sm:px-4 lg:px-6">
      <Button variant="ghost" size="icon" aria-label="Open navigation" onClick={onOpenNavigation} className="lg:hidden">
        <Menu />
      </Button>
      <Link to="/" aria-label="LambData dashboard" className="mr-1 rounded-md p-1 outline-none focus-visible:ring-2 focus-visible:ring-ring/70 lg:hidden">
        <Logo size={20} />
      </Link>

      <button
        type="button"
        onClick={palette.open}
        aria-label="Search pages, databases and actions"
        aria-keyshortcuts={isMac ? "Meta+K /" : "Control+K /"}
        className="group hidden h-9 w-full max-w-sm items-center gap-2.5 rounded-md border border-border-input bg-bg-inset px-3 text-left text-body text-text-subtle outline-none transition-colors hover:border-border-control/60 hover:text-text-muted focus-visible:border-ring/70 focus-visible:ring-2 focus-visible:ring-ring/20 sm:flex"
      >
        <Search aria-hidden className="size-4 shrink-0" />
        <span className="min-w-0 flex-1 truncate">Search or jump to…</span>
        <KbdGroup>
          <Kbd>{isMac ? "⌘" : "Ctrl"}</Kbd>
          <Kbd>K</Kbd>
        </KbdGroup>
      </button>

      <div className="ml-auto flex shrink-0 items-center gap-1">
        <SimpleTooltip content="Search" side="bottom">
          <Button variant="ghost" size="icon" aria-label="Search pages, databases and actions" onClick={palette.open} className="sm:hidden">
            <Search />
          </Button>
        </SimpleTooltip>
        <JobsIndicator />
        {user?.role === "admin" && <NotificationsBell />}
        <UserMenu />
      </div>
    </header>
  );
}

const SEEN_KEY = "lambdata-notifications-seen-at";

function readSeen(): number {
  try {
    return Number(window.localStorage.getItem(SEEN_KEY) ?? 0) || 0;
  } catch {
    return 0;
  }
}

function writeSeen(value: number): void {
  try {
    window.localStorage.setItem(SEEN_KEY, String(value));
  } catch {
    return;
  }
}

function describe(log: AuditLogEntry): string {
  const who = log.user_display_name ?? log.user_email ?? "System";
  return `${who} · ${log.action}`;
}

function NotificationsBell() {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [seenAt, setSeenAt] = useState(readSeen);
  const logs = useAuditLogs(8, { poll: 30_000 });
  const targetOf = useAuditTargets();
  const entries = logs.data ?? [];
  const unread = useMemo(() => entries.filter((log) => log.at > seenAt).length, [entries, seenAt]);
  const label = unread > 0 ? `Activity, ${unread} new` : "Activity";

  const onOpenChange = (next: boolean) => {
    setOpen(next);
    if (next && entries.length > 0) {
      const newest = Math.max(...entries.map((log) => log.at));
      writeSeen(newest);
      setTimeout(() => setSeenAt(newest), 1200);
    }
  };

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <SimpleTooltip content={label} side="bottom">
        <PopoverTrigger asChild>
          <Button variant="ghost" size="icon" aria-label={label} className="relative">
            <Bell />
            {unread > 0 && (
              <span aria-hidden className="absolute right-2 top-2 size-2 rounded-full border border-bg bg-accent" />
            )}
          </Button>
        </PopoverTrigger>
      </SimpleTooltip>
      <PopoverContent align="end" className="w-[min(22rem,calc(100vw-1.5rem))] p-0">
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <span className="text-heading font-semibold">Recent activity</span>
          <Button
            variant="link"
            size="xs"
            onClick={() => {
              setOpen(false);
              navigate("/activity");
            }}
          >
            View all
          </Button>
        </div>
        {logs.isPending ? (
          <p className="px-4 py-6 text-center text-body text-text-muted">Loading…</p>
        ) : logs.isError ? (
          <p className="px-4 py-6 text-center text-body text-text-muted">{errorMessage(logs.error, "Could not load activity")}</p>
        ) : entries.length === 0 ? (
          <p className="px-4 py-6 text-center text-body text-text-muted">No activity recorded yet.</p>
        ) : (
          <ul className="max-h-80 divide-y divide-border overflow-y-auto">
            {entries.map((log) => (
              <li key={log.id} className="flex items-start gap-3 px-4 py-2.5">
                <span
                  aria-hidden
                  className={log.at > seenAt ? "mt-1.5 size-1.5 shrink-0 rounded-full bg-accent" : "mt-1.5 size-1.5 shrink-0 rounded-full bg-border-strong"}
                />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-body text-text">{describe(log)}</div>
                  <div className="flex items-center gap-2 text-micro text-text-subtle">
                    {log.target && <span className="min-w-0 truncate">{targetOf(log.target)?.label}</span>}
                    <span className="shrink-0">{formatRelativeTime(log.at)}</span>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </PopoverContent>
    </Popover>
  );
}

function UserMenu() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const palette = useCommandPalette();
  const [signingOut, setSigningOut] = useState(false);
  if (!user) return null;
  const name = user.displayName ?? user.email;

  const signOut = async () => {
    setSigningOut(true);
    try {
      await logout();
    } catch {
      toast.warning("Signed out locally", { description: "The server could not be reached to end the session." });
    } finally {
      setSigningOut(false);
      navigate("/login", { replace: true });
    }
  };

  const setTheme = (value: string) => {
    updateColorTheme(qc, user, value as ColorTheme).catch((error) => toast.error(errorMessage(error, "Could not save theme")));
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" className="h-9 gap-2 px-1.5 sm:px-2" aria-label={`Account menu for ${name}`}>
          <Avatar size="sm" name={name} />
          <span className="hidden max-w-[10rem] truncate text-body text-text md:inline">{name}</span>
          <ChevronDown aria-hidden className="hidden size-3.5 text-text-subtle md:block" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-72">
        <div className="flex items-center gap-3 px-2 py-2">
          <Avatar name={name} />
          <div className="min-w-0 flex-1">
            <div className="truncate text-body font-medium text-text">{user.displayName ?? "Signed in"}</div>
            <div className="truncate font-mono text-micro text-text-muted">{user.email}</div>
          </div>
          <Badge variant="muted" size="sm">
            {roleLabel(user.role)}
          </Badge>
        </div>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => navigate("/settings")}>
          <Settings /> Settings
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => palette.open()}>
          <CommandIcon /> Command menu
          <DropdownMenuShortcut>{isMac ? "⌘K" : "Ctrl K"}</DropdownMenuShortcut>
        </DropdownMenuItem>
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>
            <Palette /> Theme
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent>
            <DropdownMenuLabel>Theme</DropdownMenuLabel>
            <DropdownMenuRadioGroup value={user.colorTheme} onValueChange={setTheme}>
              {COLOR_THEMES.map((theme) => (
                <DropdownMenuRadioItem key={theme.value} value={theme.value}>
                  {theme.label}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        <DropdownMenuSeparator />
        <DropdownMenuItem variant="danger" disabled={signingOut} onSelect={() => void signOut()}>
          <LogOut /> {signingOut ? "Signing out…" : "Sign out"}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
