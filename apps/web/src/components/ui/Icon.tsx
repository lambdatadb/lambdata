import type { LucideIcon } from "lucide-react";
import { createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { cn } from "./cn";

export type IconLike = LucideIcon | ReactElement;

export function renderIcon(icon: IconLike | undefined, size: number, className?: string): ReactNode {
  if (icon === undefined) return null;
  if (isValidElement(icon)) return icon;
  return createElement(icon as LucideIcon, {
    size,
    strokeWidth: 1.75,
    "aria-hidden": true,
    className: cn("shrink-0", className),
    style: { width: size, height: size },
  });
}
