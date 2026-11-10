import { clsx, type ClassValue } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

const merge = extendTailwindMerge({
  extend: {
    classGroups: {
      "font-size": [{ text: ["micro", "label", "body", "code", "heading", "title", "metric", "display"] }],
      shadow: [{ shadow: ["card", "raised", "overlay"] }],
    },
  },
});

export type { ClassValue };

export function cn(...inputs: ClassValue[]): string {
  return merge(clsx(inputs));
}
