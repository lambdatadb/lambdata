import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Job } from "@lambdata/shared";
import { authHeaders, seedUser, useTempMetadata, type SeededUser, type TempMetadata } from "../harness/sqlite";
import { buildApp } from "../../src/server";
import { env } from "../../src/env";
import { databases, jobs as jobStore } from "../../src/db/queries";
import {
  INTERRUPTED_MESSAGE,
  JobConflictError,
  getJob,
  isDatabaseBusy,
  recoverInterruptedJobs,
  runExclusive,
  startJob,
  waitForJob,
} from "../../src/jobs";
import { newId } from "../../src/util/id";

let md: TempMetadata;

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function insertDatabase(id: string, ownerUserId: string): void {
  databases.insert({
    id,
    name: id,
    displayName: id,
    ownerUserId,
    kind: "standard",
    mysqlUser: `ld_${id}`,
    mysqlPasswordEnc: "enc",
    connectionsFrom: "%",
    tailscaleExposed: false,
    lanExposed: true,
  });
}

async function finished(job: Job): Promise<Job> {
  const done = await waitForJob(job.id);
  if (!done) throw new Error("job vanished");
  return done;
}

beforeAll(() => {
  md = useTempMetadata();
});

afterAll(() => md?.cleanup());

describe("startJob", () => {
  test("returns immediately and runs the work detached", async () => {
    const gate = deferred();
    const job = startJob({ kind: "sync.run", databaseId: "db_a", userId: null }, async (ctx) => {
      ctx.stage("working");
      await gate.promise;
      return { rows: 3, big: 2n ** 63n };
    });
    expect(["queued", "running"]).toContain(job.status);
    expect(jobStore.byId(job.id)?.status).toBeDefined();
    gate.resolve();
    const done = await finished(job);
    expect(done.status).toBe("succeeded");
    expect(done.result).toEqual({ rows: 3, big: "9223372036854775808" });
    expect(done.stage).toBe("working");
    expect(jobStore.byId(job.id)).toMatchObject({ status: "succeeded", stage: "working" });
    expect(done.startedAt).not.toBeNull();
    expect(done.finishedAt).not.toBeNull();
  });

  test("a throwing job fails with a sanitised message", async () => {
    const job = startJob({ kind: "sync.run", databaseId: null, userId: null }, async () => {
      const err = new Error("connect failed for mysql://reader:hunter2@10.0.0.5 password=hunter2\n    at foo (/src/x.ts:1:2)");
      throw err;
    });
    const done = await finished(job);
    expect(done.status).toBe("failed");
    expect(done.error).not.toContain("hunter2");
    expect(done.error).not.toContain("/src/x.ts");
    expect(done.error).toContain("connect failed");
    expect(jobStore.byId(job.id)?.error).toBe(done.error);
  });

  test("warnings are collected", async () => {
    const job = startJob({ kind: "import.sql", databaseId: null, userId: null }, async (ctx) => {
      ctx.warn("first");
      ctx.warn("token=abc second");
      return null;
    });
    const done = await finished(job);
    expect(done.warnings).toEqual(["first", "token=*** second"]);
    expect(jobStore.byId(job.id)?.warnings).toEqual(done.warnings);
  });
});

describe("exclusivity", () => {
  test("a second exclusive job for the same database conflicts", async () => {
    const gate = deferred();
    const first = startJob({ kind: "checkpoint.create", databaseId: "db_x", userId: null }, () => gate.promise);
    let conflict: unknown = null;
    try {
      startJob({ kind: "checkpoint.restore", databaseId: "db_x", userId: null }, async () => null);
    } catch (err) {
      conflict = err;
    }
    expect(conflict).toBeInstanceOf(JobConflictError);
    expect((conflict as JobConflictError).jobId).toBe(first.id);
    const other = startJob({ kind: "checkpoint.create", databaseId: "db_y", userId: null }, async () => null);
    const shared = startJob(
      { kind: "checkpoint.create", databaseId: "db_x", userId: null, exclusive: false },
      async () => null,
    );
    expect((await finished(other)).status).toBe("succeeded");
    expect((await finished(shared)).status).toBe("succeeded");
    expect(isDatabaseBusy("db_x")).toBe(true);
    gate.resolve();
    await finished(first);
    expect(isDatabaseBusy("db_x")).toBe(false);
    const again = startJob({ kind: "checkpoint.restore", databaseId: "db_x", userId: null }, async () => null);
    expect((await finished(again)).status).toBe("succeeded");
  });

  test("runExclusive refuses while a job is active and nests inside one", async () => {
    const gate = deferred();
    let nested = "";
    const job = startJob({ kind: "sync.run", databaseId: "db_r", userId: null }, async () => {
      nested = await runExclusive("db_r", async () => "ran inside");
      await gate.promise;
      return null;
    });
    await Bun.sleep(5);
    await expect(runExclusive("db_r", async () => "outside")).rejects.toBeInstanceOf(JobConflictError);
    gate.resolve();
    await finished(job);
    expect(nested).toBe("ran inside");
    expect(await runExclusive("db_r", async () => "free")).toBe("free");
  });

  test("a job started during runExclusive waits until it ends", async () => {
    const gate = deferred();
    let jobRanAt = 0;
    let opEndedAt = 0;
    const op = runExclusive("db_q", async () => {
      await gate.promise;
      opEndedAt = performance.now();
    });
    await Bun.sleep(5);
    expect(isDatabaseBusy("db_q")).toBe(true);
    const job = startJob({ kind: "checkpoint.create", databaseId: "db_q", userId: null }, async () => {
      jobRanAt = performance.now();
      return null;
    });
    await Bun.sleep(20);
    expect(getJob(job.id)?.status).toBe("queued");
    gate.resolve();
    await op;
    await finished(job);
    expect(jobRanAt).toBeGreaterThanOrEqual(opEndedAt);
  });

  test("a job does not inherit the lock of the code that started it", async () => {
    const gate = deferred();
    let innerAt = 0;
    let releasedAt = 0;
    let job: Job | null = null;
    const op = runExclusive("db_p", async () => {
      job = startJob({ kind: "sync.run", databaseId: "db_o", userId: null }, async () => {
        await runExclusive("db_p", async () => {
          innerAt = performance.now();
        });
        return null;
      });
      await gate.promise;
      releasedAt = performance.now();
    });
    await Bun.sleep(20);
    expect(innerAt).toBe(0);
    gate.resolve();
    await op;
    await finished(job!);
    expect(innerAt).toBeGreaterThanOrEqual(releasedAt);
  });

  test("runExclusive calls for one database run one at a time", async () => {
    const order: string[] = [];
    const a = runExclusive("db_s", async () => {
      order.push("a-start");
      await Bun.sleep(20);
      order.push("a-end");
    });
    const b = runExclusive("db_s", async () => {
      order.push("b-start");
      order.push("b-end");
    });
    await Promise.all([a, b]);
    expect(order).toEqual(["a-start", "a-end", "b-start", "b-end"]);
  });
});

describe("persistence", () => {
  test("progress is persisted at most about twice a second", async () => {
    const original = jobStore.save;
    let saves = 0;
    jobStore.save = (job: Job) => {
      saves++;
      original.call(jobStore, job);
    };
    const gate = deferred();
    const job = startJob({ kind: "import.sqlite", databaseId: null, userId: null }, async (ctx) => {
      await Bun.sleep(10);
      const before = saves;
      for (let i = 1; i <= 200; i++) ctx.progress(i / 200);
      const burst = saves - before;
      await Bun.sleep(700);
      const settled = saves - before;
      gate.resolve();
      return { burst, settled };
    });
    try {
      await gate.promise;
      const done = await finished(job);
      const { burst, settled } = done.result as { burst: number; settled: number };
      expect(burst).toBeLessThanOrEqual(1);
      expect(settled).toBeLessThanOrEqual(2);
      expect(done.progress).toBe(1);
      expect(jobStore.byId(job.id)?.progress).toBe(1);
    } finally {
      jobStore.save = original;
    }
  });

  test("restart recovery fails interrupted jobs and prunes old ones", () => {
    const now = Date.now();
    const base = {
      kind: "sync.run" as const,
      databaseId: "db_old",
      stage: null,
      progress: null,
      error: null,
      warnings: [],
      result: null,
      createdByUserId: null,
      startedAt: null,
      exclusive: true,
    };
    const id = { running: newId("job"), queued: newId("job"), ancient: newId("job"), recent: newId("job") };
    jobStore.insert({ ...base, id: id.running, status: "running", createdAt: now - 1000, finishedAt: null });
    jobStore.insert({ ...base, id: id.queued, status: "queued", createdAt: now - 1000, finishedAt: null });
    jobStore.insert({
      ...base,
      id: id.ancient,
      status: "succeeded",
      createdAt: now - 40 * 86_400_000,
      finishedAt: now - 40 * 86_400_000,
    });
    jobStore.insert({ ...base, id: id.recent, status: "failed", createdAt: now - 1000, finishedAt: now - 500 });
    const report = recoverInterruptedJobs(now);
    expect(report.failed).toBeGreaterThanOrEqual(2);
    expect(report.pruned).toBeGreaterThanOrEqual(1);
    for (const jobId of [id.running, id.queued]) {
      expect(jobStore.byId(jobId)).toMatchObject({ status: "failed", error: INTERRUPTED_MESSAGE, finishedAt: now });
    }
    expect(jobStore.byId(id.ancient)).toBeNull();
    expect(jobStore.byId(id.recent)?.status).toBe("failed");
  });

  test("the concurrency cap queues jobs beyond it", async () => {
    const previous = env.maxConcurrentJobs;
    env.maxConcurrentJobs = 1;
    try {
      const gate = deferred();
      const a = startJob({ kind: "sync.run", databaseId: null, userId: null }, () => gate.promise);
      const b = startJob({ kind: "sync.run", databaseId: null, userId: null }, async () => null);
      await Bun.sleep(20);
      expect(getJob(a.id)?.status).toBe("running");
      expect(getJob(b.id)?.status).toBe("queued");
      gate.resolve();
      expect((await finished(b)).status).toBe("succeeded");
    } finally {
      env.maxConcurrentJobs = previous;
    }
  });
});

describe("routes", () => {
  let app: ReturnType<typeof buildApp>;

  beforeAll(() => {
    app = buildApp();
  });

  interface Scenario {
    admin: SeededUser;
    owner: SeededUser;
    viewer: SeededUser;
    mine: string;
    theirs: string;
    ids: { mine: string; theirs: string; system: string; gone: string };
  }

  async function scenario(): Promise<Scenario> {
    const tag = newId().slice(0, 10);
    const admin = seedUser("admin");
    const owner = seedUser("db_owner");
    const otherOwner = seedUser("db_owner");
    const viewer = seedUser("viewer");
    const mine = `db_mine_${tag}`;
    const theirs = `db_theirs_${tag}`;
    insertDatabase(mine, owner.id);
    insertDatabase(theirs, otherOwner.id);
    const ids = { mine: "", theirs: "", system: "", gone: "" };
    for (const [key, databaseId] of [
      ["mine", mine],
      ["theirs", theirs],
      ["system", null],
      ["gone", `db_deleted_${tag}`],
    ] as const) {
      const job = startJob({ kind: "sync.run", databaseId, userId: key === "gone" ? owner.id : null }, async () => null);
      await finished(job);
      ids[key] = job.id;
    }
    return { admin, owner, viewer, mine, theirs, ids };
  }

  async function get(user: SeededUser, path: string): Promise<Response> {
    return app.request(path, { headers: await authHeaders(user) });
  }

  async function listIds(user: SeededUser, query = ""): Promise<string[]> {
    const res = await get(user, `/api/jobs${query}`);
    expect(res.status).toBe(200);
    return ((await res.json()).jobs as Job[]).map((j) => j.id);
  }

  test("admins see everything", async () => {
    const { admin, ids } = await scenario();
    const seen = await listIds(admin, "?limit=200");
    for (const id of Object.values(ids)) expect(seen).toContain(id);
    expect((await get(admin, `/api/jobs/${ids.system}`)).status).toBe(200);
  });

  test("a db_owner sees only jobs for databases they own", async () => {
    const { owner, mine, theirs, ids } = await scenario();
    const seen = await listIds(owner, "?limit=200");
    expect(seen).toContain(ids.mine);
    expect(seen).not.toContain(ids.theirs);
    expect(seen).not.toContain(ids.system);
    expect((await get(owner, `/api/jobs/${ids.theirs}`)).status).toBe(404);
    expect((await get(owner, `/api/jobs/${ids.system}`)).status).toBe(404);
    expect((await get(owner, `/api/jobs?databaseId=${theirs}`)).status).toBe(404);
    expect(await listIds(owner, `?databaseId=${mine}`)).toEqual([ids.mine]);
    expect((await get(owner, `/api/jobs/${ids.gone}`)).status).toBe(200);
  });

  test("viewers see database jobs but not system jobs", async () => {
    const { viewer, ids } = await scenario();
    const seen = await listIds(viewer, "?limit=200");
    expect(seen).toContain(ids.mine);
    expect(seen).toContain(ids.theirs);
    expect(seen).not.toContain(ids.system);
    expect((await get(viewer, `/api/jobs/${ids.system}`)).status).toBe(404);
    expect((await get(viewer, `/api/jobs/${ids.theirs}`)).status).toBe(200);
  });

  test("active and limit filters apply", async () => {
    const { admin, mine } = await scenario();
    const gate = deferred();
    const running = startJob({ kind: "sync.run", databaseId: mine, userId: null }, () => gate.promise);
    try {
      expect(await listIds(admin, `?active=1&databaseId=${mine}`)).toEqual([running.id]);
      expect(await listIds(admin, "?active=1")).toContain(running.id);
      expect((await listIds(admin, `?databaseId=${mine}`)).length).toBe(2);
      expect((await listIds(admin, "?limit=1")).length).toBe(1);
      expect((await get(admin, "/api/jobs?limit=0")).status).toBe(400);
    } finally {
      gate.resolve();
      await finished(running);
    }
  });

  test("deleting a database with an active job answers 409 with the job id", async () => {
    const { admin, mine } = await scenario();
    const gate = deferred();
    const running = startJob({ kind: "checkpoint.create", databaseId: mine, userId: null }, () => gate.promise);
    try {
      const res = await app.request(`/api/databases/${mine}`, {
        method: "DELETE",
        headers: await authHeaders(admin),
      });
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({
        error: `A checkpoint of "${mine}" is being created right now. Try again when it has finished.`,
        jobId: running.id,
      });
      expect(databases.byId(mine)).not.toBeNull();
    } finally {
      gate.resolve();
      await finished(running);
    }
  });
});
