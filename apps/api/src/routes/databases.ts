import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { DatabaseCredentials, DatabaseKind } from "@kilndb/shared";
import { audit, databases, syncJobs } from "../db/queries";
import { requireAuth, requireDbAccess, type AuthVariables } from "../auth/middleware";
import {
  createDatabaseAndUser,
  dropDatabaseAndUser,
  rotatePassword,
  updateAllowedHost,
} from "../mariadb/manager";
import { decryptSecret, encryptSecret } from "../util/crypto";
import {
  deriveSchemaName,
  generateMysqlUser,
  generatePassword,
} from "../util/credentials";
import { buildConnectionStrings } from "../util/connstr";
import { newId } from "../util/id";
import { env } from "../env";
import { tailscaleStatus } from "../tailscale/cli";

export const databasesRoute = new Hono<{ Variables: AuthVariables }>();

databasesRoute.use("*", requireAuth);

databasesRoute.get("/", (c) => {
  const user = c.get("user");
  // admin + viewer see all DBs (viewers read-only); db_owner only sees their own.
  const list = user.role === "db_owner" ? databases.listForUser(user.id) : databases.list();
  return c.json({ databases: list });
});

databasesRoute.post("/", async (c) => {
  const user = c.get("user");
  if (user.role === "viewer") {
    throw new HTTPException(403, { message: "viewers cannot create databases" });
  }
  const body = (await c.req.json()) as {
    displayName?: string;
    kind?: DatabaseKind;
    connectionsFrom?: string;
    tailnetOnly?: boolean;
  };
  if (!body.displayName?.trim()) {
    throw new HTTPException(400, { message: "displayName required" });
  }
  const kind: DatabaseKind = body.kind === "mirror" ? "mirror" : "standard";
  const tailnetOnly = body.tailnetOnly === true;
  const connectionsFrom = tailnetOnly
    ? "100.%"
    : (body.connectionsFrom?.trim() || "%");

  const schemaBase = deriveSchemaName(body.displayName);
  let schema = schemaBase;
  let attempt = 0;
  while (databases.byName(schema)) {
    attempt++;
    schema = `${schemaBase}_${attempt}`;
    if (attempt > 100) throw new HTTPException(500, { message: "could not allocate schema name" });
  }
  const mysqlUser = generateMysqlUser(schema);
  const password = generatePassword();

  await createDatabaseAndUser({ schema, user: mysqlUser, password, connectionsFrom });

  const id = newId("db");
  databases.insert({
    id,
    name: schema,
    displayName: body.displayName.trim(),
    ownerUserId: user.id,
    kind,
    mysqlUser,
    mysqlPasswordEnc: await encryptSecret(password),
    connectionsFrom,
    tailscaleExposed: tailnetOnly,
    lanExposed: !tailnetOnly,
  });
  audit.log(user.id, "db.create", id, { name: schema, kind });

  const ts = tailnetOnly ? await tailscaleStatus().catch(() => null) : null;
  const host = tailnetOnly && ts?.tailnetIp ? ts.tailnetIp : env.mariadbBind;
  const credentials: DatabaseCredentials = buildConnectionStrings({
    host,
    port: env.mariadbPort,
    schema,
    user: mysqlUser,
    password,
  });

  const created = databases.byId(id);
  return c.json({ database: created ? stripEnc(created) : null, credentials });
});

function stripEnc<T extends { mysqlPasswordEnc?: string }>(row: T): Omit<T, "mysqlPasswordEnc"> {
  const { mysqlPasswordEnc: _strip, ...rest } = row;
  void _strip;
  return rest;
}

databasesRoute.get("/:id", requireDbAccess("id", "read"), (c) => {
  const row = databases.byId(c.req.param("id"));
  if (!row) throw new HTTPException(404, { message: "not found" });
  return c.json({ database: stripEnc(row) });
});

databasesRoute.patch("/:id", requireDbAccess("id", "write"), async (c) => {
  const id = c.req.param("id");
  const existing = databases.byId(id);
  if (!existing) throw new HTTPException(404, { message: "not found" });
  const body = (await c.req.json()) as {
    displayName?: string;
    connectionsFrom?: string;
    tailscaleExposed?: boolean;
    lanExposed?: boolean;
  };
  if (body.connectionsFrom !== undefined && body.connectionsFrom !== existing.connectionsFrom) {
    const pw = await decryptSecret(existing.mysqlPasswordEnc);
    await updateAllowedHost({
      user: existing.mysqlUser,
      oldHost: existing.connectionsFrom,
      newHost: body.connectionsFrom,
      password: pw,
      schema: existing.name,
    });
  }
  databases.update(id, {
    displayName: body.displayName,
    connectionsFrom: body.connectionsFrom,
    tailscaleExposed: body.tailscaleExposed,
    lanExposed: body.lanExposed,
  });
  audit.log(c.get("user").id, "db.update", id, body);
  const updated = databases.byId(id);
  return c.json({ database: updated ? stripEnc(updated) : null });
});

databasesRoute.delete("/:id", requireDbAccess("id", "owner"), async (c) => {
  const id = c.req.param("id");
  const row = databases.byId(id);
  if (!row) throw new HTTPException(404, { message: "not found" });
  syncJobs.deleteByDatabaseId(id);
  await dropDatabaseAndUser({
    schema: row.name,
    user: row.mysqlUser,
    connectionsFrom: row.connectionsFrom,
  });
  databases.delete(id);
  audit.log(c.get("user").id, "db.delete", id, { name: row.name });
  return c.json({ ok: true });
});

databasesRoute.post("/:id/rotate-password", requireDbAccess("id", "write"), async (c) => {
  const id = c.req.param("id");
  const row = databases.byId(id);
  if (!row) throw new HTTPException(404, { message: "not found" });
  const newPw = generatePassword();
  await rotatePassword({
    user: row.mysqlUser,
    connectionsFrom: row.connectionsFrom,
    newPassword: newPw,
  });
  databases.updatePassword(id, await encryptSecret(newPw));
  audit.log(c.get("user").id, "db.rotate-password", id, null);
  const credentials: DatabaseCredentials = buildConnectionStrings({
    host: env.mariadbBind,
    port: env.mariadbPort,
    schema: row.name,
    user: row.mysqlUser,
    password: newPw,
  });
  return c.json({ credentials });
});
