import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StaticRouter } from "react-router-dom/server";
import type { Checkpoint, Job } from "@lambdata/shared";
import { JobProgress } from "../jobs/JobProgress";
import { CodeFailureList } from "../jobs/CodeFailureList";
import { OperationPanel, refusedTarget } from "./OperationPanel";
import { UnconvertedSnapshots } from "./UnconvertedSnapshots";
import { CheckpointRow } from "./CheckpointRow";
import { layoutGraph } from "./graph";
import { createCheckpointBody } from "./CreateCheckpointDialog";
import { startRollback } from "./queries";
import { restatesCodeFailures, visibleWarnings } from "../../lib/jobOutcome";
import { pickRecentProblem } from "./useHistoryJobs";
import { validateDataDirPath } from "../settings/DataDirPicker";
import { unconvertedDetail } from "../layout/Sidebar";
import { importOutcome, importSuccessText } from "../import/result";
import { auditOutcome } from "../../pages/Activity";
import {
  doneWithErrorsImport,
  doneWithErrorsRestore,
  doneWithErrorsSync,
  failedRestore,
  fixtureCheckpoints,
  fixtureDatabase,
  fixtureFailures,
  fixtureLimited,
  fixtureTarget,
  fixtureUnconverted,
  limitedCreate,
  refusedRestore,
  succeededRestore,
} from "../../pages/dev/jobFixtures";

declare const test: (name: string, fn: () => void | Promise<void>) => void;
declare const expect: (value: unknown) => {
  toBe(expected: unknown): void;
  toEqual(expected: unknown): void;
  toContain(expected: unknown): void;
  toBeNull(): void;
  not: { toContain(expected: unknown): void; toBeNull(): void };
};

function render(node: ReactElement): string {
  const client = new QueryClient();
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <StaticRouter location="/">{node}</StaticRouter>
    </QueryClientProvider>,
  );
}

function text(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

const byId = new Map<string, Checkpoint>(fixtureCheckpoints.map((cp) => [cp.id, cp]));
const meta = { targetId: fixtureTarget.id, targetShort: fixtureTarget.shortHash, previousBaseShort: "c90b5d4" };

test("finished with errors is amber, says the tables are in place and lists every object with its error", () => {
  const html = render(<JobProgress job={doneWithErrorsRestore} title="Rolled back" />);
  const t = text(html);
  expect(html).toContain('data-job-state="done-with-errors"');
  expect(html).toContain("border-warn/40");
  expect(html).not.toContain("text-danger");
  expect(t).toContain("Finished with errors");
  expect(t).toContain("1 view and 1 trigger could not be created.");
  expect(t).toContain("The tables are in place; only these objects are missing.");
  for (const f of doneWithErrorsRestore.result!.codeFailures as { name: string; error: string }[]) {
    expect(t).toContain(f.name);
    expect(t).toContain(f.error);
  }
  expect(t).toContain("1 warning");
  expect(t).toContain("view sales_summary is kept as recorded but cannot be queried");
  expect(t).not.toContain("Rolled back anyway:");
  expect(t).not.toContain("could not re-create view monthly_revenue");
});

test("a refusal says nothing was changed, is not drawn as a red crash, and lists the objects", () => {
  const html = render(<JobProgress job={refusedRestore} />);
  const t = text(html);
  expect(html).toContain('data-job-state="refused"');
  expect(html).not.toContain("border-danger");
  expect(html).not.toContain('role="alert"');
  expect(t).toContain("Refused · nothing was changed");
  expect(t).toContain("Nothing was changed.");
  expect(t).toContain("1 view, 1 trigger and 1 procedure of this checkpoint cannot be re-created here");
  for (const f of fixtureFailures) expect(t).toContain(f.name);
  expect(t).toContain("Show the full message");
});

test("other failures keep their whole message, split into a readable list", () => {
  const html = render(<JobProgress job={failedRestore} />);
  const t = text(html);
  expect(html).toContain('role="alert"');
  expect(html).toContain("overflow-y-auto");
  expect(t).toContain("table orders: 24 rows recorded, 23 loaded");
  expect(t).toContain("table customers: column joined_on is DATE in the checkpoint but DATETIME after loading");
  expect(t).toContain("and 2 more");
});

test("the compact variant names the third state too", () => {
  expect(text(render(<JobProgress job={doneWithErrorsRestore} variant="compact" />))).toContain("with errors");
  expect(text(render(<JobProgress job={refusedRestore} variant="compact" />))).toContain("refused");
  expect(text(render(<JobProgress job={refusedRestore} variant="compact" />))).toContain("Nothing was changed");
  expect(text(render(<JobProgress job={failedRestore} variant="compact" />))).toContain("failed");
});

test("a code refusal in History offers Roll back anyway; other failures do not", () => {
  const refused = text(
    render(<OperationPanel job={refusedRestore} meta={meta} byId={byId} db={fixtureDatabase} canRestore onForced={() => undefined} onDismiss={() => undefined} />),
  );
  expect(refused).toContain("Rollback to a41f9c2 refused");
  expect(refused).toContain("Roll back anyway");
  expect(refused).toContain("The current state is saved in a safety checkpoint first");
  expect(refused).toContain("Brings the tables back and leaves out the objects above.");
  expect(refused).not.toContain("Restores");

  const failed = text(
    render(<OperationPanel job={failedRestore} meta={meta} byId={byId} db={fixtureDatabase} canRestore onForced={() => undefined} onDismiss={() => undefined} />),
  );
  expect(failed).toContain("Rollback to a41f9c2 failed");
  expect(failed).not.toContain("Roll back anyway");

  const viewer = text(render(<OperationPanel job={refusedRestore} meta={meta} byId={byId} db={fixtureDatabase} canRestore={false} onDismiss={() => undefined} />));
  expect(viewer).not.toContain("Roll back anyway");
});

test("the refused target is found from the tracked rollback or from the message", () => {
  expect(refusedTarget(refusedRestore, meta, byId)?.id).toBe(fixtureTarget.id);
  expect(refusedTarget(refusedRestore, null, byId)?.id).toBe(fixtureTarget.id);
  expect(refusedTarget({ ...refusedRestore, error: "x", stage: null }, null, byId)).toBeNull();
  const withId: Job = { ...refusedRestore, error: "x", stage: null, errorDetails: { checkpointId: fixtureTarget.id, codeFailures: fixtureFailures } };
  expect(refusedTarget(withId, null, byId)?.id).toBe(fixtureTarget.id);
  const reloaded = text(render(<OperationPanel job={withId} meta={null} byId={byId} db={fixtureDatabase} canRestore onForced={() => undefined} onDismiss={() => undefined} />));
  expect(reloaded).toContain("Rollback to a41f9c2 refused");
  expect(reloaded).toContain("Roll back anyway");
});

test("finished with errors reads as such in the panel titles of every job kind", () => {
  expect(text(render(<OperationPanel job={doneWithErrorsRestore} meta={meta} byId={byId} onDismiss={() => undefined} />))).toContain(
    "Rolled back to a41f9c2 with errors",
  );
  const sync = text(render(<OperationPanel job={doneWithErrorsSync} meta={null} byId={byId} onDismiss={() => undefined} />));
  expect(sync).toContain("Mirror sync finished with errors");
  expect(sync).toContain("The tables were synced and are in place");
  const created = text(render(<OperationPanel job={limitedCreate} meta={null} byId={byId} onDismiss={() => undefined} />));
  expect(created).toContain("Checkpoint c90b5d4 recorded with limitations");
  expect(created).toContain("Verified");
  expect(created).toContain("Recorded with 2 limitations");
  const restored = text(render(<OperationPanel job={succeededRestore} meta={meta} byId={byId} onDismiss={() => undefined} />));
  expect(restored).toContain("Rolled back to a41f9c2");
  expect(restored).not.toContain("with errors");
});

test("a warning that only restates the object list is hidden; every other warning stays", () => {
  const sync = text(render(<JobProgress job={doneWithErrorsSync} />));
  expect(sync).not.toContain("could not re-create view monthly_revenue");
  expect(sync).not.toContain("warning");
  const imported = text(render(<JobProgress job={doneWithErrorsImport} />));
  expect(imported).not.toContain("The data was replaced, but");
  expect(imported).toContain("1 warning");
  expect(imported).toContain("from the previous contents were removed with the old tables");
  const failures = fixtureFailures.slice(0, 1);
  expect(restatesCodeFailures("could not re-create view monthly_revenue: boom", failures)).toBe(true);
  expect(restatesCodeFailures("could not re-create view other_view: boom", failures)).toBe(false);
  expect(restatesCodeFailures("Rolled back anyway: the tables of a41f9c2 are back, but 1 view(s)", [])).toBe(false);
  expect(restatesCodeFailures("The data was imported, but 2 view(s), trigger(s), routine(s) or event(s) from the file", failures)).toBe(true);
  expect(visibleWarnings({ ...doneWithErrorsRestore, warnings: ["2 connection(s) were closed"] })).toEqual(["2 connection(s) were closed"]);
});

test("an import that finished with errors keeps its tables and says so", () => {
  const outcome = importOutcome(doneWithErrorsImport);
  expect(outcome?.withErrors).toBe(true);
  expect(outcome?.codeFailures.length).toBe(1);
  const sentence = importSuccessText(outcome, "replace");
  expect(sentence).toContain("The tables are in place");
  const html = render(<JobProgress job={doneWithErrorsImport} successMessage={sentence} />);
  expect(text(html)).toContain("orders_before_insert");
});

test("unconverted snapshots are shown apart, with the reason, the retry and no rollback", () => {
  const t = text(render(<UnconvertedSnapshots items={fixtureUnconverted} />));
  expect(t).toContain("Old snapshots that could not be converted");
  expect(t).toContain("tries again every time it starts");
  expect(t).toContain("left untouched");
  expect(t).toContain("cannot be rolled back to from the console");
  expect(t).toContain("gzip stream truncated");
  expect(t).toContain("Tried 3 times");
  expect(t).toContain("Tried once");
  expect(t).not.toContain("Roll back to");
  expect(render(<UnconvertedSnapshots items={[]} />)).toBe("");
});

test("history rows carry the verified and limitations markers", () => {
  const layout = layoutGraph(fixtureCheckpoints.map((cp) => ({ id: cp.id, parentId: cp.parentId })));
  const row = (cp: Checkpoint) =>
    render(
      <ol>
        <CheckpointRow
          cp={cp}
          row={layout.rows.find((r) => r.id === cp.id)!}
          laneWidth={16}
          graphWidth={40}
          selected={false}
          restoring={false}
          permissions={{ canWrite: true, canRestore: true }}
          busyReason={null}
          workingState="clean"
          workingTone="clean"
          actions={{ open: () => undefined, restore: () => undefined, togglePin: () => undefined, edit: () => undefined, remove: () => undefined }}
        />
      </ol>,
    );
  const limited = row(fixtureLimited);
  expect(limited).toContain('aria-label="Captured with 2 limitations"');
  expect(limited).not.toContain('aria-label="Verified');
  const verified = row(fixtureTarget);
  expect(verified).toContain('aria-label="Verified');
  expect(verified).not.toContain("limitations");
});

test("recent problems include finished-with-errors and refusals until a clean run of the same kind", () => {
  const now = Date.now();
  const at = (job: Job, minutesAgo: number): Job => ({ ...job, finishedAt: now - minutesAgo * 60_000, createdAt: now - minutesAgo * 60_000 - 1 });
  expect(pickRecentProblem([at(refusedRestore, 5)], now)?.id).toBe(refusedRestore.id);
  expect(pickRecentProblem([at(refusedRestore, 9), at(doneWithErrorsRestore, 3)], now)?.id).toBe(doneWithErrorsRestore.id);
  expect(pickRecentProblem([at(doneWithErrorsRestore, 9), at(succeededRestore, 2)], now)).toBeNull();
  expect(pickRecentProblem([at(succeededRestore, 9), at(doneWithErrorsSync, 2)], now)?.id).toBe(doneWithErrorsSync.id);
  expect(pickRecentProblem([at(refusedRestore, 60 * 25)], now)).toBeNull();
});

async function capture(run: () => Promise<unknown>, response: unknown, status = 200): Promise<{ url: string; init: RequestInit }> {
  const original = globalThis.fetch;
  let seen: { url: string; init: RequestInit } | null = null;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    seen = { url: String(input), init: init ?? {} };
    return new Response(JSON.stringify(response), { status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  try {
    await run();
  } finally {
    globalThis.fetch = original;
  }
  if (!seen) throw new Error("no request was sent");
  return seen;
}

test("forcing a rollback posts allowCodeFailures as JSON", async () => {
  const forced = await capture(() => startRollback("db 1", "cp/2", { allowCodeFailures: true }), { job: succeededRestore }, 202);
  expect(forced.url).toBe("/api/databases/db%201/checkpoints/cp%2F2/restore");
  expect(forced.init.method).toBe("POST");
  expect(new Headers(forced.init.headers).get("Content-Type")).toBe("application/json");
  expect(forced.init.body).toBe('{"allowCodeFailures":true}');

  const plain = await capture(() => startRollback("db1", "cp2"), { job: succeededRestore }, 202);
  expect(plain.init.method).toBe("POST");
  expect(new Headers(plain.init.headers).get("Content-Type")).toBe("application/json");
  expect(plain.init.body).toBe(undefined);
});

test("the create dialog sends verify only when it is ticked", () => {
  expect(createCheckpointBody("  Nightly  ", false)).toEqual({ message: "Nightly" });
  expect(createCheckpointBody("", true)).toEqual({ message: undefined, verify: true });
});

test("the setup wizard's folder check sends the setup token", async () => {
  const ok = { ok: true, error: null, resolvedPath: "/srv/lambdata", exists: false, writable: true, freeBytes: 1, isEmpty: null };
  const withToken = await capture(() => validateDataDirPath("/srv/lambdata", { setupToken: " ABCD-EFGH " }), ok);
  expect(withToken.url).toBe("/api/system/validate-path");
  expect(withToken.init.method).toBe("POST");
  expect(new Headers(withToken.init.headers).get("Content-Type")).toBe("application/json");
  expect(JSON.parse(String(withToken.init.body))).toEqual({ path: "/srv/lambdata", setupToken: "ABCD-EFGH" });
  const without = await capture(() => validateDataDirPath("/srv/lambdata"), ok);
  expect(JSON.parse(String(without.init.body))).toEqual({ path: "/srv/lambdata" });
});

test("the health line and the activity log name the new states", () => {
  expect(unconvertedDetail(1, null)).toContain("1 old snapshot could not be converted into a checkpoint.");
  expect(unconvertedDetail(3, "file missing")).toContain("Last error: file missing");
  expect(auditOutcome('{"outcome":"done-with-errors","forced":true}')).toEqual({ withErrors: true, forced: true });
  expect(auditOutcome('{"outcome":"done"}')).toEqual({ withErrors: false, forced: false });
  expect(auditOutcome("not json")).toEqual({ withErrors: false, forced: false });
});

test("a code failure list renders nothing when empty", () => {
  expect(render(<CodeFailureList failures={[]} />)).toBe("");
});
