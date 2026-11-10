import { cn } from "./cn";

declare const test: (name: string, fn: () => void) => void;
declare const expect: (value: unknown) => { toBe(expected: unknown): void };

test("custom font sizes survive next to text colours", () => {
  expect(cn("text-label", "text-text-muted")).toBe("text-label text-text-muted");
  expect(cn("text-micro font-medium", "text-accent")).toBe("text-micro font-medium text-accent");
  expect(cn("text-body text-text", "text-heading")).toBe("text-text text-heading");
});

test("later padding wins", () => {
  expect(cn("rounded-lg relative p-5", "p-0 overflow-hidden")).toBe("rounded-lg relative p-0 overflow-hidden");
  expect(cn("px-4 py-2.5", "px-0")).toBe("py-2.5 px-0");
});

test("text colours still conflict with each other", () => {
  expect(cn("text-text-muted", "text-danger")).toBe("text-danger");
});

test("custom shadows merge", () => {
  expect(cn("shadow-raised", "shadow-overlay")).toBe("shadow-overlay");
});

test("falsy and conditional inputs are dropped", () => {
  expect(cn("a", false, null, undefined, { b: true, c: false })).toBe("a b");
});
