import { friendlyJobConflict, jobBusyText, jobKindLabel, jobKindNoun } from "./jobKinds";

declare const test: (name: string, fn: () => void) => void;
declare const expect: (value: unknown) => { toBe(expected: unknown): void };

test("raw job conflicts read as plain sentences", () => {
  expect(friendlyJobConflict("a import.sqlite job is already running for this database")).toBe(
    "An import is already running for this database.",
  );
  expect(friendlyJobConflict("a checkpoint.create job is already queued for this database")).toBe(
    "A checkpoint is already queued for this database.",
  );
  expect(friendlyJobConflict("a checkpoint.restore job is already running for this database")).toBe(
    "A rollback is already running for this database.",
  );
  expect(friendlyJobConflict("a sync.run job is already running for this database")).toBe("A sync is already running for this database.");
});

test("other messages are left alone", () => {
  expect(friendlyJobConflict("Refusing to save: you are connected via the local network")).toBe(null);
});

test("labels and nouns", () => {
  expect(jobKindLabel("import.sql")).toBe("SQL dump import");
  expect(jobKindNoun("sync.run")).toBe("mirror sync");
  expect(jobKindNoun("import.sqlite")).toBe("SQLite import");
  expect(jobBusyText("checkpoint.create")).toBe("A checkpoint is already being created");
  expect(jobKindLabel("something.new")).toBe("something.new");
});
