import type { Config } from "tailwindcss";
import animate from "tailwindcss-animate";

function channel(name: string): string {
  return `rgb(var(--${name}) / <alpha-value>)`;
}

export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        bg: {
          DEFAULT: channel("surface-base"),
          inset: channel("surface-inset"),
          panel: channel("surface-panel"),
          subtle: channel("surface-raised"),
          raised: channel("surface-raised"),
          overlay: channel("surface-overlay"),
          hover: channel("surface-hover"),
          selected: channel("surface-selected"),
        },
        border: {
          DEFAULT: channel("edge"),
          strong: channel("edge-strong"),
          input: channel("edge-input"),
          control: channel("edge-control"),
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
        ring: channel("ring"),
        scrim: channel("scrim"),
        success: channel("ok"),
        warn: channel("warn"),
        info: channel("info"),
        danger: {
          DEFAULT: channel("danger"),
          hover: channel("danger-hover"),
          fg: channel("danger-fg"),
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
        sans: ['"Inter Variable"', "Inter", "ui-sans-serif", "system-ui", "sans-serif"],
        mono: ['"JetBrains Mono Variable"', '"JetBrains Mono"', "ui-monospace", "SFMono-Regular", "Menlo", "monospace"],
      },
      fontSize: {
        xs: ["12px", { lineHeight: "16px" }],
        sm: ["13px", { lineHeight: "20px" }],
        micro: ["11px", { lineHeight: "16px", letterSpacing: "0.01em" }],
        label: ["12px", { lineHeight: "16px" }],
        body: ["13px", { lineHeight: "20px" }],
        code: ["12.5px", { lineHeight: "20px" }],
        heading: ["15px", { lineHeight: "22px", letterSpacing: "-0.006em" }],
        title: ["18px", { lineHeight: "26px", letterSpacing: "-0.012em" }],
        metric: ["24px", { lineHeight: "30px", letterSpacing: "-0.02em" }],
        display: ["26px", { lineHeight: "32px", letterSpacing: "-0.02em" }],
      },
      borderRadius: {
        sm: "var(--radius-sm)",
        md: "var(--radius-md)",
        lg: "var(--radius-lg)",
        xl: "var(--radius-xl)",
      },
      boxShadow: {
        card: "0 0 #0000",
        raised: "0 8px 24px -8px rgb(0 0 0 / 0.55), 0 0 0 1px rgb(0 0 0 / 0.2)",
        overlay: "0 24px 64px -16px rgb(0 0 0 / 0.7), 0 0 0 1px rgb(0 0 0 / 0.25)",
      },
      keyframes: {
        "accordion-down": {
          from: { height: "0" },
          to: { height: "var(--radix-accordion-content-height)" },
        },
        "accordion-up": {
          from: { height: "var(--radix-accordion-content-height)" },
          to: { height: "0" },
        },
        "collapsible-down": {
          from: { height: "0" },
          to: { height: "var(--radix-collapsible-content-height)" },
        },
        "collapsible-up": {
          from: { height: "var(--radix-collapsible-content-height)" },
          to: { height: "0" },
        },
        "progress-indeterminate": {
          "0%": { transform: "translateX(-100%)" },
          "100%": { transform: "translateX(250%)" },
        },
      },
      animation: {
        "accordion-down": "accordion-down 180ms var(--ease-out)",
        "accordion-up": "accordion-up 160ms var(--ease-out)",
        "collapsible-down": "collapsible-down 180ms var(--ease-out)",
        "collapsible-up": "collapsible-up 160ms var(--ease-out)",
        "progress-indeterminate": "progress-indeterminate 1.4s var(--ease-in-out) infinite",
      },
      transitionTimingFunction: {
        out: "var(--ease-out)",
      },
    },
  },
  plugins: [animate],
} satisfies Config;
