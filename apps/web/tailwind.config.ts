import type { Config } from "tailwindcss";

function channel(name: string): string {
  return `rgb(var(--${name}) / <alpha-value>)`;
}

export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  darkMode: "class",
  theme: {
    extend: {
      colors: {
        bg: {
          DEFAULT: channel("surface-base"),
          panel: channel("surface-panel"),
          subtle: channel("surface-raised"),
          raised: channel("surface-raised"),
          overlay: channel("surface-overlay"),
        },
        border: {
          DEFAULT: channel("edge"),
          strong: channel("edge-strong"),
        },
        text: {
          DEFAULT: channel("content-1"),
          muted: channel("content-2"),
          subtle: channel("content-3"),
        },
        accent: {
          DEFAULT: channel("accent"),
          hover: channel("accent-hover"),
          fg: channel("accent-fg"),
        },
        success: channel("ok"),
        warn: channel("warn"),
        danger: {
          DEFAULT: channel("danger"),
          hover: channel("danger-hover"),
        },
        chart: {
          "1": channel("chart-1"),
          "2": channel("chart-2"),
          "3": channel("chart-3"),
          "4": channel("chart-4"),
          "5": channel("chart-5"),
          "6": channel("chart-6"),
          other: channel("chart-other"),
        },
      },
      fontFamily: {
        sans: ['"Inter Variable"', 'Inter', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        mono: ['"JetBrains Mono Variable"', '"JetBrains Mono"', 'ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
      },
      fontSize: {
        micro: ["11px", { lineHeight: "16px" }],
        label: ["12px", { lineHeight: "16px" }],
        body: ["13px", { lineHeight: "20px" }],
        title: ["18px", { lineHeight: "26px", letterSpacing: "-0.01em" }],
        display: ["26px", { lineHeight: "32px", letterSpacing: "-0.02em" }],
      },
      boxShadow: {
        card: "0 1px 2px 0 rgb(0 0 0 / 0.35)",
        raised: "0 4px 12px -2px rgb(0 0 0 / 0.4)",
        overlay: "0 16px 48px -12px rgb(0 0 0 / 0.65)",
      },
    },
  },
  plugins: [],
} satisfies Config;
