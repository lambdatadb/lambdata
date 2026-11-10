import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StaticRouter } from "react-router-dom/server";
import { fixtureDatabase } from "../../pages/dev/jobFixtures";
import { fixtureSetAside } from "../../pages/dev/setAsideFixtures";
import { MoveBackAsFields, SetAsideCard, deleteSummary } from "./SetAsideCard";
import { deleteSetAside, fetchSetAside, moveBackSetAside, setAsideKey, suggestedName, tableNameError } from "./setAside";

declare const test: (name: string, fn: () => void | Promise<void>) => void;
declare const expect: (value: unknown) => {
  toBe(expected: unknown): void;
  toEqual(expected: unknown): void;
  toContain(expected: unknown): void;
  toBeNull(): void;
  not: { toContain(expected: unknown): void; toBeNull(): void };
};

function render(node: ReactElement): string {
  return renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <StaticRouter location="/">{node}</StaticRouter>
    </QueryClientProvider>,
  );
}

function text(html: string): string {
  return html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
}

const schemas = fixtureSetAside();

test("the card explains both kinds in plain words and lists every table with rows and size", () => {
  const html = render(<SetAsideCard db={fixtureDatabase} schemas={schemas} canAct />);
  const t = text(html);
  expect(html).toContain("border-warn/40");
  expect(html).toContain('data-set-aside="3"');
  expect(t).toContain("Tables set aside");
  expect(t).toContain("3 tables");
  expect(t).toContain(
    "While data was being swapped in, something created a new table with the same name. Your original table is back in the database; the new one was kept here.",
  );
  expect(t).toContain("A table could not be put back because its name is now used by something else. It is kept here, untouched.");
  expect(t).toContain("orders");
  expect(t).toContain("3 rows · 48.0 KB · its name is in use in the database");
  expect(t).toContain("1,204 rows · 128 KB");
  expect(t).toContain("7 rows · 80.0 KB");
});

test("a free name moves back directly, a taken name asks for a new one, and each schema can be deleted", () => {
  const html = render(<SetAsideCard db={fixtureDatabase} schemas={schemas} canAct />);
  const rows = html.split("data-set-aside-table=").slice(1);
  const byName = (name: string) => text(rows.find((r) => r.startsWith(`"${name}"`)) ?? "");
  expect(byName("customers")).toContain("Move back");
  expect(byName("customers")).not.toContain("Move back as…");
  expect(byName("orders")).toContain("Move back as…");
  expect(byName("order_items")).toContain("Move back as…");
  expect(text(html)).toContain("Delete…");
  expect(text(html)).toContain("Delete all…");
});

test("viewers see the card without any action", () => {
  const t = text(render(<SetAsideCard db={fixtureDatabase} schemas={schemas} canAct={false} />));
  expect(t).toContain("Tables set aside");
  expect(t).toContain("The database's owner or an admin can move them back or delete them.");
  expect(t).not.toContain("Move back");
  expect(t).not.toContain("Delete");
});

test("nothing is shown when nothing is set aside, and a running job disables the actions", () => {
  expect(render(<SetAsideCard db={fixtureDatabase} schemas={[]} canAct />)).toBe("");
  expect(render(<SetAsideCard db={fixtureDatabase} schemas={[{ ...schemas[0]!, tables: [] }]} canAct />)).toBe("");
  const busy = render(<SetAsideCard db={fixtureDatabase} schemas={schemas} canAct busyReason="Wait for the rollback to finish" />);
  expect(busy).toContain("disabled");
});

test("the new name is checked before it is sent", () => {
  expect(tableNameError("", "orders")).toBe("Enter a name for the table.");
  expect(tableNameError("orders", "orders")).toBe("orders is in use in the database. Choose another name.");
  expect(tableNameError("ORDERS", "orders")).toContain("in use");
  expect(tableNameError("orders 2", "orders")).toBe("Use letters, numbers, _ and $ only.");
  expect(tableNameError("123", "orders")).toBe("A table name cannot be only digits.");
  expect(tableNameError("x".repeat(65), "orders")).toBe("Table names can be at most 64 characters.");
  expect(tableNameError("orders_set_aside", "orders")).toBeNull();
  expect(suggestedName("orders")).toBe("orders_set_aside");
  expect(suggestedName("t".repeat(60)).length).toBe(64);
  const t = text(render(<MoveBackAsFields table="orders" value="orders" onChange={() => undefined} error="orders is in use in the database. Choose another name." />));
  expect(t).toContain("orders is in use in the database, so this one needs another name.");
  expect(t).toContain("Choose another name.");
  expect(deleteSummary(schemas[1]!)).toBe("customers (7 rows), order_items (1,204 rows)");
});

async function capture(run: () => Promise<unknown>, response: unknown, status = 200): Promise<{ url: string; init: RequestInit }> {
  const original = globalThis.fetch;
  let seen: { url: string; init: RequestInit } | null = null;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    seen = { url: String(input), init: init ?? {} };
    if (status === 204) return new Response(null, { status });
    return new Response(JSON.stringify(response), { status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  try {
    await run().catch(() => undefined);
  } finally {
    globalThis.fetch = original;
  }
  if (!seen) throw new Error("no request was sent");
  return seen;
}

test("requests follow the contract: list, move back as JSON, delete", async () => {
  const listed = await capture(() => fetchSetAside("db 1"), { schemas });
  expect(listed.url).toBe("/api/databases/db%201/set-aside");
  const moved = await capture(() => moveBackSetAside("db1", "_ld_kept_x", { table: "orders", as: "orders_old" }), {
    table: "orders",
    movedTo: "orders_old",
    schemaRemoved: true,
  });
  expect(moved.url).toBe("/api/databases/db1/set-aside/_ld_kept_x/move-back");
  expect(moved.init.method).toBe("POST");
  expect(new Headers(moved.init.headers).get("Content-Type")).toBe("application/json");
  expect(JSON.parse(String(moved.init.body))).toEqual({ table: "orders", as: "orders_old" });
  const removed = await capture(() => deleteSetAside("db1", "_ld_kept_x"), null, 204);
  expect(removed.init.method).toBe("DELETE");
  expect(removed.url).toBe("/api/databases/db1/set-aside/_ld_kept_x");
  expect(setAsideKey("db1")[0]).toBe("checkpoints");

  const original = globalThis.fetch;
  for (const status of [403, 404]) {
    globalThis.fetch = (async () => new Response(JSON.stringify({ error: "no" }), { status, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
    try {
      expect(await fetchSetAside("db1")).toEqual([]);
    } finally {
      globalThis.fetch = original;
    }
  }
});
