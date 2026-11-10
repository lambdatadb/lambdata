import {
  ArrowLeftRight,
  ChartLine,
  LogOut,
  Palette,
  Plus,
  SquareTerminal,
  Table2,
  TriangleAlert,
} from "lucide-react";
import type { ColorTheme } from "@lambdata/shared";
import { api } from "../lib/api";
import { clearSessionData } from "../lib/auth";
import { databasePath, defineCommands, type AppCommand, type CommandContext } from "../lib/commands";
import { updateColorTheme } from "../lib/preferences";
import { COLOR_THEMES } from "../lib/theme";
import { NAV_ITEMS } from "../components/layout/nav";

const canWrite = (ctx: CommandContext) => ctx.user.role !== "viewer";

function setTheme(ctx: CommandContext, theme: ColorTheme): Promise<void> {
  return updateColorTheme(ctx.queryClient, ctx.user, theme);
}

const navigation: AppCommand[] = NAV_ITEMS.map((item) => ({
  id: `nav:${item.to}`,
  title: `Go to ${item.label}`,
  group: "Navigation",
  icon: item.icon,
  keywords: [item.label, item.description, ...(item.keywords ?? [])],
  when: (ctx) => !item.roles || item.roles.includes(ctx.user.role),
  run: (ctx) => ctx.navigate(item.to),
}));

const databaseTabs: AppCommand[] = [
  { tab: "query", title: "Open query console", icon: SquareTerminal, keywords: ["sql", "run", "select"] },
  { tab: "tables", title: "Browse tables", icon: Table2, keywords: ["schema", "rows", "size"] },
  { tab: "metrics", title: "View metrics", icon: ChartLine, keywords: ["size", "connections", "writes"] },
  { tab: "danger", title: "Delete this database", icon: TriangleAlert, keywords: ["drop", "remove", "danger"] },
].map(({ tab, title, icon, keywords }) => ({
  id: `database:${tab}`,
  title,
  group: "Database" as const,
  icon,
  keywords,
  when: (ctx: CommandContext) => !!ctx.database && (tab !== "danger" || ctx.user.role !== "viewer"),
  run: (ctx: CommandContext) => {
    if (ctx.database) ctx.navigate(databasePath(ctx.database.id, tab));
  },
}));

const themes: AppCommand[] = COLOR_THEMES.map((theme) => ({
  id: `theme:${theme.value}`,
  title: `Use the ${theme.label} theme`,
  group: "Preferences",
  icon: Palette,
  keywords: ["theme", "colour", "color", "appearance", theme.label, theme.description],
  when: (ctx) => ctx.user.colorTheme !== theme.value,
  run: (ctx) => setTheme(ctx, theme.value),
}));

export const commands = defineCommands([
  {
    id: "database:new",
    title: "New database",
    group: "Actions",
    icon: Plus,
    keywords: ["create", "provision", "schema"],
    when: canWrite,
    run: (ctx) => ctx.openCreateDatabase("standard"),
  },
  {
    id: "database:new-mirror",
    title: "New mirror database",
    group: "Actions",
    icon: ArrowLeftRight,
    keywords: ["create", "sync", "replica", "copy"],
    when: canWrite,
    run: (ctx) => ctx.openCreateDatabase("mirror"),
  },
  ...databaseTabs,
  ...navigation,
  {
    id: "theme:next",
    title: (ctx) => {
      const index = COLOR_THEMES.findIndex((t) => t.value === ctx.user.colorTheme);
      const next = COLOR_THEMES[(index + 1) % COLOR_THEMES.length]!;
      return `Toggle theme (next: ${next.label})`;
    },
    group: "Preferences",
    icon: Palette,
    keywords: ["theme", "switch", "cycle", "appearance"],
    run: (ctx) => {
      const index = COLOR_THEMES.findIndex((t) => t.value === ctx.user.colorTheme);
      return setTheme(ctx, COLOR_THEMES[(index + 1) % COLOR_THEMES.length]!.value);
    },
  },
  ...themes,
  {
    id: "session:sign-out",
    title: "Sign out",
    group: "Preferences",
    icon: LogOut,
    keywords: ["logout", "log out", "exit"],
    run: async (ctx) => {
      try {
        await api.post("/auth/logout");
      } finally {
        clearSessionData(ctx.queryClient);
        ctx.navigate("/login", { replace: true });
      }
    },
  },
]);
