import { renderToStaticMarkup } from "react-dom/server";
import type { SyncChangeSummary, TableRowChange } from "@lambdata/shared";
import { changeHeadline, netReason, readSyncChanges, SyncChanges, tableChangeText } from "./SyncChanges";

declare const test: (name: string, fn: () => void | Promise<void>) => void;
declare const expect: (value: unknown) => {
  toBe(expected: unknown): void;
  toEqual(expected: unknown): void;
  toContain(expected: unknown): void;
  toBeNull(): void;
  not: { toContain(expected: unknown): void };
};

function text(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
}

function table(name: string, extra: Partial<TableRowChange> = {}): TableRowChange {
  return { name, change: "modified", method: "exact", schemaChanged: false, rowsBefore: 10, rowsAfter: 10, added: 0, removed: 0, changed: 0, ...extra };
}

function summary(tables: TableRowChange[], extra: Partial<SyncChangeSummary> = {}): SyncChangeSummary {
  return {
    tablesChanged: tables.length,
    tablesUnchanged: 0,
    exactTables: 0,
    netTables: 0,
    rowsAdded: null,
    rowsRemoved: null,
    rowsChanged: null,
    rowDelta: 0,
    tables,
    truncated: false,
    ...extra,
  };
}

test("the summary lists totals first, then each changed table with exact or net numbers", () => {
  const s = summary(
    [
      table("matches", { added: 1200, removed: 8, changed: 40 }),
      table("players", { method: "net", rowsBefore: 4310, rowsAfter: 5512, added: null, removed: null, changed: null, reason: "no-key" }),
      table("events", { method: "net", rowsBefore: 3_000_000, rowsAfter: 3_000_100, added: null, removed: null, changed: null, reason: "too-large" }),
      table("bans", { method: "net", schemaChanged: true, rowsBefore: 4, rowsAfter: 4, added: null, removed: null, changed: null }),
      table("seasons", { change: "added", method: "net", rowsBefore: null, rowsAfter: 3, added: null, removed: null, changed: null }),
      table("legacy", { change: "removed", method: "net", rowsBefore: 9, rowsAfter: null, added: null, removed: null, changed: null }),
    ],
    { rowsAdded: 1204, rowsRemoved: 12, rowsChanged: 40, tablesUnchanged: 123, tablesChanged: 8 },
  );
  const html = renderToStaticMarkup(<SyncChanges changes={s} />);
  const t = text(html);
  expect(t).toContain("8 tables changed: 1,204 rows added, 12 removed, 40 changed. 123 tables unchanged.");
  expect(t).toContain("matches 1,200 added, 8 removed, 40 changed");
  expect(t).toContain("players 4,310 → 5,512 rows Net: no primary key, so only the row count is compared.");
  expect(t).toContain("events 3,000,000 → 3,000,100 rows Net: too large to compare row by row.");
  expect(t).toContain("bans 4 → 4 rows Net: structure changed, so only the row count is compared.");
  expect(t).toContain("seasons new table, 3 rows");
  expect(t).toContain("legacy removed, had 9 rows");
  expect(t).toContain("and 2 more tables.");
  expect(html).toContain('data-sync-changes="changed"');
});

test("nothing changed, not measured, and net-only headlines", () => {
  expect(text(renderToStaticMarkup(<SyncChanges changes={summary([], { tablesUnchanged: 12 })} />))).toBe("Nothing changed in 12 tables.");
  expect(text(renderToStaticMarkup(<SyncChanges changes={null} />))).toBe("What this sync changed was not measured.");
  expect(renderToStaticMarkup(<SyncChanges changes={undefined} />)).toBe("");
  expect(changeHeadline(summary([table("a", { method: "net" })], { rowDelta: -3 }))).toBe("1 table changed: −3 rows in all");
  expect(changeHeadline(summary([table("a", { schemaChanged: true })], { rowsAdded: 0, rowsRemoved: 0, rowsChanged: 0 }))).toBe("1 table changed");
  expect(tableChangeText(table("a", { schemaChanged: true }))).toBe("structure changed, rows the same");
  expect(netReason(table("a", { method: "net", reason: "time" }))).toBe("the time for comparing rows ran out during this sync");
  expect(netReason(table("a"))).toBeNull();
});

test("a malformed result is ignored, and table names are rendered as text", () => {
  expect(readSyncChanges(null)).toBeNull();
  expect(readSyncChanges({ tablesChanged: "3" })).toBeNull();
  expect(readSyncChanges([1, 2])).toBeNull();
  const html = renderToStaticMarkup(<SyncChanges changes={summary([table("<img src=x onerror=alert(1)>", { added: 1 })])} />);
  expect(html).not.toContain("<img");
  expect(html).toContain("&lt;img");
});

test("tables that were not compared are said in one plain sentence", () => {
  const partial = text(renderToStaticMarkup(<SyncChanges changes={summary([], { tablesUnchanged: 3, tablesNotCompared: 12, rowDelta: null })} />));
  expect(partial).toBe("No changes in the 3 tables that were compared. 12 tables were not compared because the sync's time limit for comparing was reached.");
  const changed = text(renderToStaticMarkup(<SyncChanges changes={summary([table("a", { added: 1 })], { rowsAdded: 1, rowsRemoved: 0, rowsChanged: 0, tablesNotCompared: 1 })} />));
  expect(changed).toContain("1 table was not compared because the sync's time limit for comparing was reached.");
  expect(changeHeadline(summary([], { tablesNotCompared: 2 }))).toBe("No changes in the tables that were compared");
  expect(text(renderToStaticMarkup(<SyncChanges changes={summary([], { tablesNotCompared: 0 })} />))).toBe("Nothing changed.");
});
