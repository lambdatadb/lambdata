import type { Job } from "@lambdata/shared";
import {
  createLimitations,
  createVerified,
  describeFailureKinds,
  isCodeRefusal,
  jobCodeFailures,
  jobState,
  needsAttention,
  readCodeFailures,
  refusedTargetHash,
  splitErrorMessage,
} from "./jobOutcome";
import {
  doneWithErrorsImport,
  doneWithErrorsRestore,
  doneWithErrorsSync,
  failedRestore,
  fixtureFailures,
  limitedCreate,
  refusedRestore,
  runningRestore,
  succeededRestore,
} from "../pages/dev/jobFixtures";

declare const test: (name: string, fn: () => void) => void;
declare const expect: (value: unknown) => {
  toBe(expected: unknown): void;
  toEqual(expected: unknown): void;
  toContain(expected: unknown): void;
  not: { toContain(expected: unknown): void };
};

test("each finished job reads as one of four states", () => {
  expect(jobState(runningRestore)).toBe("running");
  expect(jobState(succeededRestore)).toBe("succeeded");
  expect(jobState(doneWithErrorsRestore)).toBe("done-with-errors");
  expect(jobState(doneWithErrorsSync)).toBe("done-with-errors");
  expect(jobState(doneWithErrorsImport)).toBe("done-with-errors");
  expect(jobState(refusedRestore)).toBe("refused");
  expect(jobState(failedRestore)).toBe("failed");
});

test("a refusal is only the code-object refusal of a failed job", () => {
  expect(isCodeRefusal(refusedRestore)).toBe(true);
  expect(isCodeRefusal(failedRestore)).toBe(false);
  const stale: Job = { ...refusedRestore, status: "succeeded" };
  expect(isCodeRefusal(stale)).toBe(false);
  const noCode: Job = { ...refusedRestore, errorCode: undefined };
  expect(jobState(noCode)).toBe("failed");
});

test("code failures come from the result or the error details", () => {
  expect(jobCodeFailures(refusedRestore)).toEqual(fixtureFailures);
  expect(jobCodeFailures(doneWithErrorsRestore).map((f) => f.name)).toEqual(["monthly_revenue", "orders_before_insert"]);
  expect(jobCodeFailures(succeededRestore)).toEqual([]);
  expect(jobCodeFailures(failedRestore)).toEqual([]);
  expect(readCodeFailures([{ kind: "view", name: "v" }, null, "x", { kind: "view", name: "ok", error: "e" }])).toEqual([
    { kind: "view", name: "ok", error: "e" },
  ]);
  expect(readCodeFailures({ kind: "view" })).toEqual([]);
});

test("an outcome of done-with-errors counts even without a failure list", () => {
  const bare: Job = { ...succeededRestore, result: { restoredCheckpointId: "x", safetyCheckpointId: null, outcome: "done-with-errors" } };
  expect(jobState(bare)).toBe("done-with-errors");
  expect(jobCodeFailures(bare)).toEqual([]);
});

test("limitations and verification of a create job", () => {
  expect(createLimitations(limitedCreate).length).toBe(2);
  expect(createVerified(limitedCreate)).toBe(true);
  expect(createLimitations(succeededRestore)).toEqual([]);
  expect(needsAttention(limitedCreate)).toBe(true);
  expect(needsAttention(succeededRestore)).toBe(false);
  expect(needsAttention(refusedRestore)).toBe(true);
  expect(needsAttention(doneWithErrorsSync)).toBe(true);
});

test("failure kinds are counted in plain words", () => {
  expect(describeFailureKinds(fixtureFailures)).toBe("1 view, 1 trigger and 1 procedure");
  expect(describeFailureKinds([{ kind: "VIEW" }, { kind: "view" }])).toBe("2 views");
  expect(describeFailureKinds([{ kind: "view" }, { kind: "package" }])).toBe("1 view and 1 other object");
  expect(describeFailureKinds([])).toBe("Some views, triggers or routines");
});

test("long refusal messages split into a lead and a list", () => {
  const { lead, items } = splitErrorMessage(failedRestore.error!);
  expect(lead.endsWith("so the live database was left exactly as it was.")).toBe(true);
  expect(items.length).toBe(4);
  expect(items[0]).toBe("table orders: 24 rows recorded, 23 loaded");
  expect(items[3]).toBe("and 2 more");
  expect(splitErrorMessage("Access denied for user 'mirror'.")).toEqual({ lead: "Access denied for user 'mirror'.", items: [] });
  expect(splitErrorMessage("one; two; three")).toEqual({ lead: "one; two; three", items: [] });
});

test("the refused target is read from the message when it is not tracked", () => {
  expect(refusedTargetHash(refusedRestore)).toBe("a41f9c2");
  expect(refusedTargetHash({ ...refusedRestore, error: "boom", stage: null })).toBe(null);
});
