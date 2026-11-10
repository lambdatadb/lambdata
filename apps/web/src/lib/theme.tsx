import { useEffect } from "react";
import type { ColorTheme } from "@lambdata/shared";
import { useAuth } from "./auth";

const STORAGE_KEY = "lambdata-color-theme";
const LEGACY_STORAGE_KEY = "kilndb-color-theme";

export const DEFAULT_COLOR_THEME: ColorTheme = "lime";

export const COLOR_THEMES: { value: ColorTheme; label: string; description: string }[] = [
  { value: "lime", label: "Lime", description: "Ink and slate with a lime signal" },
  { value: "ember", label: "Ember", description: "Warm charcoal with a red-orange accent" },
  { value: "tide", label: "Tide", description: "Deep navy with a sky-blue accent" },
  { value: "grove", label: "Grove", description: "Forest black with a green accent" },
  { value: "orchid", label: "Orchid", description: "Plum black with a violet accent" },
];

const THEMES = new Set<ColorTheme>(COLOR_THEMES.map((t) => t.value));
let transitionTimer: ReturnType<typeof setTimeout> | null = null;

export function isColorTheme(value: unknown): value is ColorTheme {
  return typeof value === "string" && THEMES.has(value as ColorTheme);
}

function syncThemeColorMeta(): void {
  const meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
  if (!meta) return;
  const channels = getComputedStyle(document.documentElement).getPropertyValue("--surface-base").trim();
  if (channels) meta.content = `rgb(${channels.split(/\s+/).join(", ")})`;
}

export function applyColorTheme(theme: ColorTheme, animate = false): void {
  if (typeof document === "undefined") return;
  const next = isColorTheme(theme) ? theme : DEFAULT_COLOR_THEME;
  const root = document.documentElement;
  if (animate && root.dataset.theme !== next) {
    root.classList.add("theme-changing");
    if (transitionTimer) clearTimeout(transitionTimer);
    transitionTimer = setTimeout(() => root.classList.remove("theme-changing"), 300);
  }
  root.dataset.theme = next;
  syncThemeColorMeta();
  try {
    window.localStorage.setItem(STORAGE_KEY, next);
  } catch {
    return;
  }
}

export function initializeColorTheme(): void {
  if (typeof window === "undefined") return;
  let stored: string | null = null;
  try {
    stored = window.localStorage.getItem(STORAGE_KEY) ?? window.localStorage.getItem(LEGACY_STORAGE_KEY);
  } catch {
    stored = null;
  }
  applyColorTheme(isColorTheme(stored) ? stored : DEFAULT_COLOR_THEME);
}

export function ThemeSync() {
  const { user } = useAuth();

  useEffect(() => {
    if (user) applyColorTheme(user.colorTheme);
  }, [user?.colorTheme]);

  return null;
}
