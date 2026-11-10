export interface BackgroundService {
  name: string;
  start(): void | Promise<void>;
  stop(): void | Promise<void>;
  running(): boolean;
}

export type StartupTask = () => void | Promise<void>;

const STARTUP_ORDER = [
  "mariadb.recover",
  "mariadb.orphans",
  "mariadb.grants",
  "mariadb.readonly",
  "mariadb.definers",
  "databases.reconcile",
  "checkpoints.legacy",
];

const services = new Map<string, BackgroundService>();
const startupTasks: { name: string; fn: StartupTask }[] = [];
let startupRun: Promise<void> | null = null;

function startupRank(name: string): number {
  const index = STARTUP_ORDER.indexOf(name);
  return index >= 0 ? index : STARTUP_ORDER.length;
}

function orderedStartupTasks(): { name: string; fn: StartupTask }[] {
  return startupTasks
    .map((task, index) => ({ task, index }))
    .sort((a, b) => startupRank(a.task.name) - startupRank(b.task.name) || a.index - b.index)
    .map((entry) => entry.task);
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function registerService(service: BackgroundService): BackgroundService {
  services.set(service.name, service);
  return service;
}

export function registerStartupTask(name: string, fn: StartupTask): void {
  const existing = startupTasks.findIndex((t) => t.name === name);
  if (existing >= 0) startupTasks[existing] = { name, fn };
  else startupTasks.push({ name, fn });
}

export function listServices(): { name: string; running: boolean }[] {
  return [...services.values()].map((s) => ({ name: s.name, running: safeRunning(s) }));
}

export function listStartupTasks(): string[] {
  return orderedStartupTasks().map((t) => t.name);
}

function safeRunning(service: BackgroundService): boolean {
  try {
    return service.running();
  } catch {
    return false;
  }
}

export function serviceRunning(name: string): boolean {
  const service = services.get(name);
  return service ? safeRunning(service) : false;
}

export async function startServices(): Promise<void> {
  for (const service of services.values()) {
    try {
      await service.start();
    } catch (err) {
      console.error(`[lifecycle] service ${service.name} failed to start:`, describe(err));
    }
  }
}

export async function stopServices(): Promise<void> {
  for (const service of [...services.values()].reverse()) {
    try {
      await service.stop();
    } catch (err) {
      console.error(`[lifecycle] service ${service.name} failed to stop:`, describe(err));
    }
  }
}

export async function runStartupTasks(): Promise<{ name: string; ok: boolean; error?: string }[]> {
  const results: { name: string; ok: boolean; error?: string }[] = [];
  for (const task of orderedStartupTasks()) {
    const started = Date.now();
    try {
      await task.fn();
      results.push({ name: task.name, ok: true });
      console.log(`[lifecycle] startup task ${task.name} done in ${Date.now() - started}ms`);
    } catch (err) {
      results.push({ name: task.name, ok: false, error: describe(err) });
      console.error(`[lifecycle] startup task ${task.name} failed:`, describe(err));
    }
  }
  return results;
}

export function runStartupTasksOnce(): Promise<void> {
  if (!startupRun) {
    startupRun = runStartupTasks().then(
      () => undefined,
      (err) => {
        console.error("[lifecycle] startup tasks failed:", describe(err));
      },
    );
  }
  return startupRun;
}

export function startupTasksStarted(): boolean {
  return startupRun !== null;
}

export function safeTick(name: string, fn: () => unknown): () => Promise<void> {
  return async () => {
    try {
      await fn();
    } catch (err) {
      console.error(`[${name}] tick failed:`, describe(err));
    }
  };
}

export function intervalService(opts: {
  name: string;
  intervalMs: number;
  tick: () => unknown;
  runOnStart?: boolean;
}): BackgroundService {
  let timer: ReturnType<typeof setInterval> | null = null;
  let busy = false;
  const tick = safeTick(opts.name, opts.tick);
  const run = (): void => {
    if (busy) return;
    busy = true;
    tick().finally(() => {
      busy = false;
    });
  };
  return {
    name: opts.name,
    start() {
      if (timer) return;
      timer = setInterval(run, opts.intervalMs);
      if (opts.runOnStart) run();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
    running() {
      return timer !== null;
    },
  };
}

export function placeholderService(name: string): BackgroundService {
  let started = false;
  return {
    name,
    start() {
      started = true;
    },
    stop() {
      started = false;
    },
    running() {
      return started;
    },
  };
}
