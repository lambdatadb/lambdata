import { useEffect } from "react";
import type { ColorTheme } from "@kilndb/shared";
import { useAuth } from "./auth";

const STORAGE_KEY = "kilndb-color-theme";
const THEMES = new Set<ColorTheme>(["ember", "tide", "grove", "orchid"]);
let transitionTimer: ReturnType<typeof setTimeout> | null = null;

export function applyColorTheme(theme: ColorTheme, animate = false): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  if (animate && root.dataset.theme !== theme) {
    root.classList.add("theme-changing");
    if (transitionTimer) clearTimeout(transitionTimer);
    transitionTimer = setTimeout(() => root.classList.remove("theme-changing"), 300);
  }
  root.dataset.theme = theme;
  try {
    window.localStorage.setItem(STORAGE_KEY, theme);
  } catch {
    return;
  }
}

export function initializeColorTheme(): void {
  if (typeof window === "undefined") return;
  let stored: string | null = null;
  try {
    stored = window.localStorage.getItem(STORAGE_KEY);
  } catch {
    stored = null;
  }
  applyColorTheme(THEMES.has(stored as ColorTheme) ? stored as ColorTheme : "ember");
}

export function ThemeSync() {
  const { user } = useAuth();

  useEffect(() => {
    if (user) applyColorTheme(user.colorTheme);
  }, [user?.colorTheme]);

  return null;
}
