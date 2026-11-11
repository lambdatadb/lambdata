import {
  Braces,
  Database,
  FolderOpen,
  KeyRound,
  LayoutDashboard,
  Network,
  RadioTower,
  ScrollText,
  Send,
  Settings,
  ShieldCheck,
  SquareFunction,
  Users,
  type LucideIcon,
} from "lucide-react";
import type { Role } from "@lambdata/shared";

export interface NavItem {
  to: string;
  label: string;
  icon: LucideIcon;
  description: string;
  keywords?: string[];
  roles?: Role[];
  badge?: "approvals";
}

export interface NavGroup {
  title?: string;
  items: NavItem[];
}

export const NAV_GROUPS: NavGroup[] = [
  {
    items: [
      { to: "/", label: "Dashboard", icon: LayoutDashboard, description: "Overview of the cluster", keywords: ["home", "overview"] },
      { to: "/databases", label: "Databases", icon: Database, description: "Schemas, users and connection strings", keywords: ["schemas", "mariadb", "mysql"] },
    ],
  },
  {
    title: "Platform",
    items: [
      { to: "/auth", label: "Auth", icon: ShieldCheck, description: "Application users and sign-in", keywords: ["app users", "signup", "login"] },
      { to: "/data-api", label: "Data API", icon: Braces, description: "REST access and policies", keywords: ["rest", "policies", "openapi"] },
      { to: "/storage", label: "Storage", icon: FolderOpen, description: "Buckets and objects", keywords: ["files", "buckets", "objects"] },
      { to: "/realtime", label: "Realtime", icon: RadioTower, description: "Channels and connections", keywords: ["websocket", "channels", "broadcast"] },
      { to: "/functions", label: "Functions", icon: SquareFunction, description: "Edge functions and secrets", keywords: ["edge", "secrets", "invoke"] },
    ],
  },
  {
    title: "Operate",
    items: [
      { to: "/activity", label: "Activity", icon: ScrollText, description: "Audit log", keywords: ["audit", "log", "events"], roles: ["admin"] },
      { to: "/users", label: "Users", icon: Users, description: "Console accounts and roles", keywords: ["accounts", "roles", "invite"], roles: ["admin"] },
      {
        to: "/access-tokens",
        label: "Access tokens",
        icon: KeyRound,
        description: "Tokens for AI agents and scripts, and their approvals",
        keywords: ["api key", "token", "agent", "mcp", "claude", "automation", "approvals", "ask first"],
        roles: ["admin"],
        badge: "approvals",
      },
      { to: "/network", label: "Network", icon: Network, description: "Tailscale, tunnels and access policy", keywords: ["tailscale", "tailnet", "cloudflare", "tunnel"] },
      {
        to: "/notifications",
        label: "Notifications",
        icon: Send,
        description: "Messages to Discord, Slack, ntfy or a webhook",
        keywords: ["alerts", "webhook", "discord", "slack", "mattermost", "ntfy", "push", "notify"],
        roles: ["admin"],
      },
      { to: "/settings", label: "Settings", icon: Settings, description: "Profile, theme and storage", keywords: ["preferences", "theme", "password", "profile"] },
    ],
  },
];

export const NAV_ITEMS: NavItem[] = NAV_GROUPS.flatMap((g) => g.items);

export function visibleNavItems(items: NavItem[], role: Role | undefined): NavItem[] {
  return items.filter((item) => !item.roles || (role !== undefined && item.roles.includes(role)));
}

export function isNavActive(item: NavItem, pathname: string): boolean {
  if (item.to === "/") return pathname === "/";
  return pathname === item.to || pathname.startsWith(`${item.to}/`);
}
