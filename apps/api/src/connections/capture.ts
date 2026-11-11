import { closeSync, existsSync, openSync, readSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import type { RowDataPacket } from "mysql2/promise";
import { settings } from "../db/queries";
import { env } from "../env";
import { captureSpawnInfo, logFilePath, onMariaDbReady, withRootConnection } from "../mariadb/controller";
import { auditLogPath } from "./auditPlugin";
import { groupRejections, loadAccountDirectory } from "./classify";
import { parseLine, type CaptureSource, type RawRejection } from "./parse";
import { recordRejections } from "./store";

export type CaptureMode = CaptureSource | "none";

export const POLL_INTERVAL_MS = 10_000;
export const MAX_READ_BYTES = 1024 * 1024;
export const SINCE_KEY = "connection_rejections_since";
const ON_DEMAND_MIN_MS = 2_000;

interface FileCursor {
  ino: number;
  offset: number;
}

export class LogTail {
  private cursor: FileCursor | null = null;
  private previous: FileCursor | null = null;

  constructor(
    readonly path: string,
    private readonly maxBytes = MAX_READ_BYTES,
  ) {}

  start(offset?: number): void {
    const st = statOf(this.path);
    const size = st?.size ?? 0;
    this.cursor = { ino: st?.ino ?? 0, offset: Math.min(offset ?? size, size) };
    this.previous = null;
  }

  position(): FileCursor | null {
    return this.cursor ? { ...this.cursor } : null;
  }

  readLines(): string[] {
    if (!this.cursor) this.start();
    const cursor = this.cursor!;
    const st = statOf(this.path);
    const lines: string[] = [];
    if (cursor.ino !== 0 && (!st || st.ino !== cursor.ino)) {
      this.previous = { ino: cursor.ino, offset: cursor.offset };
      cursor.ino = 0;
      cursor.offset = 0;
    } else if (st && st.size < cursor.offset) {
      cursor.offset = 0;
    }
    if (this.previous) {
      const rotated = statOf(`${this.path}.1`);
      if (!rotated || rotated.ino !== this.previous.ino) {
        this.previous = null;
      } else if (rotated.size > this.previous.offset) {
        const chunk = this.readRange(`${this.path}.1`, this.previous.offset, rotated.size);
        lines.push(...chunk.lines);
        this.previous.offset = chunk.next;
      } else if (rotated.size < this.previous.offset) {
        this.previous = null;
      }
    }
    if (!st) return lines;
    cursor.ino = st.ino;
    if (st.size > cursor.offset) {
      const chunk = this.readRange(this.path, cursor.offset, st.size);
      lines.push(...chunk.lines);
      cursor.offset = chunk.next;
    }
    return lines;
  }

  private readRange(path: string, from: number, to: number): { lines: string[]; next: number } {
    let start = from;
    let skipped = false;
    if (to - start > this.maxBytes) {
      start = to - this.maxBytes;
      skipped = true;
    }
    const len = to - start;
    if (len <= 0) return { lines: [], next: from };
    const buf = Buffer.alloc(len);
    let fd: number | null = null;
    let read = 0;
    try {
      fd = openSync(path, "r");
      read = readSync(fd, buf, 0, len, start);
    } catch {
      return { lines: [], next: from };
    } finally {
      if (fd !== null) closeSync(fd);
    }
    let text = buf.subarray(0, read).toString("utf8");
    let consumedStart = start;
    if (skipped) {
      const nl = text.indexOf("\n");
      if (nl < 0) return { lines: [], next: start + read };
      consumedStart += Buffer.byteLength(text.slice(0, nl + 1));
      text = text.slice(nl + 1);
    }
    const lastNl = text.lastIndexOf("\n");
    if (lastNl < 0) return { lines: [], next: consumedStart };
    const complete = text.slice(0, lastNl);
    return { lines: complete.split("\n"), next: consumedStart + Buffer.byteLength(complete) + 1 };
  }
}

function statOf(path: string): { ino: number; size: number } | null {
  try {
    const st = statSync(path);
    return { ino: Number(st.ino), size: st.size };
  } catch {
    return null;
  }
}

let mode: CaptureMode = "none";
let tail: LogTail | null = null;
let timer: ReturnType<typeof setInterval> | null = null;
let lastPollAt = 0;
let polling = false;

export function captureMode(): CaptureMode {
  return mode;
}

export function rejectionsSupported(): boolean {
  return mode !== "none";
}

export function rejectionsSince(): number | null {
  if (mode === "none") return null;
  const raw = settings.get(SINCE_KEY);
  const n = raw === null ? Number.NaN : Number(raw);
  return Number.isFinite(n) ? n : null;
}

export function markRejectionsSince(at = Date.now()): void {
  settings.set(SINCE_KEY, String(at));
}

async function globalVariable(name: string): Promise<string | null> {
  try {
    return await withRootConnection(async (c) => {
      const [rows] = await c.query<RowDataPacket[]>("SHOW GLOBAL VARIABLES WHERE Variable_name = ?", [name]);
      const value = rows[0]?.Value;
      return value === undefined || value === null ? null : String(value);
    });
  } catch {
    return null;
  }
}

export interface DetectedCapture {
  mode: CaptureMode;
  path: string | null;
}

function errorLogPath(configured: string | null): string {
  const value = configured?.trim() ?? "";
  if (!value || value.toLowerCase() === "stderr") return logFilePath();
  const path = isAbsolute(value) ? value : join(env.mariadbDataDir, value);
  return existsSync(path) ? path : logFilePath();
}

export async function detectCapture(): Promise<DetectedCapture> {
  const info = captureSpawnInfo();
  if (info.auditRequested) {
    const logging = await globalVariable("server_audit_logging");
    if (logging !== null && /^(on|1)$/i.test(logging)) return { mode: "audit", path: auditLogPath() };
  }
  const warnings = Number(await globalVariable("log_warnings"));
  if (!Number.isFinite(warnings) || warnings < 2) return { mode: "none", path: null };
  return { mode: "errorlog", path: errorLogPath(await globalVariable("log_error")) };
}

export function setCapture(next: DetectedCapture, startOffset?: number): void {
  mode = next.path ? next.mode : "none";
  if (mode === "none" || !next.path) {
    tail = null;
    return;
  }
  tail = new LogTail(next.path);
  tail.start(startOffset);
  if (settings.get(SINCE_KEY) === null) markRejectionsSince();
}

export function ingestRawRejections(raws: RawRejection[], now = Date.now()): number {
  if (raws.length === 0) return 0;
  const groups = groupRejections(raws, loadAccountDirectory());
  if (groups.length === 0) return 0;
  try {
    recordRejections(groups, now);
  } catch (err) {
    console.warn("[connections] could not record rejected connections:", err instanceof Error ? err.message : String(err));
    return 0;
  }
  return groups.length;
}

export function ingestLines(source: CaptureSource, lines: string[], now = Date.now()): number {
  const raws: RawRejection[] = [];
  for (const line of lines) {
    const r = parseLine(source, line, now);
    if (r) raws.push(r);
  }
  return ingestRawRejections(raws, now);
}

export function pollRejections(): number {
  if (polling || mode === "none" || !tail) return 0;
  polling = true;
  try {
    lastPollAt = Date.now();
    return ingestLines(mode, tail.readLines(), lastPollAt);
  } catch (err) {
    console.warn("[connections] could not read rejected connections:", err instanceof Error ? err.message : String(err));
    return 0;
  } finally {
    polling = false;
  }
}

export function refreshRejections(): void {
  if (Date.now() - lastPollAt < ON_DEMAND_MIN_MS) return;
  pollRejections();
}

function ensureTimer(): void {
  if (timer) return;
  timer = setInterval(() => {
    pollRejections();
  }, POLL_INTERVAL_MS);
  timer.unref?.();
}

export function stopRejectionCapture(): void {
  if (timer) clearInterval(timer);
  timer = null;
  mode = "none";
  tail = null;
}

export async function startRejectionCapture(reason: "start" | "retry" | "restart" | "rebind"): Promise<CaptureMode> {
  const next = await detectCapture();
  const keep = reason !== "start" && next.mode === mode && tail !== null && tail.path === next.path;
  if (!keep) {
    const info = captureSpawnInfo();
    const offset =
      next.mode === "audit" ? info.auditOffset : next.mode === "errorlog" && next.path === logFilePath() ? info.logOffset : undefined;
    setCapture(next, offset);
  }
  if (mode !== "none") ensureTimer();
  return mode;
}

onMariaDbReady(async (reason) => {
  try {
    const active = await startRejectionCapture(reason);
    if (reason === "start") {
      const label = active === "audit" ? "the audit plugin" : active === "errorlog" ? "the MariaDB error log" : null;
      console.log(
        label ? `[connections] rejected connections are read from ${label}` : "[connections] rejected connections cannot be captured on this MariaDB",
      );
    }
  } catch (err) {
    console.warn("[connections] rejected connections are not captured:", err instanceof Error ? err.message : String(err));
  }
});
