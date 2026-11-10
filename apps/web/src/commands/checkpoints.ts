import { GitCommitHorizontal, History } from "lucide-react";
import { canWriteDatabase } from "../lib/auth";
import { databasePath, defineCommands, type CommandContext } from "../lib/commands";

const canWriteCurrent = (ctx: CommandContext) => !!ctx.database && canWriteDatabase(ctx.user, ctx.database);

export const commands = defineCommands([
  {
    id: "checkpoints:create",
    title: "Create checkpoint",
    group: "Database",
    icon: GitCommitHorizontal,
    keywords: ["checkpoint", "commit", "snapshot", "backup", "save", "version", "git"],
    when: canWriteCurrent,
    run: (ctx) => {
      if (ctx.database) ctx.navigate(databasePath(ctx.database.id, "history", "new"));
    },
  },
  {
    id: "checkpoints:history",
    title: "Open history",
    group: "Database",
    icon: History,
    keywords: ["checkpoints", "commits", "rollback", "restore", "roll back", "download", "snapshots", "git", "log"],
    when: (ctx) => !!ctx.database,
    run: (ctx) => {
      if (ctx.database) ctx.navigate(databasePath(ctx.database.id, "history"));
    },
  },
]);
