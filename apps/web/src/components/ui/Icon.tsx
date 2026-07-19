import { Circle } from "lucide-react";
import { cn } from "./cn";
import { ICON_MAP } from "./icons";

interface Props {
  name: string;
  size?: number;
  className?: string;
}

const warned = new Set<string>();

export function Icon({ name, size = 18, className }: Props) {
  const Lucide = ICON_MAP[name];
  if (!Lucide && import.meta.env.DEV && !warned.has(name)) {
    warned.add(name);
    console.warn(`Icon: no lucide mapping for "${name}"`);
  }
  const Rendered = Lucide ?? Circle;
  return (
    <Rendered
      size={size}
      strokeWidth={1.75}
      aria-hidden
      className={cn("shrink-0", className)}
    />
  );
}
