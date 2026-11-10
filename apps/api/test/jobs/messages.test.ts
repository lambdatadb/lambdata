import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Job, JobKind } from "@lambdata/shared";
import { seedUser, useTempMetadata, type TempMetadata } from "../harness/sqlite";
import { databases } from "../../src/db/queries";
import { JobConflictError, jobConflictMessage, runExclusive, sanitizeErrorMessage, startJob, waitForJob } from "../../src/jobs";
import { newId } from "../../src/util/id";

let md: TempMetadata;

beforeAll(() => {
  md = useTempMetadata();
});

afterAll(() => md?.cleanup());

function insertDatabase(displayName: string): string {
  const owner = seedUser("db_owner");
  const id = newId("db");
  databases.insert({
    id,
    name: id,
    displayName,
    ownerUserId: owner.id,
    kind: "standard",
    mysqlUser: `ld_${id.slice(-8)}`,
    mysqlPasswordEnc: "enc",
    connectionsFrom: "%",
    tailscaleExposed: false,
    lanExposed: true,
  });
  return id;
}

function conflictOf(fn: () => unknown): JobConflictError {
  try {
    fn();
  } catch (err) {
    if (err instanceof JobConflictError) return err;
    throw err;
  }
  throw new Error("expected a JobConflictError");
}

describe("job conflict messages", () => {
  test("name the operation and the database in plain words, never the raw job kind", () => {
    const id = insertDatabase("Shop");
    const expected: Record<JobKind, { running: string; queued: string }> = {
      "checkpoint.create": {
        running: 'A checkpoint of "Shop" is being created right now. Try again when it has finished.',
        queued: 'A checkpoint of "Shop" is waiting to start. Try again when it has finished.',
      },
      "checkpoint.restore": {
        running: '"Shop" is being rolled back to a checkpoint right now. Try again when it has finished.',
        queued: 'A rollback of "Shop" is waiting to start. Try again when it has finished.',
      },
      "sync.run": {
        running: '"Shop" is syncing from its source right now. Try again when it has finished.',
        queued: 'A sync of "Shop" is waiting to start. Try again when it has finished.',
      },
      "import.sqlite": {
        running: 'A SQLite file is being imported into "Shop" right now. Try again when it has finished.',
        queued: 'An import into "Shop" is waiting to start. Try again when it has finished.',
      },
      "import.sql": {
        running: 'A SQL dump is being imported into "Shop" right now. Try again when it has finished.',
        queued: 'An import into "Shop" is waiting to start. Try again when it has finished.',
      },
    };
    for (const [kind, text] of Object.entries(expected) as [JobKind, { running: string; queued: string }][]) {
      expect(jobConflictMessage(id, { kind, status: "running" })).toBe(text.running);
      expect(jobConflictMessage(id, { kind, status: "queued" })).toBe(text.queued);
      expect(text.running).not.toContain(kind);
    }
    expect(jobConflictMessage("db_unknown", { kind: "sync.run", status: "running" })).toBe(
      "This database is syncing from its source right now. Try again when it has finished.",
    );
    expect(jobConflictMessage(id, { kind: null, status: null })).toBe(
      'Another operation on "Shop" is in progress. Try again when it has finished.',
    );
  });

  test("a real conflict carries the human message and the blocking job's id", async () => {
    const id = insertDatabase("Orders");
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const running = startJob({ kind: "import.sql", databaseId: id, userId: null }, () => gate);
    try {
      const err = conflictOf(() => startJob({ kind: "checkpoint.create", databaseId: id, userId: null }, async () => null));
      expect(err.jobId).toBe(running.id);
      expect(err.message).toMatch(/^(A SQL dump is being imported into "Orders" right now|An import into "Orders" is waiting to start)\. Try again when it has finished\.$/);
      await Bun.sleep(5);
      await expect(runExclusive(id, async () => null)).rejects.toThrow(
        'A SQL dump is being imported into "Orders" right now. Try again when it has finished.',
      );
    } finally {
      release();
      await waitForJob(running.id);
    }
  });
});

describe("error text shown when a SQL dump fails to load", () => {
  const user = "'the import account'@'localhost'";
  const tail = "The dump tried to reach something outside its own database (line 3); dumps are loaded with access to the new database only.";
  const clean = `mariadb failed (exit 1): ERROR 1045 (28000) at line 3: Access denied for user ${user}. ${tail}`;

  test("drops MariaDB's password-use note instead of mangling the sentence after it", () => {
    for (const note of ["(using password: ***", "(using password: YES)", "(using password: NO)", "(using password: ***)"]) {
      const raw = `mariadb failed (exit 1): ERROR 1045 (28000) at line 3: Access denied for user ${user} ${note}. ${tail}`;
      expect(sanitizeErrorMessage(raw)).toBe(clean);
    }
  });

  test("a failed job keeps that readable text", async () => {
    const job = startJob({ kind: "import.sql", databaseId: null, userId: null }, async () => {
      throw new Error(`mariadb failed (exit 1): ERROR 1045 (28000) at line 3: Access denied for user ${user} (using password: ***. ${tail}`);
    });
    const done = (await waitForJob(job.id)) as Job;
    expect(done.status).toBe("failed");
    expect(done.error).toBe(clean);
  });

  test("real secrets are still redacted", () => {
    expect(sanitizeErrorMessage("connect failed: password: hunter2, token=abc; mysql://u:pw@h")).toBe(
      "connect failed: password: ***, token=***; mysql://u:***@h",
    );
    expect(sanitizeErrorMessage("ALTER USER x IDENTIFIED BY 'p4ss'")).toBe("ALTER USER x IDENTIFIED BY '***'");
    expect(sanitizeErrorMessage("(using password: hunter2)")).not.toContain("hunter2");
  });
});
