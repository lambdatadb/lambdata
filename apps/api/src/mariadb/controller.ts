import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  realpathSync,
  renameSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import mysql, { type Connection, type Pool, type PoolConnection, type RowDataPacket } from "mysql2/promise";
import { env, readEnv } from "../env";
import { LEGACY } from "../util/legacy";
import { settings } from "../db/queries";
import { encryptSecret, decryptSecret } from "../util/crypto";
import { generatePassword } from "../util/credentials";
import { locateBinariesSync, type MariaDbBinaries } from "./installer";
import { upgradeDataDirIfNeeded } from "./upgrade";
import { resolveDatabaseBind } from "../connections/bind";
import {
  auditCaptureWanted,
  auditLogPath,
  auditServerArgs,
  disableAuditCaptureForProcess,
  enableAuditCaptureForProcess,
} from "../connections/auditPlugin";

export type MariaDbState = "stopped" | "starting" | "running" | "restarting" | "stopping" | "failed";

export type ReadyReason = "start" | "retry" | "restart" | "rebind";
export type ReadyHook = (reason: ReadyReason) => void | Promise<void>;

export interface MariaDbHealth {
  ok: boolean;
  error?: string;
  state: MariaDbState;
  restarts: number;
}

type ServerProc = ReturnType<typeof Bun.spawn>;

const ROOT_USER_HOSTS = ["localhost", "127.0.0.1"];
const RESTART_BACKOFF_MS = [1_000, 2_000, 5_000, 10_000, 30_000, 60_000];
const STABLE_UPTIME_MS = 60_000;
const READY_TIMEOUT_MS = 30_000;
const STOP_TIMEOUT_MS = 120_000;
const SOCKET_NAME = "mariadb.sock";
const PID_FILE_NAME = "lambdata-mariadbd.pid";
const MAX_ALLOWED_PACKET = "1G";
const LOG_TAIL_BYTES = 16 * 1024;

let pool: Pool | null = null;
let serverProc: ServerProc | null = null;
let binaries: MariaDbBinaries | null = null;
let state: MariaDbState = "stopped";
let wantRunning = false;
let restartTimer: ReturnType<typeof setTimeout> | null = null;
let restartAttempt = 0;
let failedRestarts = 0;
let restartsTotal = 0;
let runningSince: number | null = null;
let lastExit: { code: number | null; signal: string | null } | null = null;
let lastError: string | null = null;
let queue: Promise<void> = Promise.resolve();
let startFailures = 0;
let logOffsetAtSpawn = 0;
let auditOffsetAtSpawn = 0;
let auditRequested = false;
let logTimer: ReturnType<typeof setInterval> | null = null;

export const mariadbLogLimits = { maxBytes: 16 * 1024 * 1024, checkMs: 30_000 };
const readyHooks: ReadyHook[] = [];

function serialized<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.then(fn, fn);
  queue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function getMariaDbBinariesSync(): MariaDbBinaries {
  if (!binaries) binaries = locateBinariesSync();
  return binaries;
}

async function getBinaries(): Promise<MariaDbBinaries> {
  return getMariaDbBinariesSync();
}

export function localConnectHost(): string {
  const bind = env.mariadbBind;
  return bind === "0.0.0.0" || bind === "::" || bind === "*" ? "127.0.0.1" : bind;
}

function socketPathLimit(): number {
  return process.platform === "linux" ? 107 : 103;
}

export function socketPathFor(mariadbDataDir: string): string {
  const inDataDir = join(mariadbDataDir, SOCKET_NAME);
  const limit = socketPathLimit();
  if (Buffer.byteLength(inDataDir) <= limit) return inDataDir;
  const hash = new Bun.CryptoHasher("sha256").update(mariadbDataDir).digest("hex").slice(0, 16);
  const name = `lambdata-${hash}.sock`;
  for (const dir of [tmpdir(), "/tmp"]) {
    const candidate = join(dir, name);
    if (Buffer.byteLength(candidate) <= limit) return candidate;
  }
  return join("/tmp", name);
}

function isDataDirInitialized(): boolean {
  if (!existsSync(env.mariadbDataDir)) return false;
  const entries = readdirSync(env.mariadbDataDir);
  return entries.includes("mysql");
}

async function initDataDir(b: MariaDbBinaries): Promise<void> {
  const args = [
    `--datadir=${env.mariadbDataDir}`,
    "--auth-root-authentication-method=normal",
    "--skip-test-db",
  ];
  const proc = Bun.spawn([b.installDb, ...args], {
    cwd: env.dataDir,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env },
  });
  const [exit, err] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
  if (exit !== 0) {
    throw new Error(`mariadb-install-db failed (${exit}): ${err}`);
  }
}

async function rootPasswordFromSettings(): Promise<string> {
  const stored = settings.get("mariadb_root_password_enc");
  if (stored) return decryptSecret(stored);
  const pw = generatePassword();
  settings.set("mariadb_root_password_enc", await encryptSecret(pw));
  return pw;
}

async function systemRootPasswordFromSettings(): Promise<string> {
  const stored = settings.get("mariadb_system_root_password_enc");
  if (stored) return decryptSecret(stored);
  const pw = generatePassword();
  settings.set("mariadb_system_root_password_enc", await encryptSecret(pw));
  return pw;
}

async function connectAsSuperuser(): Promise<Connection> {
  const candidates: { user: string; password: string }[] = [];
  const systemStored = settings.get("mariadb_system_root_password_enc");
  if (systemStored) candidates.push({ user: "root", password: await decryptSecret(systemStored) });
  candidates.push({ user: "root", password: "" });
  const adminStored = settings.get("mariadb_root_password_enc");
  if (adminStored) {
    const adminPassword = await decryptSecret(adminStored);
    candidates.push({ user: env.rootUser, password: adminPassword });
    candidates.push({ user: LEGACY.mariadbRootUser, password: adminPassword });
  }
  let lastErr: unknown = null;
  for (const cred of candidates) {
    try {
      return await mysql.createConnection({
        host: localConnectHost(),
        port: env.mariadbPort,
        user: cred.user,
        password: cred.password,
        connectTimeout: 2000,
      });
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

export function logFilePath(): string {
  return join(env.logsDir, "mariadb.log");
}

function fileSize(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

function logSize(): number {
  return fileSize(logFilePath());
}

function moveLogAside(): void {
  const path = logFilePath();
  renameSync(path, `${path}.1`);
}

function rotateLogBeforeSpawn(): void {
  if (logSize() <= mariadbLogLimits.maxBytes) return;
  try {
    moveLogAside();
  } catch (err) {
    console.warn("[mariadb] could not move the MariaDB log aside before starting:", errorMessage(err));
  }
}

export async function rotateMariaDbLogIfNeeded(): Promise<boolean> {
  return serialized(async () => {
    if (state !== "running" || !pool || logSize() <= mariadbLogLimits.maxBytes) return false;
    try {
      moveLogAside();
    } catch (err) {
      console.warn("[mariadb] could not move the MariaDB log aside:", errorMessage(err));
      return false;
    }
    try {
      await pool.query("FLUSH ERROR LOGS");
    } catch (err) {
      console.warn("[mariadb] MariaDB did not reopen its log; it keeps writing to the previous file until it restarts:", errorMessage(err));
    }
    return true;
  });
}

function startLogTimer(): void {
  if (logTimer) return;
  logTimer = setInterval(() => {
    void rotateMariaDbLogIfNeeded().catch(() => {});
  }, mariadbLogLimits.checkMs);
  logTimer.unref?.();
}

function stopLogTimer(): void {
  if (logTimer) clearInterval(logTimer);
  logTimer = null;
}

export interface CaptureSpawnInfo {
  auditRequested: boolean;
  logOffset: number;
  auditOffset: number;
}

export function captureSpawnInfo(): CaptureSpawnInfo {
  return { auditRequested, logOffset: logOffsetAtSpawn, auditOffset: auditOffsetAtSpawn };
}

function lastLogError(): string | null {
  try {
    const path = logFilePath();
    const size = statSync(path).size;
    const start = Math.max(Math.min(logOffsetAtSpawn, size), size - LOG_TAIL_BYTES);
    const fd = openSync(path, "r");
    try {
      const len = size - start;
      if (len <= 0) return null;
      const buf = Buffer.alloc(len);
      readSync(fd, buf, 0, len, start);
      const lines = buf
        .toString("utf8")
        .split(/\r?\n/)
        .map((l) => l.replace(/^\d{4}-\d{2}-\d{2}\s+\d{1,2}:\d{2}:\d{2}\s+\d+\s+/, "").trim())
        .filter((l) => l && !/^\[ERROR\]\s*Aborting$/.test(l) && !/\[Note\]/.test(l));
      const errors = lines
        .filter((l) => /\[ERROR\]|fatal|error|can't|cannot|denied|refus/i.test(l))
        .map((l) => l.replace(/^.*?\[ERROR\]\s*/, ""));
      const picked = errors.length > 0 ? errors.slice(-3) : lines.slice(-3);
      return picked.length > 0 ? picked.join(" | ") : null;
    } finally {
      closeSync(fd);
    }
  } catch {
    return null;
  }
}

export function secureFileDir(): string {
  return readEnv("MARIADB_SECURE_FILE_PRIV") ?? join(env.dataDir, "mariadb-files");
}

function prepareSecureFileDir(): string {
  const dir = secureFileDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    if (readdirSync(dir).length > 0) {
      console.warn(`[mariadb] ${dir} should be empty: it is the only folder MariaDB may read or write files in`);
    }
  } catch {
    return dir;
  }
  return dir;
}

export function serverArgs(b: MariaDbBinaries, opts: { audit?: boolean } = {}): string[] {
  const args = [
    b.server,
    `--datadir=${env.mariadbDataDir}`,
    `--port=${env.mariadbPort}`,
    `--bind-address=${env.mariadbBind.trim() || "127.0.0.1"}`,
    `--socket=${socketPathFor(env.mariadbDataDir)}`,
    `--pid-file=${join(env.mariadbDataDir, PID_FILE_NAME)}`,
    "--skip-name-resolve",
    "--default-authentication-plugin=mysql_native_password",
    `--max-allowed-packet=${MAX_ALLOWED_PACKET}`,
    `--secure-file-priv=${prepareSecureFileDir()}`,
    "--local-infile=0",
    `--log-error=${logFilePath()}`,
  ];
  return opts.audit ? [...args, ...auditServerArgs()] : args;
}

function spawnServer(b: MariaDbBinaries, audit: boolean): ServerProc {
  const args = serverArgs(b, { audit });
  rotateLogBeforeSpawn();
  logOffsetAtSpawn = logSize();
  auditOffsetAtSpawn = fileSize(auditLogPath());
  auditRequested = audit;
  const logFd = openSync(logFilePath(), "a");
  let proc: ServerProc;
  try {
    proc = Bun.spawn(
      args,
      {
        cwd: env.dataDir,
        stdout: logFd,
        stderr: logFd,
        env: { ...process.env },
        onExit(p, code, signal) {
          onServerExit(p, code, signal === null || signal === undefined ? null : String(signal));
        },
      },
    );
  } finally {
    closeSync(logFd);
  }
  serverProc = proc;
  return proc;
}

function hasExited(proc: ServerProc): boolean {
  return proc.exitCode !== null || proc.signalCode !== null;
}

class ForeignServerError extends Error {}

function canonicalPath(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p.replace(/\/+$/, "");
  }
}

async function assertOwnServer(conn: Connection, proc: ServerProc): Promise<void> {
  const [rows] = await conn.query<RowDataPacket[]>("SELECT @@datadir AS datadir, @@pid_file AS pidFile");
  const datadir = String(rows[0]?.datadir ?? "");
  if (canonicalPath(datadir) !== canonicalPath(env.mariadbDataDir)) {
    throw new ForeignServerError(
      `port ${env.mariadbPort} is served by another MariaDB or MySQL server (data dir ${datadir}); stop it or choose another port`,
    );
  }
  const pidFile = String(rows[0]?.pidFile ?? "");
  let pid = Number.NaN;
  try {
    pid = Number(readFileSync(isAbsolute(pidFile) ? pidFile : join(env.mariadbDataDir, pidFile), "utf8").trim());
  } catch {
    return;
  }
  if (Number.isInteger(pid) && pid > 0 && pid !== proc.pid) {
    throw new ForeignServerError(`another MariaDB server (pid ${pid}) is already running on ${env.mariadbDataDir}; stop it first`);
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

function commandLineOf(pid: number): string[] | null {
  if (process.platform === "linux") {
    try {
      return readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\u0000").filter(Boolean);
    } catch {
      return null;
    }
  }
  const out = Bun.spawnSync(["ps", "-o", "command=", "-p", String(pid)], { stdout: "pipe", stderr: "ignore" });
  if (out.exitCode !== 0) return null;
  const text = out.stdout.toString().trim();
  return text ? text.split(/\s+/) : null;
}

function provablyOurs(pid: number): boolean {
  const argv = commandLineOf(pid);
  if (!argv || argv.length === 0) return false;
  const exe = argv[0]!.split("/").pop() ?? "";
  if (!/^(?:mariadbd|mysqld)$/.test(exe)) return false;
  const datadir = argv.find((a) => a.startsWith("--datadir="))?.slice("--datadir=".length);
  return datadir !== undefined && canonicalPath(datadir) === canonicalPath(env.mariadbDataDir);
}

function leftoverPids(): number[] {
  const out = new Set<number>();
  let names: string[] = [];
  try {
    names = readdirSync(env.mariadbDataDir).filter((n) => n.endsWith(".pid"));
  } catch {
    return [];
  }
  for (const name of names) {
    try {
      const pid = Number(readFileSync(join(env.mariadbDataDir, name), "utf8").trim());
      if (Number.isInteger(pid) && pid > 0 && pid !== process.pid && pid !== serverProc?.pid) out.add(pid);
    } catch {
      continue;
    }
  }
  return [...out];
}

export async function stopLeftoverServer(): Promise<number[]> {
  const stopped: number[] = [];
  for (const pid of leftoverPids()) {
    if (!isAlive(pid) || !provablyOurs(pid)) continue;
    console.warn(
      `[mariadb] a MariaDB server started by an earlier LambData process is still running on this data directory (pid ${pid}); stopping it before starting a new one`,
    );
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      continue;
    }
    const started = Date.now();
    while (isAlive(pid) && Date.now() - started < STOP_TIMEOUT_MS) await Bun.sleep(200);
    if (isAlive(pid)) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        void 0;
      }
      const killedAt = Date.now();
      while (isAlive(pid) && Date.now() - killedAt < 10_000) await Bun.sleep(100);
    }
    stopped.push(pid);
  }
  return stopped;
}

async function waitForReady(proc: ServerProc, timeoutMs = READY_TIMEOUT_MS): Promise<void> {
  const start = Date.now();
  let lastErr: unknown = null;
  while (Date.now() - start < timeoutMs) {
    if (hasExited(proc)) {
      const detail = lastLogError();
      throw new Error(
        `mariadbd exited during startup (code ${proc.exitCode ?? proc.signalCode})${detail ? `: ${detail}` : ""}`,
      );
    }
    let conn: Connection | null = null;
    try {
      conn = await connectAsSuperuser();
      await conn.ping();
      await assertOwnServer(conn, proc);
      return;
    } catch (err) {
      if (err instanceof ForeignServerError) throw err;
      lastErr = err;
      await Bun.sleep(250);
    } finally {
      await conn?.end().catch(() => {});
    }
  }
  throw new Error(`MariaDB did not become ready: ${String(lastErr)}`);
}

async function ensureRootUser(rootPw: string): Promise<void> {
  const conn = await connectAsSuperuser();
  try {
    for (const host of ROOT_USER_HOSTS) {
      await conn.query(`CREATE USER IF NOT EXISTS ?@? IDENTIFIED BY ?`, [env.rootUser, host, rootPw]);
      await conn.query(`ALTER USER ?@? IDENTIFIED BY ?`, [env.rootUser, host, rootPw]);
      await conn.query(`GRANT ALL PRIVILEGES ON *.* TO ?@? WITH GRANT OPTION`, [env.rootUser, host]);
    }
    await conn.query("FLUSH PRIVILEGES");
  } finally {
    await conn.end();
  }
}

function isNameBasedHost(host: string): boolean {
  if (host.toLowerCase() === "localhost" || host.includes(":") || /[%_]/.test(host)) return false;
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(host)) return false;
  return /[A-Za-z]/.test(host);
}

async function ensureRootPassword(systemRootPw: string): Promise<void> {
  const conn = await connectAsSuperuser();
  try {
    const [rows] = await conn.query(`SELECT Host AS host FROM mysql.user WHERE User = 'root'`);
    for (const row of rows as { host: string }[]) {
      if (!row.host || isNameBasedHost(row.host)) continue;
      try {
        await conn.query(`ALTER USER ?@? IDENTIFIED BY ?`, ["root", row.host, systemRootPw]);
      } catch (err) {
        console.warn(`[mariadb] could not set the password of a root account (host ${row.host}):`, errorMessage(err));
      }
    }
    await conn.query("FLUSH PRIVILEGES");
  } finally {
    await conn.end();
  }
}

function buildPool(rootPw: string): Pool {
  return mysql.createPool({
    host: localConnectHost(),
    port: env.mariadbPort,
    user: env.rootUser,
    password: rootPw,
    waitForConnections: true,
    connectionLimit: 8,
    multipleStatements: false,
    supportBigNumbers: true,
  });
}

async function dropLegacyRootUser(p: Pool): Promise<void> {
  const legacyUser = LEGACY.mariadbRootUser;
  try {
    await p.query("SELECT 1");
  } catch (err) {
    console.warn(`[mariadb] ${env.rootUser} pool check failed; keeping legacy ${legacyUser}:`, errorMessage(err));
    return;
  }
  try {
    const [accounts] = await p.query<RowDataPacket[]>(`SELECT COUNT(*) AS n FROM mysql.user WHERE User = ?`, [
      legacyUser,
    ]);
    if (Number(accounts[0]?.n ?? 0) === 0) return;
    const [definers] = await p.query<RowDataPacket[]>(
      `SELECT COUNT(*) AS n FROM (
         SELECT DEFINER FROM information_schema.VIEWS
         UNION ALL SELECT DEFINER FROM information_schema.ROUTINES
         UNION ALL SELECT DEFINER FROM information_schema.TRIGGERS
         UNION ALL SELECT DEFINER FROM information_schema.EVENTS
       ) d WHERE SUBSTRING_INDEX(d.DEFINER, '@', 1) = ?`,
      [legacyUser],
    );
    if (Number(definers[0]?.n ?? 0) > 0) {
      console.warn(
        `[mariadb] keeping legacy ${legacyUser}: it is the definer of existing views, routines, triggers, or events`,
      );
      return;
    }
    for (const host of ROOT_USER_HOSTS) {
      await p.query(`DROP USER IF EXISTS ?@?`, [legacyUser, host]);
    }
    await p.query("FLUSH PRIVILEGES");
    console.log(`[mariadb] removed legacy ${legacyUser} account`);
  } catch (err) {
    console.warn(`[mariadb] could not remove legacy ${legacyUser}:`, errorMessage(err));
  }
}

async function killServer(proc: ServerProc | null): Promise<void> {
  if (!proc) return;
  if (serverProc === proc) serverProc = null;
  if (hasExited(proc)) return;
  proc.kill("SIGTERM");
  const exited = await Promise.race([proc.exited.then(() => true), Bun.sleep(STOP_TIMEOUT_MS).then(() => false)]);
  if (!exited) {
    proc.kill("SIGKILL");
    await proc.exited.catch(() => {});
  }
}

async function endPool(): Promise<void> {
  const p = pool;
  pool = null;
  if (p) await p.end().catch(() => {});
}

async function upgradeIfNeeded(b: MariaDbBinaries, rootPw: string): Promise<void> {
  let version = "";
  try {
    const conn = await mysql.createConnection({
      host: localConnectHost(),
      port: env.mariadbPort,
      user: env.rootUser,
      password: rootPw,
      connectTimeout: 5000,
    });
    try {
      const [rows] = await conn.query<RowDataPacket[]>("SELECT VERSION() AS v");
      version = String(rows[0]?.v ?? "");
    } finally {
      await conn.end().catch(() => conn.destroy());
    }
    const outcome = await upgradeDataDirIfNeeded({
      bin: b.upgrade,
      datadir: env.mariadbDataDir,
      serverVersion: version,
      host: localConnectHost(),
      port: env.mariadbPort,
      user: env.rootUser,
      password: rootPw,
    });
    if (outcome.ran) {
      console.log(
        `[mariadb] upgraded the data directory from MariaDB ${outcome.from ?? "an unrecorded version"} to ${outcome.to}${outcome.summary ? `: ${outcome.summary}` : ""}`,
      );
    } else if (outcome.summary !== "data directory is current") {
      console.warn(`[mariadb] data directory upgrade check: ${outcome.summary}`);
    }
  } catch (err) {
    console.error(
      `[mariadb] mariadb-upgrade did not complete for server ${version || "of unknown version"}; MariaDB keeps running, but run it by hand if problems appear:`,
      errorMessage(err),
    );
  }
}

async function bootOnce(b: MariaDbBinaries, audit: boolean): Promise<void> {
  const proc = spawnServer(b, audit);
  try {
    await waitForReady(proc);
    const rootPw = await rootPasswordFromSettings();
    await ensureRootUser(rootPw);
    await ensureRootPassword(await systemRootPasswordFromSettings());
    await upgradeIfNeeded(b, rootPw);
    const next = buildPool(rootPw);
    try {
      await next.query("SELECT 1");
    } catch (err) {
      await next.end().catch(() => {});
      throw err;
    }
    pool = next;
    await dropLegacyRootUser(next);
    if (serverProc !== proc || hasExited(proc)) throw new Error("mariadbd exited during startup");
    runningSince = Date.now();
  } catch (err) {
    await endPool();
    await killServer(proc);
    throw err;
  }
}

const NOT_PLUGIN_RELATED = /Bind on TCP\/IP port|Address already in use|Can't assign requested address|served by another/i;

async function boot(b: MariaDbBinaries): Promise<void> {
  const audit = auditCaptureWanted(b.server);
  try {
    await bootOnce(b, audit);
  } catch (err) {
    if (!audit || err instanceof ForeignServerError || NOT_PLUGIN_RELATED.test(errorMessage(err))) throw err;
    console.warn(
      "[mariadb] MariaDB did not start with the connection audit plugin; starting it without the plugin:",
      errorMessage(err),
    );
    disableAuditCaptureForProcess();
    try {
      await bootOnce(b, false);
      console.warn("[mariadb] started without the audit plugin; rejected connections are read from the error log until LambData restarts");
    } catch (retryErr) {
      enableAuditCaptureForProcess();
      throw retryErr;
    }
  }
}

function onServerExit(proc: ServerProc, code: number | null, signal: string | null): void {
  if (proc !== serverProc) return;
  serverProc = null;
  if (state !== "running" || !wantRunning) return;
  lastExit = { code, signal };
  if (runningSince !== null && Date.now() - runningSince >= STABLE_UPTIME_MS) restartAttempt = 0;
  runningSince = null;
  state = "restarting";
  lastError = null;
  failedRestarts = 0;
  console.error(`[mariadb] exited unexpectedly (code ${code ?? "none"}, signal ${signal ?? "none"}); restarting`);
  void endPool();
  scheduleRestart();
}

function scheduleRestart(): void {
  if (restartTimer || !wantRunning) return;
  const delay = RESTART_BACKOFF_MS[Math.min(restartAttempt, RESTART_BACKOFF_MS.length - 1)]!;
  restartTimer = setTimeout(() => {
    restartTimer = null;
    void serialized(restartOnce);
  }, delay);
}

export function onMariaDbReady(hook: ReadyHook): () => void {
  readyHooks.push(hook);
  return () => {
    const i = readyHooks.indexOf(hook);
    if (i >= 0) readyHooks.splice(i, 1);
  };
}

async function runReadyHooks(reason: ReadyReason): Promise<void> {
  for (const hook of [...readyHooks]) {
    try {
      await hook(reason);
    } catch (err) {
      console.error("[mariadb] a post-start step failed:", errorMessage(err));
    }
  }
}

async function restartOnce(): Promise<void> {
  if (!wantRunning || state !== "restarting") return;
  restartAttempt++;
  const afterFailedStart = startFailures > 0;
  try {
    const b = await getBinaries();
    if (afterFailedStart) {
      await stopLeftoverServer();
      if (!isDataDirInitialized()) await initDataDir(b);
    }
    await boot(b);
    state = "running";
    if (!afterFailedStart) restartsTotal++;
    failedRestarts = 0;
    lastError = null;
    if (afterFailedStart) {
      console.log(`[mariadb] started after ${startFailures} failed attempt(s)`);
      startFailures = 0;
      void runReadyHooks("retry");
    } else {
      console.log(`[mariadb] restarted after unexpected exit (attempt ${restartAttempt})`);
      void runReadyHooks("restart");
    }
  } catch (err) {
    lastError = errorMessage(err);
    failedRestarts++;
    if (afterFailedStart) startFailures++;
    console.error(
      afterFailedStart ? `[mariadb] start attempt ${startFailures} failed:` : `[mariadb] restart attempt ${restartAttempt} failed:`,
      lastError,
    );
    if (wantRunning && state === "restarting") scheduleRestart();
  }
}

function clearRestartTimer(): void {
  if (restartTimer) clearTimeout(restartTimer);
  restartTimer = null;
}

export async function startMariaDb(): Promise<void> {
  wantRunning = true;
  clearRestartTimer();
  startLogTimer();
  let started = false;
  await serialized(async () => {
    if (!wantRunning) throw new Error("MariaDB start was cancelled by a stop request");
    if (state === "running" && serverProc && !hasExited(serverProc)) return;
    state = "starting";
    try {
      await endPool();
      await killServer(serverProc);
      const b = await getBinaries();
      await stopLeftoverServer();
      if (!isDataDirInitialized()) {
        console.log("[mariadb] initializing data dir at", env.mariadbDataDir);
        await initDataDir(b);
      }
      env.mariadbBind = resolveDatabaseBind().bind;
      console.log("[mariadb] starting on", `${env.mariadbBind}:${env.mariadbPort}`);
      await boot(b);
      state = "running";
      restartAttempt = 0;
      failedRestarts = 0;
      startFailures = 0;
      lastError = null;
      lastExit = null;
      started = true;
      console.log("[mariadb] ready");
    } catch (err) {
      lastError = errorMessage(err);
      lastExit = null;
      if (wantRunning) {
        state = "restarting";
        startFailures = Math.max(1, startFailures + 1);
        failedRestarts = startFailures;
        restartAttempt = 0;
        scheduleRestart();
      } else {
        state = "failed";
      }
      throw err;
    }
  });
  if (started) await runReadyHooks("start");
}

export type RebindOutcome =
  | { ok: true; bind: string; restarted: boolean }
  | { ok: false; bind: string; error: string; restored: boolean };

export async function rebindMariaDb(next: string, assertIdle: () => void = () => {}): Promise<RebindOutcome> {
  let outcome: RebindOutcome | null = null;
  await serialized(async () => {
    assertIdle();
    const previous = env.mariadbBind;
    if (!wantRunning) {
      env.mariadbBind = next;
      outcome = { ok: true, bind: next, restarted: false };
      return;
    }
    if (state !== "running" || !serverProc || hasExited(serverProc)) {
      throw new Error(`MariaDB is ${state === "running" ? "not running" : state} right now; try again when it is running`);
    }
    if (previous === next) {
      outcome = { ok: true, bind: next, restarted: false };
      return;
    }
    const b = await getBinaries();
    clearRestartTimer();
    state = "starting";
    runningSince = null;
    await endPool();
    await killServer(serverProc);
    env.mariadbBind = next;
    console.log("[mariadb] restarting on", `${next}:${env.mariadbPort}`);
    try {
      await boot(b);
      state = "running";
      lastError = null;
      outcome = { ok: true, bind: next, restarted: true };
      return;
    } catch (err) {
      const error = errorMessage(err);
      console.error(`[mariadb] MariaDB did not start on ${next}; going back to ${previous}:`, error);
      env.mariadbBind = previous;
      try {
        await boot(b);
        state = "running";
        lastError = null;
        outcome = { ok: false, bind: previous, error, restored: true };
      } catch (restoreErr) {
        lastError = errorMessage(restoreErr);
        state = "restarting";
        startFailures = Math.max(1, startFailures + 1);
        failedRestarts = startFailures;
        restartAttempt = 0;
        scheduleRestart();
        outcome = { ok: false, bind: previous, error, restored: false };
      }
    }
  });
  const result = outcome as RebindOutcome | null;
  if (!result) throw new Error("MariaDB was not restarted");
  if (result.ok ? result.restarted : result.restored) await runReadyHooks("rebind");
  return result;
}

export async function stopMariaDb(): Promise<void> {
  wantRunning = false;
  clearRestartTimer();
  stopLogTimer();
  await serialized(async () => {
    clearRestartTimer();
    const proc = serverProc;
    state = "stopping";
    await endPool();
    await killServer(proc);
    runningSince = null;
    startFailures = 0;
    state = "stopped";
  });
}

export function mariadbExpected(): boolean {
  return wantRunning;
}

export function mariadbState(): MariaDbState {
  return state;
}

export function mariadbServerPid(): number | null {
  return serverProc && !hasExited(serverProc) ? serverProc.pid : null;
}

export function getPool(): Pool {
  if (!pool) {
    if (state === "restarting") throw new Error("MariaDB is restarting after an unexpected exit");
    throw new Error("MariaDB pool not initialized");
  }
  return pool;
}

export async function withRootConnection<T>(fn: (c: PoolConnection) => Promise<T>): Promise<T> {
  const conn = await getPool().getConnection();
  try {
    return await fn(conn);
  } finally {
    conn.release();
  }
}

export async function openAdminConnection(database?: string): Promise<Connection> {
  if (state !== "running") throw new Error(`MariaDB is not running (${state})`);
  return mysql.createConnection({
    host: localConnectHost(),
    port: env.mariadbPort,
    user: env.rootUser,
    password: await rootPasswordFromSettings(),
    database,
    multipleStatements: false,
    supportBigNumbers: true,
    connectTimeout: 5000,
  });
}

function supervisorError(): string | null {
  if (state === "restarting" && startFailures > 0) {
    return `MariaDB failed to start; ${startFailures} attempt(s) failed, retrying with backoff. Last error: ${lastError ?? "unknown error"}`;
  }
  if (state === "restarting") {
    const exit = lastExit ? ` (code ${lastExit.code ?? "none"}, signal ${lastExit.signal ?? "none"})` : "";
    if (lastError) {
      return `MariaDB exited unexpectedly${exit}; ${failedRestarts} restart attempt(s) failed, retrying with backoff. Last error: ${lastError}`;
    }
    return `MariaDB exited unexpectedly${exit}; restarting`;
  }
  if (state === "failed") return `MariaDB failed to start: ${lastError ?? "unknown error"}`;
  if (state !== "running") return `MariaDB is ${state}`;
  return null;
}

export async function healthCheck(): Promise<MariaDbHealth> {
  const base = { state, restarts: restartsTotal };
  const supervisor = supervisorError();
  if (supervisor) return { ok: false, error: supervisor, ...base };
  try {
    await withRootConnection(async (c) => {
      await c.ping();
    });
    return { ok: true, ...base };
  } catch (err) {
    return { ok: false, error: String(err), ...base };
  }
}

export async function getMariaDbBinaries(): Promise<MariaDbBinaries> {
  return getBinaries();
}

export async function getRootPassword(): Promise<string> {
  return rootPasswordFromSettings();
}
