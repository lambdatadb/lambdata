export function formatBytes(n: number | null | undefined): string {
  if (n == null) return "—";
  if (n === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.min(units.length - 1, Math.floor(Math.log2(n) / 10));
  const v = n / Math.pow(1024, i);
  return `${v.toFixed(v < 10 ? 2 : v < 100 ? 1 : 0)} ${units[i]}`;
}

export function formatRelativeTime(ts: number | null | undefined): string {
  if (!ts) return "never";
  const diff = Date.now() - ts;
  const abs = Math.abs(diff);
  const units: [number, string][] = [
    [60_000, "s"],
    [60 * 60_000, "m"],
    [24 * 60 * 60_000, "h"],
    [7 * 24 * 60 * 60_000, "d"],
    [Infinity, "w"],
  ];
  if (abs < 60_000) return "just now";
  for (let i = 0; i < units.length - 1; i++) {
    const [next, label] = units[i + 1]!;
    const cur = units[i]!;
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
