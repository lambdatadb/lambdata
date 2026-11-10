import { FileInput, FileUp } from "lucide-react";
import { canWriteDatabase } from "../lib/auth";
import { databasePath, defineCommands, type CommandContext } from "../lib/commands";

const canWrite = (ctx: CommandContext) => ctx.user.role !== "viewer";

export const commands = defineCommands([
  {
    id: "database:import",
    title: "Import database from file",
    group: "Actions",
    icon: FileUp,
    keywords: ["import", "upload", "sqlite", "sv.db", "garry's mod", "gmod", "dump", ".sql", "convert", "create"],
    when: canWrite,
    run: (ctx) => ctx.openCreateDatabase("import"),
  },
  {
    id: "database:replace-from-file",
    title: (ctx) => (ctx.database ? `Replace data in ${ctx.database.displayName} from file` : "Replace data from file"),
    group: "Database",
    icon: FileInput,
    keywords: ["import", "upload", "sqlite", "dump", "restore", "overwrite", "load"],
    when: (ctx) => !!ctx.database && canWriteDatabase(ctx.user, ctx.database),
    run: (ctx) => {
      if (ctx.database) ctx.navigate(databasePath(ctx.database.id, "import"));
    },
  },
]);
