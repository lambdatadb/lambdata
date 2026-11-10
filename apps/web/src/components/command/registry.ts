import type { AppCommand, CommandModule } from "../../lib/commands";

const modules = import.meta.glob<CommandModule>("../../commands/*.ts", { eager: true });

function collect(): AppCommand[] {
  const seen = new Set<string>();
  const out: AppCommand[] = [];
  for (const path of Object.keys(modules).sort()) {
    const mod = modules[path]!;
    const list = [...(mod.commands ?? []), ...(Array.isArray(mod.default) ? mod.default : [])];
    for (const command of list) {
      if (seen.has(command.id)) {
        if (import.meta.env.DEV) console.warn(`Command palette: duplicate command id "${command.id}" in ${path}`);
        continue;
      }
      seen.add(command.id);
      out.push(command);
    }
  }
  return out;
}

export const COMMANDS: AppCommand[] = collect();
