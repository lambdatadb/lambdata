import mysql, { type Connection, type RowDataPacket } from "mysql2/promise";
import { audit, databases } from "../db/queries";
import { env, readEnv } from "../env";
import { escapeHostPattern } from "../util/ident";
import type { Account } from "./codeObjects";
import { getRootPassword, localConnectHost, mariadbState } from "./controller";
import { readJournals, removeJournal, writeJournal } from "./journal";
import { sanitizeMariaDbMessage } from "./messages";
import { onSwapCompleted, swapInProgress } from "./schemaSwap";

export interface WriteFence {
  databaseId: string;
  schema: string;
  accounts: Account[];
  sessionsEnded: number;
  eventsDisabled: string[];
  signal: AbortSignal;
}

interface FenceJournal {
  version: 1 | 2;
  databaseId: string;
  schema: string;
  locked: Account[];
  events?: string[];
  eventsReplaced?: boolean;
  createdAt: number;
}

interface FenceEntry {
  schema: string;
  accounts: Account[];
  locked: Account[];
  events: string[];
  eventsReplaced: boolean;
  depth: number;
  controller: AbortController;
  createdAt: number;
  lifted: boolean;
}

export class WriteFencedError extends Error {
  readonly databaseId: string;

  constructor(databaseId: string) {
    super("this database is briefly closed to writes while LambData replaces its contents; try again in a moment");
    this.name = "WriteFencedError";
    this.databaseId = databaseId;
  }
}

export class FenceTimeoutError extends Error {
  readonly databaseId: string;

  constructor(databaseId: string, schema: string, minutes: number) {
    super(
      `the work on ${schema} did not finish within ${minutes} minute${minutes === 1 ? "" : "s"}, so it was stopped and ${schema} was opened again to its own account; nothing it had not finished was kept`,
    );
    this.name = "FenceTimeoutError";
    this.databaseId = databaseId;
  }
}

const SESSION_END_WAIT_MS = 5_000;
const LIFT_RETRY_MS = [1_000, 2_000, 5_000, 10_000, 30_000];
const SWAP_POLL_MS = 500;
const DEFAULT_MAX_MINUTES = 120;
const fenced = new Map<string, FenceEntry>();
const inFlight = new Map<string, number>();
const drainWaiters = new Map<string, Set<() => void>>();

function maxMinutesFromEnv(): number {
  const n = Number(readEnv("FENCE_MAX_MINUTES"));
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_MAX_MINUTES;
}

export const fenceLimits = { drainMs: 5_000, maxMs: maxMinutesFromEnv() * 60_000 };

export function beginWrite(databaseId: string): () => void {
  inFlight.set(databaseId, (inFlight.get(databaseId) ?? 0) + 1);
  let finished = false;
  return () => {
    if (finished) return;
    finished = true;
    const left = (inFlight.get(databaseId) ?? 1) - 1;
    if (left > 0) {
      inFlight.set(databaseId, left);
      return;
    }
    inFlight.delete(databaseId);
    const waiters = drainWaiters.get(databaseId);
    drainWaiters.delete(databaseId);
    for (const wake of waiters ?? []) wake();
  };
}

export function writesInFlight(databaseId: string): number {
  return inFlight.get(databaseId) ?? 0;
}

function writesDrained(databaseId: string): Promise<boolean> {
  if (!inFlight.has(databaseId)) return Promise.resolve(true);
  return new Promise<boolean>((resolve) => {
    const waiters = drainWaiters.get(databaseId) ?? new Set<() => void>();
    const wake = (): void => {
      clearTimeout(timer);
      resolve(true);
    };
    const timer = setTimeout(() => {
      waiters.delete(wake);
      resolve(false);
    }, fenceLimits.drainMs);
    waiters.add(wake);
    drainWaiters.set(databaseId, waiters);
  });
}

function seconds(ms: number): string {
  const s = Math.round(ms / 100) / 10;
  return `${s} second${s === 1 ? "" : "s"}`;
}

function errorMessage(err: unknown): string {
  return sanitizeMariaDbMessage(err instanceof Error ? err.message : String(err));
}

function journalId(databaseId: string): string {
  return databaseId.replace(/[^A-Za-z0-9_-]/g, "_");
}

function quote(name: string): string {
  return "`" + name.replaceAll("`", "``") + "`";
}

export function isWriteFenced(databaseIdOrSchema: string): boolean {
  if (fenced.has(databaseIdOrSchema)) return true;
  for (const f of fenced.values()) if (f.schema === databaseIdOrSchema) return true;
  return false;
}

export function assertNotWriteFenced(databaseId: string): void {
  if (isWriteFenced(databaseId)) throw new WriteFencedError(databaseId);
}

export function fenceAbortSignal(databaseId: string): AbortSignal | null {
  return fenced.get(databaseId)?.controller.signal ?? null;
}

export function abortFencedWork(databaseId: string, reason: string): boolean {
  const entry = fenced.get(databaseId);
  if (!entry || entry.controller.signal.aborted) return false;
  entry.controller.abort(new Error(reason));
  return true;
}

async function withFreshAdmin<T>(fn: (c: Connection) => Promise<T>): Promise<T> {
  const conn = await mysql.createConnection({
    host: localConnectHost(),
    port: env.mariadbPort,
    user: env.rootUser,
    password: await getRootPassword(),
    multipleStatements: false,
    connectTimeout: 5_000,
  });
  try {
    return await fn(conn);
  } finally {
    await conn.end().catch(() => conn.destroy());
  }
}

async function ownHosts(c: Connection, user: string): Promise<{ host: string; locked: boolean }[]> {
  const [rows] = await c.query<RowDataPacket[]>(
    "SELECT Host AS host, JSON_VALUE(Priv, '$.account_locked') AS locked FROM mysql.global_priv WHERE User = ?",
    [user],
  );
  return rows.map((r) => ({ host: String(r.host), locked: r.locked === "1" || r.locked === 1 || r.locked === "true" || r.locked === true }));
}

async function enabledEvents(c: Connection, schema: string): Promise<string[]> {
  const [rows] = await c.query<RowDataPacket[]>(
    "SELECT EVENT_NAME AS name FROM information_schema.EVENTS WHERE EVENT_SCHEMA = ? AND STATUS = 'ENABLED' ORDER BY EVENT_NAME",
    [schema],
  );
  return rows.map((r) => String(r.name));
}

async function setLock(c: Connection, accounts: Account[], locked: boolean): Promise<void> {
  for (const a of accounts) {
    await c.query(`ALTER USER IF EXISTS ?@? ACCOUNT ${locked ? "LOCK" : "UNLOCK"}`, [a.user, a.host]);
  }
}

async function endSessions(c: Connection, users: string[]): Promise<number> {
  if (users.length === 0) return 0;
  const list = async () => {
    const [rows] = await c.query<RowDataPacket[]>(
      "SELECT ID AS id FROM information_schema.PROCESSLIST WHERE USER IN (?) AND ID <> CONNECTION_ID()",
      [users],
    );
    return rows.map((r) => Number(r.id));
  };
  const ids = await list();
  for (const id of ids) await c.query("KILL CONNECTION ?", [id]).catch(() => {});
  const started = Date.now();
  while (Date.now() - started < SESSION_END_WAIT_MS) {
    if ((await list()).length === 0) break;
    await Bun.sleep(50);
  }
  return ids.length;
}

function ownUser(databaseId: string): { schema: string; user: string; host: string } {
  const row = databases.byId(databaseId);
  if (!row) throw new Error(`database ${databaseId} not found`);
  return { schema: row.name, user: row.mysqlUser, host: escapeHostPattern(row.connectionsFrom) };
}

function journalOf(databaseId: string, entry: FenceEntry): FenceJournal {
  return {
    version: 2,
    databaseId,
    schema: entry.schema,
    locked: entry.locked,
    events: entry.events,
    eventsReplaced: entry.eventsReplaced,
    createdAt: entry.createdAt,
  };
}

async function reenableEvents(c: Connection, databaseId: string, schema: string, events: string[]): Promise<string[]> {
  const problems: string[] = [];
  for (const name of events) {
    try {
      const [rows] = await c.query<RowDataPacket[]>(
        "SELECT STATUS AS status FROM information_schema.EVENTS WHERE EVENT_SCHEMA = ? AND EVENT_NAME = ?",
        [schema, name],
      );
      if (rows.length === 0 || String(rows[0]!.status) !== "DISABLED") continue;
      await c.query(`ALTER EVENT ${quote(schema)}.${quote(name)} ENABLE`);
    } catch (err) {
      const message = `WARNING: the event ${schema}.${name} was switched off while LambData replaced the database's contents and could not be switched back on (${errorMessage(err)}); it stays disabled until you run ALTER EVENT ${quote(schema)}.${quote(name)} ENABLE`;
      console.error(`[mariadb] ${message}`);
      problems.push(message);
      try {
        audit.log(null, "database.fence.event-not-reenabled", databaseId, { schema, event: name, error: errorMessage(err) });
      } catch {
        continue;
      }
    }
  }
  return problems;
}

async function liftJournal(j: FenceJournal): Promise<string[]> {
  if (mariadbState() !== "running") throw new Error("MariaDB is not running");
  const problems = await withFreshAdmin(async (c) => {
    await setLock(c, j.locked ?? [], false);
    if (j.eventsReplaced || !j.events || j.events.length === 0) return [];
    return reenableEvents(c, j.databaseId, j.schema, j.events);
  });
  removeJournal("fence", journalId(j.databaseId));
  return problems;
}

async function lift(databaseId: string, entry: FenceEntry): Promise<void> {
  if (entry.lifted) return;
  await liftJournal(journalOf(databaseId, entry));
  entry.lifted = true;
}

function liftWithRetry(databaseId: string, entry: FenceEntry, attempt = 0): void {
  const delay = LIFT_RETRY_MS[Math.min(attempt, LIFT_RETRY_MS.length - 1)]!;
  setTimeout(() => {
    lift(databaseId, entry).catch((err) => {
      console.error(`[mariadb] could not reopen ${entry.schema} to its own account yet; retrying:`, errorMessage(err));
      liftWithRetry(databaseId, entry, attempt + 1);
    });
  }, delay).unref?.();
}

async function liftNow(databaseId: string, entry: FenceEntry): Promise<void> {
  if (fenced.get(databaseId) === entry) fenced.delete(databaseId);
  await lift(databaseId, entry).catch((err) => {
    console.error(`[mariadb] could not reopen ${entry.schema} to its own account; retrying:`, errorMessage(err));
    liftWithRetry(databaseId, entry);
  });
}

async function noSwapRunning(databaseId: string, schema: string): Promise<void> {
  while (swapInProgress(databaseId) || swapInProgress(schema)) await Bun.sleep(SWAP_POLL_MS);
}

onSwapCompleted((_note, info) => {
  if (!info.eventsReplaced) return;
  const id = info.databaseId ?? [...fenced.entries()].find(([, f]) => f.schema === info.live)?.[0] ?? null;
  if (!id) return;
  const entry = fenced.get(id);
  if (entry) {
    entry.eventsReplaced = true;
    try {
      writeJournal("fence", journalId(id), journalOf(id, entry));
    } catch (err) {
      console.warn(`[mariadb] could not record that the events of ${entry.schema} were replaced:`, errorMessage(err));
    }
    return;
  }
  const stored = readJournals<FenceJournal>("fence").find((j) => j.data?.databaseId === id)?.data;
  if (stored) writeJournal("fence", journalId(id), { ...stored, eventsReplaced: true });
});

export async function withWriteFence<T>(databaseId: string, fn: (fence: WriteFence) => Promise<T>): Promise<T> {
  const existing = fenced.get(databaseId);
  if (existing) {
    existing.depth++;
    try {
      return await fn({
        databaseId,
        schema: existing.schema,
        accounts: existing.accounts,
        sessionsEnded: 0,
        eventsDisabled: existing.events,
        signal: existing.controller.signal,
      });
    } finally {
      existing.depth--;
    }
  }
  const own = ownUser(databaseId);
  const state = await withFreshAdmin(async (c) => ({ hosts: await ownHosts(c, own.user), events: await enabledEvents(c, own.schema) }));
  const accounts: Account[] = state.hosts.length > 0 ? state.hosts.map((h) => ({ user: own.user, host: h.host })) : [{ user: own.user, host: own.host }];
  const locked = state.hosts.filter((h) => !h.locked).map((h) => ({ user: own.user, host: h.host }));
  const entry: FenceEntry = {
    schema: own.schema,
    accounts,
    locked,
    events: state.events,
    eventsReplaced: false,
    depth: 1,
    controller: new AbortController(),
    createdAt: Date.now(),
    lifted: false,
  };
  fenced.set(databaseId, entry);
  if (!(await writesDrained(databaseId))) {
    const running = writesInFlight(databaseId);
    fenced.delete(databaseId);
    throw new Error(
      `could not close ${own.schema} to writes: ${running} Data API write(s) were still running after ${seconds(fenceLimits.drainMs)}, so nothing was changed; try again in a moment`,
    );
  }
  let sessionsEnded = 0;
  try {
    writeJournal("fence", journalId(databaseId), journalOf(databaseId, entry));
    sessionsEnded = await withFreshAdmin(async (c) => {
      await setLock(c, locked, true);
      for (const name of entry.events) await c.query(`ALTER EVENT ${quote(own.schema)}.${quote(name)} DISABLE`);
      return endSessions(c, [own.user]);
    });
  } catch (err) {
    fenced.delete(databaseId);
    await lift(databaseId, entry).catch(() => liftWithRetry(databaseId, entry));
    throw new Error(`could not close ${own.schema} to writes: ${errorMessage(err)}`, { cause: err });
  }

  const fence: WriteFence = {
    databaseId,
    schema: own.schema,
    accounts,
    sessionsEnded,
    eventsDisabled: [...entry.events],
    signal: entry.controller.signal,
  };
  const limitMs = fenceLimits.maxMs;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const work = fn(fence);
  const watchdog = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), limitMs);
  });
  let outcome: { ok: true; value: T } | { ok: false; error: unknown } | "timeout";
  try {
    outcome = await Promise.race([
      work.then(
        (value) => ({ ok: true as const, value }),
        (error: unknown) => ({ ok: false as const, error }),
      ),
      watchdog,
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
  if (outcome === "timeout") {
    const minutes = Math.round((limitMs / 60_000) * 10) / 10;
    abortFencedWork(databaseId, `the work on ${own.schema} ran longer than ${minutes} minute(s)`);
    console.error(`[mariadb] the work holding ${own.schema} closed to writes ran longer than ${minutes} minute(s); stopping it and reopening the database`);
    await noSwapRunning(databaseId, own.schema);
    await liftNow(databaseId, entry);
    void work.then(
      () => console.error(`[mariadb] the work on ${own.schema} finished after its fence was lifted; its result was discarded`),
      (err: unknown) => console.error(`[mariadb] the work on ${own.schema} failed after its fence was lifted; its result was discarded:`, errorMessage(err)),
    );
    throw new FenceTimeoutError(databaseId, own.schema, minutes);
  }
  await liftNow(databaseId, entry);
  if (outcome.ok) return outcome.value;
  throw outcome.error;
}

export async function liftLeftoverWriteFences(): Promise<{ lifted: string[]; warnings: string[] }> {
  const lifted: string[] = [];
  const warnings: string[] = [];
  for (const record of readJournals<FenceJournal>("fence")) {
    const j = record.data;
    if (!j) {
      warnings.push(`unreadable write-fence record ${record.id}: ${record.error ?? "unknown error"}`);
      continue;
    }
    if (fenced.has(j.databaseId)) continue;
    try {
      warnings.push(...(await liftJournal(j)));
      lifted.push(j.schema);
    } catch (err) {
      warnings.push(`${j.schema}: ${errorMessage(err)}`);
    }
  }
  return { lifted, warnings };
}

export async function reconcileFencesAfterRestart(): Promise<{ aborted: string[]; reapplied: string[]; warnings: string[] }> {
  const report = { aborted: [] as string[], reapplied: [] as string[], warnings: [] as string[] };
  for (const [databaseId, entry] of [...fenced.entries()]) {
    if (swapInProgress(databaseId) || swapInProgress(entry.schema)) continue;
    if (abortFencedWork(databaseId, `MariaDB restarted while ${entry.schema} was closed to writes`)) report.aborted.push(entry.schema);
    try {
      await withFreshAdmin(async (c) => {
        await setLock(c, entry.locked, true);
        for (const name of entry.events) await c.query(`ALTER EVENT ${quote(entry.schema)}.${quote(name)} DISABLE`).catch(() => {});
        await endSessions(c, [...new Set(entry.accounts.map((a) => a.user))]);
      });
      report.reapplied.push(entry.schema);
    } catch (err) {
      report.warnings.push(`${entry.schema}: ${errorMessage(err)}`);
    }
  }
  const leftovers = await liftLeftoverWriteFences();
  report.warnings.push(...leftovers.warnings);
  return report;
}

export async function liftAllWriteFences(): Promise<void> {
  for (const [databaseId, entry] of [...fenced.entries()]) {
    abortFencedWork(databaseId, "LambData is stopping");
    try {
      await lift(databaseId, entry);
    } catch (err) {
      console.error(`[mariadb] could not reopen ${entry.schema} before stopping; it is reopened at the next start:`, errorMessage(err));
    }
  }
}
