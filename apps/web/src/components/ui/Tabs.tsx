import { motion } from "framer-motion";
import { cn } from "./cn";

interface Tab {
  id: string;
  label: string;
  hidden?: boolean;
}

interface Props {
  tabs: Tab[];
  active: string;
  onChange: (id: string) => void;
}

export function Tabs({ tabs, active, onChange }: Props) {
  return (
    <div className="flex items-center gap-1 border-b border-border">
      {tabs.filter((t) => !t.hidden).map((t) => {
        const isActive = t.id === active;
        return (
          <button
            key={t.id}
            onClick={() => onChange(t.id)}
            className={cn(
              "relative px-3 py-2 text-body font-medium transition-colors",
              isActive ? "text-text" : "text-text-muted hover:text-text",
            )}
          >
            {t.label}
            {isActive && (
              <motion.span
                layoutId="tab-underline"
                className="absolute inset-x-0 -bottom-px h-px bg-accent"
                transition={{ type: "spring", stiffness: 380, damping: 30 }}
              />
            )}
          </button>
        );
      })}
    </div>
  );
}
