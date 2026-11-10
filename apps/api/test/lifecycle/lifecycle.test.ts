import { afterAll, describe, expect, test } from "bun:test";
import {
  intervalService,
  listServices,
  listStartupTasks,
  placeholderService,
  registerService,
  registerStartupTask,
  runStartupTasks,
  safeTick,
  serviceRunning,
  startServices,
  stopServices,
} from "../../src/lifecycle";

const unhandled: unknown[] = [];
const onUnhandled = (reason: unknown) => {
  unhandled.push(reason);
};
process.on("unhandledRejection", onUnhandled);

afterAll(async () => {
  await stopServices();
  process.off("unhandledRejection", onUnhandled);
});

describe("services", () => {
  test("a throwing or rejecting tick never escapes", async () => {
    let ticks = 0;
    const service = registerService(
      intervalService({
        name: "test.flaky",
        intervalMs: 5,
        runOnStart: true,
        tick() {
          ticks++;
          if (ticks % 2 === 0) throw new Error("sync boom");
          return Promise.reject(new Error("async boom"));
        },
      }),
    );
    await startServices();
    expect(service.running()).toBe(true);
    await Bun.sleep(60);
    await stopServices();
    await Bun.sleep(10);
    expect(ticks).toBeGreaterThan(3);
    expect(unhandled).toEqual([]);
    expect(serviceRunning("test.flaky")).toBe(false);
  });

  test("ticks do not overlap", async () => {
    let active = 0;
    let maxActive = 0;
    const service = intervalService({
      name: "test.slow",
      intervalMs: 2,
      tick: async () => {
        active++;
        maxActive = Math.max(maxActive, active);
        await Bun.sleep(15);
        active--;
      },
    });
    service.start();
    await Bun.sleep(60);
    service.stop();
    await Bun.sleep(20);
    expect(maxActive).toBe(1);
  });

  test("a service that fails to start does not stop the others", async () => {
    registerService({
      name: "test.broken",
      start() {
        throw new Error("cannot start");
      },
      stop() {},
      running: () => false,
    });
    const ok = registerService(placeholderService("test.ok"));
    await startServices();
    expect(ok.running()).toBe(true);
    expect(listServices().find((s) => s.name === "test.ok")?.running).toBe(true);
    await stopServices();
    expect(ok.running()).toBe(false);
  });

  test("safeTick swallows errors", async () => {
    await expect(safeTick("t", () => { throw new Error("x"); })()).resolves.toBeUndefined();
  });
});

describe("startup tasks", () => {
  test("run in registration order and a failure does not stop the rest", async () => {
    const order: string[] = [];
    registerStartupTask("test.first", () => {
      order.push("first");
    });
    registerStartupTask("test.fails", async () => {
      order.push("fails");
      throw new Error("nope");
    });
    registerStartupTask("test.last", async () => {
      order.push("last");
    });
    const names = listStartupTasks();
    expect(names.indexOf("test.first")).toBeLessThan(names.indexOf("test.fails"));
    expect(names.indexOf("test.fails")).toBeLessThan(names.indexOf("test.last"));
    const results = await runStartupTasks();
    expect(order).toEqual(["first", "fails", "last"]);
    expect(results.find((r) => r.name === "test.fails")).toMatchObject({ ok: false, error: "nope" });
    expect(results.find((r) => r.name === "test.last")?.ok).toBe(true);
  });
});

describe("pre-registered seams", () => {
  test("index registers every service and startup task in order", async () => {
    await import("../../src/workers/metrics");
    await import("../../src/workers/sync");
    await import("../../src/checkpoints/scheduler");
    await import("../../src/imports/service");
    await import("../../src/network/service");
    await import("../../src/databases/startup");
    await import("../../src/checkpoints/startup");
    const services = listServices().map((s) => s.name);
    for (const name of ["metrics", "sync", "checkpoints", "imports", "network"]) {
      expect(services).toContain(name);
    }
    const known = [
      "mariadb.recover",
      "mariadb.orphans",
      "mariadb.grants",
      "mariadb.readonly",
      "mariadb.definers",
      "databases.reconcile",
      "checkpoints.legacy",
    ];
    const tasks = listStartupTasks().filter((name) => known.includes(name));
    expect(tasks).toEqual(known);
  });

  test("tasks without a fixed position run after the ranked ones, in registration order", () => {
    registerStartupTask("test.unranked.first", () => {});
    registerStartupTask("test.unranked.second", () => {});
    const tasks = listStartupTasks();
    expect(tasks.indexOf("checkpoints.legacy")).toBeLessThan(tasks.indexOf("test.unranked.first"));
    expect(tasks.indexOf("test.unranked.first")).toBeLessThan(tasks.indexOf("test.unranked.second"));
  });
});
