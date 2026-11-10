import { bootDataDir, isInsideTestRoot, testRoot } from "./isolate";
import { harnessState, type InstanceLease } from "./state";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

export interface TestInstance {
  dataDir: string;
  mariadbPort: number;
  stop(): Promise<void>;
}

export interface TestDatabase {
  schema: string;
  user: string;
  password: string;
}

const SERVER_NAMES = ["mariadbd", "mysqld"];
const TOOL_NAMES = [
  ["mariadb", "mysql"],
  ["mariadb-dump", "mysqldump"],
  ["mariadb-install-db", "mysql_install_db"],
];
const EXTRA_PATHS = ["/opt/homebrew/opt/mariadb/bin", "/opt/homebrew/bin", "/usr/local/bin", "/usr/sbin", "/usr/bin"];

function findBinary(names: string[]): boolean {
  for (const n of names) {
    if (Bun.which(n)) return true;
    if (EXTRA_PATHS.some((d) => existsSync(join(d, n)))) return true;
  }
  return false;
}

export function mariadbAvailable(): boolean {
  if (process.env.LAMBDATA_SKIP_MARIADB_TESTS === "1") return false;
  return findBinary(SERVER_NAMES) && TOOL_NAMES.every(findBinary);
}

export function testTmpRoot(): string {
  const root = testRoot();
  mkdirSync(root, { recursive: true, mode: 0o700 });
  return root;
}

async function modules() {
  const [pointer, envMod, client, migrations, controller, manager, credentials, id] = await Promise.all([
    import("../../src/util/pointer"),
    import("../../src/env"),
    import("../../src/db/client"),
    import("../../src/db/migrate"),
    import("../../src/mariadb/controller"),
    import("../../src/mariadb/manager"),
    import("../../src/util/credentials"),
    import("../../src/util/id"),
  ]);
  if (!isInsideTestRoot(pointer.POINTER_DIR)) {
    throw new Error(
      "test/harness/instance.ts must be imported before any src module, otherwise the API reads the real pointer file",
    );
  }
  return { envMod, client, migrations, controller, manager, credentials, id };
}

async function freePort(): Promise<number> {
  const listener = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const port = listener.port;
  listener.stop(true);
  return port;
}

interface Shared {
  dataDir: string;
  mariadbPort: number;
  refs: number;
  lease: InstanceLease;
}

const PORT_ATTEMPTS = 3;
const PORT_TAKEN = /Address already in use|served by another MariaDB or MySQL server/;

let shared: Shared | null = null;
let chain: Promise<unknown> = Promise.resolve();
let counter = 0;

function serial<T>(fn: () => Promise<T>): Promise<T> {
  const run = chain.then(fn, fn);
  chain = run.catch(() => {});
  return run;
}

function handle(s: Shared): TestInstance {
  let stopped = false;
  return {
    dataDir: s.dataDir,
    mariadbPort: s.mariadbPort,
    stop() {
      if (stopped) return Promise.resolve();
      stopped = true;
      return release(s);
    },
  };
}

async function settleMetadataAfterStop(lease: InstanceLease): Promise<void> {
  const m = await modules();
  const metadata = harnessState.metadata;
  if (metadata && !metadata.released && metadata.dataDir === lease.dataDir) return;
  m.client.closeDb();
  m.envMod.setDataDir(bootDataDir());
  m.client.reopenDb();
  if (lease.removeDirOnStop && isInsideTestRoot(lease.dataDir)) {
    rmSync(lease.dataDir, { recursive: true, force: true });
  }
}

async function shutdown(s: Shared): Promise<void> {
  shared = null;
  const m = await modules();
  try {
    await m.controller.stopMariaDb();
  } finally {
    if (harnessState.instance === s.lease) harnessState.instance = null;
    await settleMetadataAfterStop(s.lease);
  }
}

function release(s: Shared): Promise<void> {
  return serial(async () => {
    s.refs--;
    if (s.refs > 0 || shared !== s) return;
    await shutdown(s);
  });
}

export function stopAllTestInstances(): Promise<void> {
  return serial(async () => {
    if (shared) await shutdown(shared);
  });
}

export function startTestInstance(opts: { dataDir?: string } = {}): Promise<TestInstance> {
  return serial(async () => {
    if (shared) {
      if (opts.dataDir && opts.dataDir !== shared.dataDir) {
        throw new Error("another test instance is running with a different data directory; stop it first");
      }
      shared.refs++;
      return handle(shared);
    }
    if (!mariadbAvailable()) throw new Error("MariaDB binaries are not installed");
    const m = await modules();
    const metadata = harnessState.metadata;
    const adopt =
      !opts.dataDir && metadata !== null && !metadata.released && metadata.dataDir === m.envMod.env.dataDir;
    const dataDir = adopt ? metadata!.dataDir : (opts.dataDir ?? join(testTmpRoot(), `i${++counter}`));
    const lease: InstanceLease = { dataDir, removeDirOnStop: !adopt && isInsideTestRoot(dataDir) };
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    if (!adopt) {
      m.client.closeDb();
      m.envMod.setDataDir(dataDir);
      m.client.reopenDb();
    }
    m.migrations.migrate();
    harnessState.instance = lease;
    let mariadbPort = 0;
    for (let attempt = 1; ; attempt++) {
      mariadbPort = await freePort();
      m.envMod.env.mariadbPort = mariadbPort;
      try {
        await m.controller.startMariaDb();
        break;
      } catch (err) {
        await m.controller.stopMariaDb().catch(() => {});
        if (attempt < PORT_ATTEMPTS && PORT_TAKEN.test(String((err as Error)?.message ?? err))) continue;
        harnessState.instance = null;
        await settleMetadataAfterStop(lease);
        throw err;
      }
    }
    shared = { dataDir, mariadbPort, refs: 1, lease };
    return handle(shared);
  });
}

export async function createTestDatabase(name?: string): Promise<TestDatabase> {
  const m = await modules();
  const schema = name ?? `t_${m.id.randAlphaNum(10)}`;
  const user = m.credentials.generateMysqlUser(schema);
  const password = m.credentials.generatePassword();
  await m.manager.createDatabaseAndUser({ schema, user, password, connectionsFrom: "%" });
  return { schema, user, password };
}

export async function rootQuery<T = unknown>(sql: string, params?: unknown[]): Promise<T[]> {
  const m = await modules();
  const [rows] = await m.controller.getPool().query(sql, params);
  return (Array.isArray(rows) ? rows : [rows]) as T[];
}
