import { Hono } from "hono";
import { z } from "zod";
import type {
  DataApiAccessResponse,
  DataApiAccessSummary,
  DataApiOverviewResponse,
  Database,
} from "@lambdata/shared";
import { audit, dataApiPolicies, databases } from "../db/queries";
import { dataAccess } from "../db/queries/dataAccess";
import { requireAuth, type AuthVariables } from "../auth/middleware";
import { appAuthSettings } from "../auth/appJwt";
import { baseTablesBySchema, requireDataApiDatabase } from "../auth/dataAccess";
import { parseJson } from "../util/validate";
import { mariadbResponding } from "../util/mariadbHealth";

const accessSchema = z.object({ mode: z.enum(["closed", "open"], { error: "mode must be closed or open" }) });

export const dataAccessRoute = new Hono<{ Variables: AuthVariables }>();

dataAccessRoute.use("*", requireAuth);

dataAccessRoute.get("/", async (c) => {
  const user = c.get("user");
  const visible = (user.role === "db_owner" ? databases.listForUser(user.id) : databases.list()).filter(
    (database) => database.status !== "deleting",
  );
  const res: DataApiOverviewResponse = {
    databases: await accessSummaries(visible),
    signupEnabled: appAuthSettings().allowSignup,
  };
  return c.json(res);
});

dataAccessRoute.get("/:databaseName", async (c) => {
  const database = requireDataApiDatabase(c.get("user"), c.req.param("databaseName"), "read", false);
  return c.json(await accessResponse(database));
});

dataAccessRoute.put("/:databaseName", async (c) => {
  const user = c.get("user");
  const database = requireDataApiDatabase(user, c.req.param("databaseName"), "write", false);
  const { mode } = await parseJson(c, accessSchema);
  const previous = dataAccess.mode(database.id);
  dataAccess.setMode(database.id, mode, user.id);
  audit.log(user.id, "data_api.access.update", database.id, { database: database.name, mode, previous });
  return c.json(await accessResponse(database));
});

dataAccessRoute.delete("/:databaseName/denials", (c) => {
  const user = c.get("user");
  const database = requireDataApiDatabase(user, c.req.param("databaseName"), "write", false);
  const cleared = dataAccess.clearDenials(database.id);
  audit.log(user.id, "data_api.denials.clear", database.id, { database: database.name, cleared });
  return c.json({ ok: true });
});

async function accessResponse(database: Database): Promise<DataApiAccessResponse> {
  const [access] = await accessSummaries([database]);
  return { access: access! };
}

async function accessSummaries(list: Database[]): Promise<DataApiAccessSummary[]> {
  if (list.length === 0) return [];
  let tables = new Map<string, string[]>();
  try {
    if (await mariadbResponding()) tables = await baseTablesBySchema(list.map((database) => database.name));
  } catch (err) {
    console.warn("[data-api] could not list tables:", err instanceof Error ? err.message : err);
  }
  const modes = dataAccess.modes();
  const denials = dataAccess.denialsByDatabase();
  return list.map((database) => {
    const names = tables.get(database.name) ?? [];
    const covered = new Set(dataApiPolicies.list(database.id).map((policy) => policy.tableName));
    return {
      databaseId: database.id,
      databaseName: database.name,
      displayName: database.displayName,
      mode: modes.get(database.id) ?? "closed",
      tableCount: names.length,
      tablesWithoutPolicy: names.filter((name) => !covered.has(name)),
      denials: denials.get(database.id) ?? [],
    };
  });
}
