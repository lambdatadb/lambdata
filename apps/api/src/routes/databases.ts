import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import type { DatabaseCredentials } from "@lambdata/shared";
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
  return c.json({ databases: list });
});

databasesRoute.post("/", async (c) => {
  const user = c.get("user");
  if (user.role === "viewer") {
    throw new HTTPException(403, { message: "viewers cannot create databases" });
  }
  const body = await parseJson(c, createSchema);
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
  return c.json({ database, credentials });
});

databasesRoute.get("/:id", requireDbAccess("id", "read"), (c) => {
  const row = databases.byId(c.req.param("id"));
  if (!row) throw new HTTPException(404, { message: "not found" });
  return c.json({ database: publicDatabase(row) });
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
    host: await connectionHost(row.tailscaleExposed && !row.lanExposed),
    port: env.mariadbPort,
    schema: row.name,
    user: row.mysqlUser,
    password: newPw,
  });
  return c.json({ credentials });
});
