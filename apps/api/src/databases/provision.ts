import { existsSync } from "node:fs";
import { readdir, rm, unlink } from "node:fs/promises";
import { basename, join, resolve, sep } from "node:path";
import { HTTPException } from "hono/http-exception";
import type { RowDataPacket } from "mysql2/promise";
import type { Database, DatabaseCredentials, DatabaseKind } from "@lambdata/shared";
import { databases, snapshots, syncJobs } from "../db/queries";
import { db } from "../db/client";
import { createDatabaseAndUser, dropDatabaseAndUser } from "../mariadb/manager";
import { withRootConnection } from "../mariadb/controller";
import { dropReadonlyAccount, ensureReadonlyAccount } from "../mariadb/readonly";
import { encryptSecret } from "../util/crypto";
import { deriveSchemaName, generateMysqlUser, generatePassword } from "../util/credentials";
import { buildConnectionStrings } from "../util/connstr";
import { isSafeHostPattern } from "../util/ident";
import { newId } from "../util/id";
import { env } from "../env";
import { tailscaleStatus } from "../tailscale/cli";
import { runExclusive, sanitizeErrorMessage } from "../jobs";

export interface ProvisionDatabaseInput {
  displayName: string;
  kind?: DatabaseKind;
  connectionsFrom?: string;
  tailnetOnly?: boolean;
  versioned?: boolean;
  showInVitals?: boolean;
  ownerUserId: string;
}

export interface ProvisionDatabaseResult {
  database: Database;
  credentials: DatabaseCredentials;
}

const SYSTEM_SCHEMAS = new Set(["mysql", "information_schema", "performance_schema", "sys", "test"]);
const TAILNET_HOST_PATTERN = "100.%";
const MAX_NAME_ATTEMPTS = 1000;

let allocationChain: Promise<void> = Promise.resolve();

function serializeAllocation<T>(fn: () => Promise<T>): Promise<T> {
  const run = allocationChain.then(fn, fn);
  allocationChain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

export function publicDatabase(row: Database & { mysqlPasswordEnc?: string }): Database {
  const { mysqlPasswordEnc: _strip, ...rest } = row;
  void _strip;
  return rest;
}

export async function listMariaDbSchemas(): Promise<Set<string>> {
  return withRootConnection(async (c) => {
    const [rows] = await c.query<RowDataPacket[]>("SELECT SCHEMA_NAME AS name FROM information_schema.SCHEMATA");
    return new Set(rows.map((r) => String(r.name).toLowerCase()));
  });
}

async function listMariaDbUsers(): Promise<Set<string>> {
  return withRootConnection(async (c) => {
    const [rows] = await c.query<RowDataPacket[]>("SELECT DISTINCT User AS name FROM mysql.user");
    return new Set(rows.map((r) => String(r.name)));
  });
}

async function mariaDbSnapshot(): Promise<{ schemas: Set<string>; users: Set<string> }> {
  try {
    const [schemas, users] = await Promise.all([listMariaDbSchemas(), listMariaDbUsers()]);
    return { schemas, users };
  } catch (err) {
    throw new HTTPException(503, { message: `MariaDB is not available: ${sanitizeErrorMessage(err)}` });
  }
}

function allocateSchemaName(displayName: string, taken: Set<string>): string {
  const base = deriveSchemaName(displayName);
  const isFree = (name: string) => !SYSTEM_SCHEMAS.has(name) && !taken.has(name.toLowerCase());
  if (isFree(base)) return base;
  for (let attempt = 1; attempt <= MAX_NAME_ATTEMPTS; attempt++) {
    const candidate = `${base}_${attempt}`;
    if (isFree(candidate)) return candidate;
  }
  throw new HTTPException(500, { message: "could not allocate a schema name" });
}

export async function connectionHost(tailnetOnly: boolean): Promise<string> {
  if (!tailnetOnly) return env.mariadbBind;
  const ts = await tailscaleStatus().catch(() => null);
  return ts?.tailnetIp ?? env.mariadbBind;
}

export async function provisionDatabase(input: ProvisionDatabaseInput): Promise<ProvisionDatabaseResult> {
  const displayName = input.displayName.trim();
  if (!displayName) throw new HTTPException(400, { message: "displayName required" });
  const kind: DatabaseKind = input.kind === "mirror" ? "mirror" : "standard";
  const tailnetOnly = input.tailnetOnly === true;
  const connectionsFrom = tailnetOnly ? TAILNET_HOST_PATTERN : input.connectionsFrom?.trim() || "%";
  if (!isSafeHostPattern(connectionsFrom)) {
    throw new HTTPException(400, { message: "connectionsFrom must be a MariaDB host pattern such as % or 192.168.1.%" });
  }
  const password = generatePassword();
  const passwordEnc = await encryptSecret(password);

  const reserved = await serializeAllocation(async () => {
    const live = await mariaDbSnapshot();
    return db.transaction(() => {
      const taken = new Set([...live.schemas, ...databases.allNames().map((n) => n.toLowerCase())]);
      const schema = allocateSchemaName(displayName, taken);
      const mysqlUser = generateMysqlUser(
        schema,
        (user) => live.users.has(user) || databases.mysqlUserExists(user),
      );
      const id = newId("db");
      databases.insert({
        id,
        name: schema,
        displayName,
        ownerUserId: input.ownerUserId,
        kind,
        mysqlUser,
        mysqlPasswordEnc: passwordEnc,
        connectionsFrom,
        tailscaleExposed: tailnetOnly,
        lanExposed: !tailnetOnly,
        versioned: input.versioned === true,
        showInVitals: input.showInVitals !== false,
        provisionState: "creating",
      });
      return { id, schema, mysqlUser };
    })();
  });

  try {
    await createDatabaseAndUser({
      schema: reserved.schema,
      user: reserved.mysqlUser,
      password,
      connectionsFrom,
    });
    await ensureReadonlyAccount(reserved.id);
  } catch (err) {
    const message = sanitizeErrorMessage(err);
    try {
      await dropReadonlyAccount(reserved.id);
      await dropDatabaseAndUser({ schema: reserved.schema, user: reserved.mysqlUser, connectionsFrom });
      databases.delete(reserved.id);
    } catch (cleanupErr) {
      console.error(
        `[provision] could not roll back ${reserved.schema}; startup reconciliation will retry:`,
        sanitizeErrorMessage(cleanupErr),
      );
    }
    throw new HTTPException(503, { message: `could not create the database in MariaDB: ${message}` });
  }

  databases.setProvisionState(reserved.id, null);
  const row = databases.byId(reserved.id);
  if (!row) throw new HTTPException(500, { message: "database row disappeared during provisioning" });
  const credentials = buildConnectionStrings({
    host: await connectionHost(tailnetOnly),
    port: env.mariadbPort,
    schema: reserved.schema,
    user: reserved.mysqlUser,
    password,
  });
  return { database: publicDatabase(row), credentials };
}

function isInside(child: string, parent: string): boolean {
  const p = resolve(parent);
  return resolve(child).startsWith(p.endsWith(sep) ? p : `${p}${sep}`);
}

export async function removeDatabaseFiles(id: string, legacyFilePaths: string[]): Promise<void> {
  if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new Error(`unsafe database id: ${id}`);
  await rm(join(env.checkpointsDir, id), { recursive: true, force: true });
  const candidates = new Set<string>();
  for (const stored of legacyFilePaths) {
    if (isInside(stored, env.snapshotsDir)) candidates.add(resolve(stored));
    candidates.add(join(env.snapshotsDir, basename(stored)));
  }
  if (existsSync(env.snapshotsDir)) {
    for (const name of await readdir(env.snapshotsDir)) {
      if (name.startsWith(`${id}_`) && name.endsWith(".sql")) candidates.add(join(env.snapshotsDir, name));
    }
  }
  for (const path of candidates) {
    if (!isInside(path, env.snapshotsDir)) continue;
    await unlink(path).catch((err: NodeJS.ErrnoException) => {
      if (err.code !== "ENOENT") throw err;
    });
  }
}

export async function completeDeprovision(row: {
  id: string;
  name: string;
  mysqlUser: string;
  connectionsFrom: string;
}): Promise<void> {
  const legacyFiles = snapshots.list(row.id).map((s) => s.filePath);
  await dropReadonlyAccount(row.id);
  await dropDatabaseAndUser({ schema: row.name, user: row.mysqlUser, connectionsFrom: row.connectionsFrom });
  await removeDatabaseFiles(row.id, legacyFiles);
  databases.delete(row.id);
}

export async function deprovisionDatabase(id: string): Promise<void> {
  await runExclusive(id, async () => {
    const row = databases.byId(id);
    if (!row) throw new HTTPException(404, { message: "database not found" });
    db.transaction(() => {
      databases.setProvisionState(id, "deleting");
      syncJobs.deleteByDatabaseId(id);
    })();
    try {
      await completeDeprovision(row);
    } catch (err) {
      throw new HTTPException(503, {
        message: `could not finish deleting the database (it stays marked as deleting and will be retried): ${sanitizeErrorMessage(err)}`,
      });
    }
  });
}
