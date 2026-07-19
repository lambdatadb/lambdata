import { existsSync, readdirSync, openSync } from "node:fs";
import { join } from "node:path";
import mysql, { type Connection, type Pool, type PoolConnection } from "mysql2/promise";
import { env } from "../env";
import { settings } from "../db/queries";
import { encryptSecret, decryptSecret } from "../util/crypto";
import { generatePassword } from "../util/credentials";
import { locateBinaries, type MariaDbBinaries } from "./installer";

let pool: Pool | null = null;
let serverProc: ReturnType<typeof Bun.spawn> | null = null;
let binaries: MariaDbBinaries | null = null;

async function getBinaries(): Promise<MariaDbBinaries> {
  if (!binaries) binaries = await locateBinaries();
  return binaries;
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
  });
  const exit = await proc.exited;
  if (exit !== 0) {
    const err = await new Response(proc.stderr).text();
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

// Credential ladder: stored system root pw (normal boots), empty root pw
// (fresh datadir before hardening runs), kilndb_root (can repair root).
async function connectAsSuperuser(): Promise<Connection> {
  const candidates: { user: string; password: string }[] = [];
  const systemStored = settings.get("mariadb_system_root_password_enc");
  if (systemStored) candidates.push({ user: "root", password: await decryptSecret(systemStored) });
  candidates.push({ user: "root", password: "" });
  const kilndbStored = settings.get("mariadb_root_password_enc");
  if (kilndbStored) candidates.push({ user: env.rootUser, password: await decryptSecret(kilndbStored) });
  let lastErr: unknown = null;
  for (const cred of candidates) {
    try {
      return await mysql.createConnection({
        host: env.mariadbBind,
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

function logFilePath(): string {
  return join(env.logsDir, "mariadb.log");
}

async function spawnServer(b: MariaDbBinaries): Promise<void> {
  const logFd = openSync(logFilePath(), "a");
  serverProc = Bun.spawn(
    [
      b.server,
      `--datadir=${env.mariadbDataDir}`,
      `--port=${env.mariadbPort}`,
      `--bind-address=${env.mariadbBind}`,
      `--socket=${join(env.mariadbDataDir, "mariadb.sock")}`,
      "--skip-name-resolve",
      "--default-authentication-plugin=mysql_native_password",
    ],
    {
      cwd: env.dataDir,
      stdout: logFd,
      stderr: logFd,
      onExit(_p, code) {
        if (code !== null && code !== 0) {
          console.error(`[mariadb] exited with code ${code}`);
        }
      },
    },
  );
}

async function waitForReady(timeoutMs = 30_000): Promise<void> {
  const start = Date.now();
  let lastErr: unknown = null;
  while (Date.now() - start < timeoutMs) {
    try {
      const conn = await connectAsSuperuser();
      await conn.ping();
      await conn.end();
      return;
    } catch (err) {
      lastErr = err;
      await Bun.sleep(500);
    }
  }
  throw new Error(`MariaDB did not become ready: ${String(lastErr)}`);
}

async function ensureRootUser(rootPw: string): Promise<void> {
  const conn = await connectAsSuperuser();
  try {
    for (const host of ["localhost", "127.0.0.1"]) {
      await conn.query(
        `CREATE USER IF NOT EXISTS ?@? IDENTIFIED BY ?`,
        [env.rootUser, host, rootPw],
      );
      await conn.query(`ALTER USER ?@? IDENTIFIED BY ?`, [env.rootUser, host, rootPw]);
      await conn.query(`GRANT ALL PRIVILEGES ON *.* TO ?@? WITH GRANT OPTION`, [
        env.rootUser,
        host,
      ]);
    }
    await conn.query("FLUSH PRIVILEGES");
  } finally {
    await conn.end();
  }
}

async function ensureRootPassword(systemRootPw: string): Promise<void> {
  const conn = await connectAsSuperuser();
  try {
    const [rows] = await conn.query(`SELECT Host AS host FROM mysql.user WHERE User = 'root'`);
    for (const row of rows as { host: string }[]) {
      if (!row.host) continue;
      try {
        await conn.query(`ALTER USER ?@? IDENTIFIED BY ?`, ["root", row.host, systemRootPw]);
      } catch (err) {
        console.warn(
          `[mariadb] skipping unmanageable root@${row.host}:`,
          err instanceof Error ? err.message : String(err),
        );
      }
    }
    await conn.query("FLUSH PRIVILEGES");
  } finally {
    await conn.end();
  }
}

async function buildPool(rootPw: string): Promise<Pool> {
  return mysql.createPool({
    host: env.mariadbBind,
    port: env.mariadbPort,
    user: env.rootUser,
    password: rootPw,
    waitForConnections: true,
    connectionLimit: 8,
    multipleStatements: false,
  });
}

export async function startMariaDb(): Promise<void> {
  const b = await getBinaries();
  if (!isDataDirInitialized()) {
    console.log("[mariadb] initializing data dir at", env.mariadbDataDir);
    await initDataDir(b);
  }
  console.log("[mariadb] starting on", `${env.mariadbBind}:${env.mariadbPort}`);
  await spawnServer(b);
  await waitForReady();
  const rootPw = await rootPasswordFromSettings();
  await ensureRootUser(rootPw);
  await ensureRootPassword(await systemRootPasswordFromSettings());
  pool = await buildPool(rootPw);
  console.log("[mariadb] ready");
}

export async function stopMariaDb(): Promise<void> {
  if (pool) {
    await pool.end().catch(() => {});
    pool = null;
  }
  if (!serverProc) return;
  const b = await getBinaries();
  const rootPw = await rootPasswordFromSettings();
  const proc = Bun.spawn(
    [
      b.admin,
      `--host=${env.mariadbBind}`,
      `--port=${env.mariadbPort}`,
      `--user=${env.rootUser}`,
      "shutdown",
    ],
    { stdout: "pipe", stderr: "pipe", env: { ...process.env, MYSQL_PWD: rootPw } },
  );
  await proc.exited;
  await serverProc.exited.catch(() => {});
  serverProc = null;
}

export function getPool(): Pool {
  if (!pool) throw new Error("MariaDB pool not initialized");
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

export async function healthCheck(): Promise<{ ok: boolean; error?: string }> {
  try {
    await withRootConnection(async (c) => {
      await c.ping();
    });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

export async function getMariaDbBinaries(): Promise<MariaDbBinaries> {
  return getBinaries();
}

export async function getRootPassword(): Promise<string> {
  return rootPasswordFromSettings();
}
