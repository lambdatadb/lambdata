import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { audit, databases } from "../db/queries";
import { requireAuth, requireDbAccess, type AuthVariables } from "../auth/middleware";
import { executeUserQuery } from "../mariadb/manager";
import { decryptSecret } from "../util/crypto";

export const queryRoute = new Hono<{ Variables: AuthVariables }>();

queryRoute.use("*", requireAuth);

queryRoute.post("/:id/query", requireDbAccess("id", "read"), async (c) => {
  const id = c.req.param("id");
  const row = databases.byId(id);
  if (!row) throw new HTTPException(404, { message: "not found" });
  const body = (await c.req.json()) as { sql?: string };
  if (!body.sql?.trim()) throw new HTTPException(400, { message: "sql required" });

  const user = c.get("user");
  if (user.role === "viewer") {
    // Strip multi-line comments
    let cleaned = body.sql.replace(/\/\*[\s\S]*?\*\//g, "");
    // Strip single-line comments starting with -- or #
    cleaned = cleaned.replace(/(?:--|#)[^\r\n]*/g, "");
    // Trim whitespace and outer parentheses iteratively
    cleaned = cleaned.trim();
    while (cleaned.startsWith("(") && cleaned.endsWith(")")) {
      cleaned = cleaned.slice(1, -1).trim();
    }

    if (!/^\s*(SELECT|SHOW|DESCRIBE|EXPLAIN|WITH)\b/i.test(cleaned)) {
      throw new HTTPException(403, { message: "viewers may only run read-only queries" });
    }
  }

  const password = await decryptSecret(row.mysqlPasswordEnc);
  try {
    const result = await executeUserQuery({
      schema: row.name,
      user: row.mysqlUser,
      password,
      sql: body.sql,
      readOnly: user.role === "viewer",
    });
    audit.log(user.id, "query.exec", id, { rowCount: result.rowCount });
    return c.json(result);
  } catch (err) {
    return c.json({ error: String((err as Error).message ?? err) }, 400);
  }
});
