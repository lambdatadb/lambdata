import { useEffect, useMemo, useState, type ReactNode } from "react";
import { matchPath, useLocation, useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { ArrowLeftRight, CornerDownLeft, Database as DatabaseIcon } from "lucide-react";
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
  CommandShortcut,
} from "../ui/Command";
import { Kbd } from "../ui/Kbd";
import { toast } from "../ui/Toast";
import { useAuth } from "../../lib/auth";
import { useDatabase, useDatabases } from "../../lib/queries";
import { useCreateDatabaseDialog } from "../../lib/createDatabase";
import { errorMessage } from "../../lib/api";
import { commandTitle, databasePath, type AppCommand, type CommandContext, type CommandGroup as Group } from "../../lib/commands";
import { COMMANDS } from "./registry";

function paletteFilter(value: string, search: string, keywords?: string[]): number {
  const terms = search.toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return 1;
  const title = value.toLowerCase();
  const haystack = `${title} ${(keywords ?? []).join(" ").toLowerCase()}`;
  if (!terms.every((term) => haystack.includes(term))) return 0;
  const words = title.split(/[\s:/_-]+/);
  if (terms.every((term) => words.some((word) => word.startsWith(term)))) return 1;
  return terms.every((term) => title.includes(term)) ? 0.7 : 0.4;
}

const GROUP_ORDER: Group[] = ["Database", "Actions", "Navigation", "Preferences"];

export function CommandMenu({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const navigate = useNavigate();
  const location = useLocation();
  const queryClient = useQueryClient();
  const { user } = useAuth();
  const createDialog = useCreateDatabaseDialog();
  const [search, setSearch] = useState("");
  const databases = useDatabases({ enabled: open && !!user });
  const match = matchPath("/databases/:id/*", location.pathname);
  const currentId = match?.params.id ?? null;
  const current = useDatabase(currentId);

  useEffect(() => {
    if (!open) setSearch("");
  }, [open]);

  const ctx = useMemo<CommandContext | null>(() => {
    if (!user) return null;
    return {
      navigate,
      pathname: location.pathname,
      user,
      database: current.data ?? null,
      queryClient,
      openCreateDatabase: (type) => createDialog.open(type),
      close: () => onOpenChange(false),
    };
  }, [navigate, location.pathname, user, current.data, queryClient, createDialog, onOpenChange]);

  const grouped = useMemo(() => {
    const map = new Map<Group, AppCommand[]>();
    if (!ctx) return map;
    for (const command of COMMANDS) {
      let visible = true;
      try {
        visible = command.when ? command.when(ctx) : true;
      } catch {
        visible = false;
      }
      if (!visible) continue;
      const group = command.group ?? "Actions";
      map.set(group, [...(map.get(group) ?? []), command]);
    }
    return map;
  }, [ctx]);

  if (!ctx) return null;

  const run = (command: AppCommand) => {
    onOpenChange(false);
    Promise.resolve()
      .then(() => command.run(ctx))
      .catch((error) => toast.error(errorMessage(error, `${commandTitle(command, ctx)} failed`)));
  };

  const go = (to: string) => {
    onOpenChange(false);
    navigate(to);
  };

  const dbList = databases.data ?? [];
  const groups = GROUP_ORDER.filter((g) => (grouped.get(g)?.length ?? 0) > 0);

  const renderGroup = (group: Group) => (
    <CommandGroup key={group} heading={group === "Database" && ctx.database ? ctx.database.displayName : group}>
      {(grouped.get(group) ?? []).map((command) => {
        const Icon = command.icon;
        const title = commandTitle(command, ctx);
        return (
          <CommandItem
            key={command.id}
            value={`${command.id} ${title}`}
            keywords={command.keywords}
            onSelect={() => run(command)}
          >
            {Icon ? <Icon /> : <CornerDownLeft />}
            <span className="truncate">{title}</span>
            {command.shortcut && <CommandShortcut>{command.shortcut}</CommandShortcut>}
          </CommandItem>
        );
      })}
    </CommandGroup>
  );

  const sections: ReactNode[] = [];
  for (const group of groups.filter((g) => g === "Database" || g === "Actions")) sections.push(renderGroup(group));
  if (dbList.length > 0) {
    sections.push(
      <CommandGroup key="databases" heading="Databases">
        {dbList.map((db) => (
          <CommandItem
            key={db.id}
            value={`database ${db.displayName} ${db.name}`}
            keywords={[db.name, db.kind]}
            onSelect={() => go(databasePath(db.id))}
          >
            {db.kind === "mirror" ? <ArrowLeftRight /> : <DatabaseIcon />}
            <span className="truncate">{db.displayName}</span>
            <span className="ml-auto truncate pl-3 font-mono text-micro text-text-subtle">{db.name}</span>
          </CommandItem>
        ))}
      </CommandGroup>,
    );
  }
  for (const group of groups.filter((g) => g !== "Database" && g !== "Actions")) sections.push(renderGroup(group));

  return (
    <CommandDialog open={open} onOpenChange={onOpenChange} commandProps={{ loop: true, filter: paletteFilter }}>
      <CommandInput
        value={search}
        onValueChange={setSearch}
        placeholder="Search pages, databases and actions"
        trailing={<Kbd className="hidden sm:inline-flex">Esc</Kbd>}
      />
      <CommandList>
        <CommandEmpty>No matches for “{search}”.</CommandEmpty>
        {sections.map((section, index) => (
          <div key={index}>
            {index > 0 && <CommandSeparator />}
            {section}
          </div>
        ))}
      </CommandList>
      <div className="hidden shrink-0 items-center gap-4 border-t border-border px-4 py-2 text-micro text-text-subtle sm:flex">
        <span className="inline-flex items-center gap-1.5">
          <Kbd>↑</Kbd>
          <Kbd>↓</Kbd> to move
        </span>
        <span className="inline-flex items-center gap-1.5">
          <Kbd>↵</Kbd> to run
        </span>
        <span className="ml-auto inline-flex items-center gap-1.5">
          <Kbd>/</Kbd> or <Kbd>⌘K</Kbd> to open
        </span>
      </div>
    </CommandDialog>
  );
}
