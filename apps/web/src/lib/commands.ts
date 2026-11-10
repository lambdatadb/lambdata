import type { ComponentType } from "react";
import type { QueryClient } from "@tanstack/react-query";
import type { NavigateFunction } from "react-router-dom";
import type { Database, User } from "@lambdata/shared";

export type CommandGroup = "Actions" | "Database" | "Navigation" | "Preferences";

export interface CommandContext {
  navigate: NavigateFunction;
  pathname: string;
  user: User;
  database: Database | null;
  queryClient: QueryClient;
  openCreateDatabase: (type?: string) => void;
  close: () => void;
}

export interface AppCommand {
  id: string;
  title: string | ((ctx: CommandContext) => string);
  group?: CommandGroup;
  keywords?: string[];
  icon?: ComponentType<{ className?: string }>;
  shortcut?: string;
  when?: (ctx: CommandContext) => boolean;
  run: (ctx: CommandContext) => void | Promise<void>;
}

export interface CommandModule {
  commands?: AppCommand[];
  default?: AppCommand[];
}

export function defineCommands(commands: AppCommand[]): AppCommand[] {
  return commands;
}

export function commandTitle(command: AppCommand, ctx: CommandContext): string {
  return typeof command.title === "function" ? command.title(ctx) : command.title;
}

export function databasePath(id: string, tab?: string, rest?: string): string {
  const base = `/databases/${encodeURIComponent(id)}`;
  if (!tab || tab === "overview") return base;
  return rest ? `${base}/${tab}/${rest}` : `${base}/${tab}`;
}
