import { RefreshCw, SlidersHorizontal } from "lucide-react";
import { canWriteDatabase } from "../lib/auth";
import { databasePath, defineCommands } from "../lib/commands";

export const commands = defineCommands([
  {
    id: "database:sync-now",
    title: (ctx) => (ctx.database ? `Sync ${ctx.database.displayName} now` : "Sync now"),
    group: "Database",
    icon: RefreshCw,
    keywords: ["sync", "mirror", "refresh", "copy", "run", "pull"],
    when: (ctx) => ctx.database?.kind === "mirror" && canWriteDatabase(ctx.user, ctx.database),
    run: (ctx) => {
      if (ctx.database) ctx.navigate(`${databasePath(ctx.database.id, "sync")}?run=1`);
    },
  },
  {
    id: "database:settings",
    title: "Open database settings",
    group: "Database",
    icon: SlidersHorizontal,
    keywords: ["settings", "checkpoints", "interval", "keep", "retention", "versioned", "sync interval", "schedule"],
    when: (ctx) => !!ctx.database,
    run: (ctx) => {
      if (ctx.database) ctx.navigate(databasePath(ctx.database.id, "settings"));
    },
  },
]);
