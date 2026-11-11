import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import type { Context } from "hono";
import type {
  Database,
  DatabaseConnectionInfo,
  DatabaseCredentials,
  EnsureDatabaseResponse,
  User,
} from "@lambdata/shared";
import { audit, databases } from "../db/queries";
import { requireAuth, requireDbAccess, type AuthVariables } from "../auth/middleware";
import { rotatePassword, updateAllowedHost } from "../mariadb/manager";
import { decryptSecret, encryptSecret } from "../util/crypto";
import { generatePassword } from "../util/credentials";
import { buildConnectionStrings } from "../util/connstr";
import { isSafeHostPattern } from "../util/ident";
import { parseJson } from "../util/validate";
import { env } from "../env";
import { connectionHost, deprovisionDatabase, provisionDatabase, publicDatabase } from "../databases/provision";
import { runExclusive } from "../jobs";
import { databasePortStatus } from "../connections/databasePort";
import {
  currentAccessToken,
  mayRevealCredentials,
  reserveDatabaseSlot,
  tokenCanSeeDatabase,
  visibleToRequest,
} from "../accessTokens/index";

export const databasesRoute = new Hono<{ Variables: AuthVariables }>();

databasesRoute.use("*", requireAuth);

const hostPattern = z
  .string()
  .trim()
  .min(1)
  .max(255)
  .refine(isSafeHostPattern, "must be a MariaDB host pattern such as % or 192.168.1.%");

const createSchema = z.object({
  displayName: z.string().trim().min(1, "displayName required").max(200),
  kind: z.enum(["standard", "mirror"]).optional(),
  connectionsFrom: z.union([hostPattern, z.literal("")]).optional(),
  tailnetOnly: z.boolean().optional(),
  versioned: z.boolean().optional(),
  showInVitals: z.boolean().optional(),
  ensure: z.boolean().optional(),
});

const patchSchema = z.object({
  displayName: z.string().trim().min(1).max(200).optional(),
  connectionsFrom: hostPattern.optional(),
  tailscaleExposed: z.boolean().optional(),
  lanExposed: z.boolean().optional(),
  versioned: z.boolean().optional(),
  showInVitals: z.boolean().optional(),
});

databasesRoute.get("/", (c) => {
  const user = c.get("user");
  const list = user.role === "db_owner" ? databases.listForUser(user.id) : databases.list();
  return c.json({ databases: visibleToRequest(c, list) });
});

function normalizedName(name: string): string {
  return name.trim().toLowerCase();
}

function canSee(c: Context, user: User, row: Database): boolean {
  const req = currentAccessToken(c);
  if (req) return tokenCanSeeDatabase(req.token, row);
  if (user.role === "admin") return true;
  return user.role === "db_owner" && row.ownerUserId === user.id;
}

function createdByCaller(c: Context, user: User, row: Database): boolean {
  const req = currentAccessToken(c);
  if (req) return row.createdByTokenId === req.token.id;
  return row.ownerUserId === user.id && !row.createdByTokenId;
}

function creatorOf(row: Database): string {
  if (row.createdByTokenName) return `the access token “${row.createdByTokenName}”`;
  if (row.createdByTokenId) return "an access token";
  return row.ownerDisplayName ? row.ownerDisplayName : "another person";
}

function sameNamed(displayName: string): Database[] {
  const wanted = normalizedName(displayName);
  return databases
    .list()
    .filter((d) => d.status !== "deleting" && normalizedName(d.displayName) === wanted)
    .sort((a, b) => a.createdAt - b.createdAt);
}

const ensureLocks = new Map<string, Promise<unknown>>();

async function withEnsureLock<T>(name: string, fn: () => Promise<T>): Promise<T> {
  const key = normalizedName(name);
  const previous = ensureLocks.get(key) ?? Promise.resolve();
  const run = previous.then(fn, fn);
  const settled = run.then(
    () => undefined,
    () => undefined,
  );
  ensureLocks.set(key, settled);
  try {
    return await run;
  } finally {
    if (ensureLocks.get(key) === settled) ensureLocks.delete(key);
  }
}

databasesRoute.post("/", async (c) => {
  const user = c.get("user");
  if (user.role === "viewer") {
    throw new HTTPException(403, { message: "viewers cannot create databases" });
  }
  const body = await parseJson(c, createSchema);
  const create = async (): Promise<EnsureDatabaseResponse> => {
    const release = reserveDatabaseSlot(c);
    try {
      const { database, credentials } = await provisionDatabase({
        displayName: body.displayName,
        kind: body.kind,
        connectionsFrom: body.connectionsFrom || undefined,
        tailnetOnly: body.tailnetOnly,
        versioned: body.versioned,
        showInVitals: body.showInVitals,
        ownerUserId: user.id,
      });
      audit.log(user.id, "db.create", database.id, { name: database.name, kind: database.kind });
      const fresh = databases.byId(database.id);
      return {
        database: fresh ? publicDatabase(fresh) : database,
        credentials: mayRevealCredentials(c) ? credentials : null,
        created: true,
      };
    } finally {
      release();
    }
  };
  if (body.ensure !== true) {
    const { database, credentials } = await create();
    return c.json({ database, credentials });
  }
  const res = await withEnsureLock(body.displayName, async () => {
    const name = body.displayName.trim();
    const matches = sameNamed(body.displayName);
    const mine = matches.find((d) => createdByCaller(c, user, d));
    if (mine) {
      const ensured: EnsureDatabaseResponse = { database: mine, credentials: null, created: false };
      return ensured;
    }
    const visible = matches.find((d) => canSee(c, user, d));
    if (visible) {
      throw new HTTPException(409, {
        message: `A database named ${visible.displayName} already exists (id ${visible.id}), created by ${creatorOf(visible)}. If it is the one you want, use it directly by its id; otherwise choose another name.`,
      });
    }
    if (!currentAccessToken(c) && matches.length > 0) {
      throw new HTTPException(409, {
        message: `A database named ${name} already exists and you cannot manage it. Choose another name.`,
      });
    }
    return create();
  });
  return c.json(res, 200);
});

const WILDCARD_HOSTS = new Set(["", "0.0.0.0", "::", "[::]", "*"]);

async function connectionInfo(row: Database): Promise<DatabaseConnectionInfo> {
  const port = databasePortStatus();
  let host: string | null = null;
  if (port.outsideConnections) {
    const candidate = (await connectionHost(row.tailscaleExposed && !row.lanExposed)).trim();
    host = WILDCARD_HOSTS.has(candidate) ? null : candidate;
  }
  return { host, port: port.port, outsideConnections: port.outsideConnections };
}

databasesRoute.get("/:id", requireDbAccess("id", "read"), async (c) => {
  const row = databases.byId(c.req.param("id"));
  if (!row) throw new HTTPException(404, { message: "not found" });
  const database = publicDatabase(row);
  return c.json({ database, connection: await connectionInfo(database) });
});

databasesRoute.patch("/:id", requireDbAccess("id", "write"), async (c) => {
  const id = c.req.param("id");
  const existing = databases.byId(id);
  if (!existing) throw new HTTPException(404, { message: "not found" });
  const body = await parseJson(c, patchSchema);
  const warnings: string[] = [];
  const hostChange = body.connectionsFrom !== undefined && body.connectionsFrom !== existing.connectionsFrom;
  const apply = async () => {
    const current = databases.byId(id) ?? existing;
    if (body.connectionsFrom !== undefined && body.connectionsFrom !== current.connectionsFrom) {
      const pw = await decryptSecret(current.mysqlPasswordEnc);
      const moved = await updateAllowedHost({
        user: current.mysqlUser,
        oldHost: current.connectionsFrom,
        newHost: body.connectionsFrom,
        password: pw,
        schema: current.name,
        databaseId: id,
      });
      warnings.push(...moved.warnings);
    }
    databases.update(id, body);
  };
  if (hostChange) await runExclusive(id, apply);
  else await apply();
  audit.log(c.get("user").id, "db.update", id, warnings.length > 0 ? { ...body, warnings } : body);
  const updated = databases.byId(id);
  return c.json({ database: updated ? publicDatabase(updated) : null, warnings });
});

databasesRoute.delete("/:id", requireDbAccess("id", "owner"), async (c) => {
  const id = c.req.param("id");
  const row = databases.byId(id);
  if (!row) throw new HTTPException(404, { message: "not found" });
  await deprovisionDatabase(id);
  audit.log(c.get("user").id, "db.delete", id, { name: row.name });
  return c.json({ ok: true });
});

databasesRoute.get("/:id/credentials", requireDbAccess("id", "owner"), async (c) => {
  const id = c.req.param("id");
  const row = databases.byId(id);
  if (!row) throw new HTTPException(404, { message: "not found" });
  if (!mayRevealCredentials(c)) {
    throw new HTTPException(403, { message: "This access token may not see database passwords." });
  }
  const credentials: DatabaseCredentials = buildConnectionStrings({
    host: await connectionHost(row.tailscaleExposed && !row.lanExposed),
    port: env.mariadbPort,
    schema: row.name,
    user: row.mysqlUser,
    password: await decryptSecret(row.mysqlPasswordEnc),
  });
  audit.log(c.get("user").id, "db.credentials.read", id, null);
  return c.json({ credentials });
});

databasesRoute.post("/:id/rotate-password", requireDbAccess("id", "write"), async (c) => {
  const id = c.req.param("id");
  const row = databases.byId(id);
  if (!row) throw new HTTPException(404, { message: "not found" });
  if (!mayRevealCredentials(c)) {
    throw new HTTPException(403, { message: "This access token may not see database passwords." });
  }
  const newPw = generatePassword();
  await rotatePassword({
    user: row.mysqlUser,
    connectionsFrom: row.connectionsFrom,
    newPassword: newPw,
  });
  databases.updatePassword(id, await encryptSecret(newPw));
  audit.log(c.get("user").id, "db.rotate-password", id, null);
  const credentials: DatabaseCredentials = buildConnectionStrings({
    host: await connectionHost(row.tailscaleExposed && !row.lanExposed),
    port: env.mariadbPort,
    schema: row.name,
    user: row.mysqlUser,
    password: newPw,
  });
  return c.json({ credentials });
});
