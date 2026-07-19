import { cn } from "../ui/cn";
import { Icon } from "../ui/Icon";

export type ViewMode = "grid" | "list";

interface Props {
  value: ViewMode;
  onChange: (v: ViewMode) => void;
}

export function ViewToggle({ value, onChange }: Props) {
  return (
    <div className="inline-flex p-0.5 rounded-md border border-border bg-bg-subtle">
      <button
        onClick={() => onChange("grid")}
        className={cn(
          "px-2.5 h-7 rounded text-xs flex items-center gap-1.5 transition-colors",
          value === "grid" ? "bg-bg-panel text-text" : "text-text-muted hover:text-text",
        )}
      >
        <Icon name="grid_view" size={14} />
        Grid
      </button>
      <button
        onClick={() => onChange("list")}
        className={cn(
          "px-2.5 h-7 rounded text-xs flex items-center gap-1.5 transition-colors",
          value === "list" ? "bg-bg-panel text-text" : "text-text-muted hover:text-text",
        )}
      >
        <Icon name="view_list" size={14} />
        List
      </button>
    </div>
  );
}
