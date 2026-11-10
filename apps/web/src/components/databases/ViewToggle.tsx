import { LayoutGrid, List } from "lucide-react";
import { SegmentedControl } from "../ui/RadioGroup";

export type ViewMode = "grid" | "list";

interface Props {
  value: ViewMode;
  onChange: (v: ViewMode) => void;
}

export function ViewToggle({ value, onChange }: Props) {
  return (
    <SegmentedControl
      aria-label="Layout"
      size="md"
      value={value}
      onValueChange={(v) => onChange(v as ViewMode)}
      options={[
        { value: "grid", label: <><LayoutGrid aria-hidden /> <span className="hidden sm:inline">Grid</span></>, "aria-label": "Grid" },
        { value: "list", label: <><List aria-hidden /> <span className="hidden sm:inline">List</span></>, "aria-label": "List" },
      ]}
    />
  );
}
