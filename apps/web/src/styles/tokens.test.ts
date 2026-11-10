import css from "./globals.css?raw";

declare const test: (name: string, fn: () => void) => void;
declare const expect: (value: unknown) => {
  toBe(expected: unknown): void;
  toEqual(expected: unknown): void;
  toBeGreaterThanOrEqual(expected: number): void;
};

type Theme = Record<string, [number, number, number]>;

function parseThemes(source: string): Record<string, Theme> {
  const themes: Record<string, Theme> = {};
  const block = /((?::root(?:\[data-theme="[a-z]+"\])?\s*,\s*)*:root(?:\[data-theme="([a-z]+)"\])?)\s*\{([^}]*)\}/g;
  for (const match of source.matchAll(block)) {
    const selector = match[1] ?? "";
    const body = match[3] ?? "";
    if (!body.includes("--surface-base")) continue;
    const name = selector.includes('"lime"') ? "lime" : (match[2] ?? "root");
    const vars: Theme = {};
    for (const [, key, r, g, b] of body.matchAll(/--([a-z0-9-]+):\s*(\d+)\s+(\d+)\s+(\d+);/g)) {
      vars[key!] = [Number(r), Number(g), Number(b)];
    }
    themes[name] = vars;
  }
  return themes;
}

function luminance([r, g, b]: [number, number, number]): number {
  const f = (c: number) => {
    const v = c / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

function contrast(a: [number, number, number], b: [number, number, number]): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

const themes = parseThemes(css);

const pairs: [string, string, number][] = [
  ["content-1", "surface-base", 7],
  ["content-1", "surface-panel", 7],
  ["content-2", "surface-base", 4.5],
  ["content-2", "surface-panel", 4.5],
  ["content-2", "surface-overlay", 4.5],
  ["content-2", "surface-selected", 4.5],
  ["content-3", "surface-base", 4.5],
  ["content-3", "surface-panel", 4.5],
  ["content-3", "surface-raised", 4.5],
  ["content-3", "surface-overlay", 4.5],
  ["content-3", "surface-hover", 4.5],
  ["accent-fg", "accent", 4.5],
  ["danger-fg", "danger", 4.5],
  ["accent", "surface-panel", 3],
  ["ring", "surface-panel", 3],
  ["danger", "surface-panel", 4.5],
  ["ok", "surface-panel", 4.5],
  ["warn", "surface-panel", 4.5],
  ["info", "surface-panel", 4.5],
  ["edge-control", "surface-panel", 3],
];

test("all five themes are defined", () => {
  expect(Object.keys(themes).sort()).toEqual(["ember", "grove", "lime", "orchid", "tide"]);
});

test("every theme defines the same tokens as lime", () => {
  const reference = Object.keys(themes.lime ?? {}).sort();
  for (const theme of Object.values(themes)) expect(Object.keys(theme).sort()).toEqual(reference);
});

test("lime matches the identity colours", () => {
  expect(themes.lime?.["surface-base"]).toEqual([18, 20, 23]);
  expect(themes.lime?.["surface-selected"]).toEqual([42, 47, 54]);
  expect(themes.lime?.["accent"]).toEqual([198, 242, 78]);
  expect(themes.lime?.["content-1"]).toEqual([238, 241, 244]);
});

for (const [name, theme] of Object.entries(themes)) {
  test(`${name} meets contrast minimums`, () => {
    for (const [fg, bg, min] of pairs) {
      const ratio = contrast(theme[fg]!, theme[bg]!);
      expect({ pair: `${name} ${fg} on ${bg}`, ok: ratio >= min }).toEqual({ pair: `${name} ${fg} on ${bg}`, ok: true });
    }
  });
}
