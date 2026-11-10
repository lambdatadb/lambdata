export function formatBytes(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  if (n === 0) return "0 B";
  const abs = Math.abs(n);
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.max(0, Math.min(units.length - 1, Math.floor(Math.log2(abs) / 10)));
  const v = n / Math.pow(1024, i);
  const av = Math.abs(v);
  return `${v.toFixed(i === 0 ? 0 : av < 10 ? 2 : av < 100 ? 1 : 0)} ${units[i]}`;
}

const RELATIVE_UNITS: [number, string][] = [
  [60_000, "s"],
  [60 * 60_000, "m"],
  [24 * 60 * 60_000, "h"],
  [7 * 24 * 60 * 60_000, "d"],
  [Infinity, "w"],
];

export function formatRelativeTime(ts: number | null | undefined): string {
  if (!ts) return "never";
  const diff = Date.now() - ts;
  const abs = Math.abs(diff);
  if (abs < 60_000) return "just now";
  for (let i = 0; i < RELATIVE_UNITS.length - 1; i++) {
    const [next, label] = RELATIVE_UNITS[i + 1]!;
    const cur = RELATIVE_UNITS[i]!;
    if (abs < next) {
      const v = Math.floor(abs / cur[0]);
      return diff < 0 ? `in ${v}${label}` : `${v}${label} ago`;
    }
  }
  return new Date(ts).toLocaleDateString();
}

export function formatDate(ts: number | null | undefined): string {
  if (!ts) return "—";
  return new Date(ts).toLocaleString();
}

export function formatCount(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  const abs = Math.abs(n);
  if (abs < 1000) return String(n);
  if (abs < 1_000_000) return `${(n / 1000).toFixed(abs < 10_000 ? 1 : 0)}K`;
  if (abs < 1_000_000_000) return `${(n / 1_000_000).toFixed(abs < 10_000_000 ? 1 : 0)}M`;
  return `${(n / 1_000_000_000).toFixed(1)}B`;
}

export function formatNumber(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return n.toLocaleString();
}

export function formatDuration(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms)) return "—";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(s < 10 ? 1 : 0)} s`;
  const m = Math.floor(s / 60);
  const rs = Math.round(s % 60);
  if (m < 60) return `${m}m ${rs}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

export function formatSignedBytes(value: number): string {
  if (value === 0) return "no change";
  return `${value > 0 ? "+" : "−"}${formatBytes(Math.abs(value))}`;
}

export function pluralize(n: number, one: string, many = `${one}s`): string {
  return `${formatNumber(n)} ${n === 1 ? one : many}`;
}

export function displayCount(value: number | string | null | undefined): string {
  if (value === null || value === undefined || value === "") return "—";
  if (typeof value === "string") return value;
  return value.toLocaleString();
}

export function displayBytes(value: number | string | null | undefined): string {
  if (value === null || value === undefined || value === "") return "—";
  if (typeof value === "number") return formatBytes(value);
  const n = Number(value);
  return Number.isSafeInteger(n) ? formatBytes(n) : `${value} B`;
}
