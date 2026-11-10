import { db } from "../client";

export const settings = {
  get(key: string): string | null {
    const row = db.query("SELECT value FROM settings WHERE key = ?").get(key) as
      | { value: string }
      | null;
    return row?.value ?? null;
  },
  getBool(key: string, fallback: boolean): boolean {
    const value = this.get(key);
    if (value === "1" || value === "true") return true;
    if (value === "0" || value === "false") return false;
    return fallback;
  },
  set(key: string, value: string): void {
    db.query(
      "INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    ).run(key, value);
  },
};
