import { Hono, type Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import type { Database, MoveBackSetAsideTableRequest, MoveBackSetAsideTableResponse, SetAsideListResponse } from "@lambdata/shared";
import { requireAuth, requireDbAccess, type AuthVariables } from "../auth/middleware";
import { audit, databases } from "../db/queries";
import { deleteSetAside, listSetAside, moveBackSetAside, SetAsideError } from "../databases/setAside";
import { invalidateWorkingCopyStatus } from "../checkpoints";
import { JobConflictError, jobConflictResponse, runExclusive } from "../jobs";
import { recoverInterruptedSwaps, swapInProgress } from "../mariadb/schemaSwap";
import { assertMariaDbResponding } from "../util/mariadbHealth";
import { parseJson } from "../util/validate";

export const setAsideRoute = new Hono<{ Variables: AuthVariables }>();

setAsideRoute.use("*", requireAuth);

const NEW_NAME = /^[A-Za-z0-9_$-]+(?: [A-Za-z0-9_$-]+)*$/;

const moveBackBody = z.object({
  table: z.string().min(1).max(64),
  as: z
    .string()
    .min(1)
    .max(64)
    .regex(NEW_NAME, "use letters, digits, _, $ and -, with single spaces only between words")
    .optional(),
});

function databaseOf(c: Context): Database {
  const row = databases.byId(c.req.param("id") ?? "");
  if (!row) throw new HTTPException(404, { message: "database not found" });
  return row;
}

async function exclusive<T>(c: Context, row: Database, fn: () => Promise<T>): Promise<T | Response> {
  try {
    return await runExclusive(row.id, async () => {
      if (swapInProgress(row.id) || swapInProgress(row.name)) {
        throw new HTTPException(409, { message: `${row.displayName} is having its contents replaced right now. Try again when that has finished.` });
      }
      return fn();
    });
  } catch (err) {
    if (err instanceof JobConflictError) return jobConflictResponse(c, err);
    if (err instanceof SetAsideError) throw new HTTPException(err.status, { message: err.message });
    throw err;
  }
}

async function finishKept(row: Database): Promise<void> {
  try {
    await recoverInterruptedSwaps();
  } catch (err) {
    console.warn(`[set-aside] could not finish the interrupted swap of ${row.name} yet:`, err instanceof Error ? err.message : String(err));
  }
}

setAsideRoute.get("/:id/set-aside", requireDbAccess("id", "read"), async (c) => {
  const row = databaseOf(c);
  await assertMariaDbResponding();
  const res: SetAsideListResponse = { schemas: await listSetAside(row) };
  return c.json(res);
});

setAsideRoute.post("/:id/set-aside/:schema/move-back", requireDbAccess("id", "owner"), async (c) => {
  const row = databaseOf(c);
  const schema = c.req.param("schema");
  const body: MoveBackSetAsideTableRequest = await parseJson(c, moveBackBody);
  await assertMariaDbResponding();
  const result = await exclusive(c, row, () => moveBackSetAside(row, schema, body.table, body.as));
  if (result instanceof Response) return result;
  invalidateWorkingCopyStatus(row.id);
  audit.log(c.get("user").id, "db.set_aside.move_back", row.id, {
    schema,
    kind: result.kind,
    table: result.table,
    movedTo: result.movedTo,
    schemaRemoved: result.schemaRemoved,
  });
  if (result.kind === "kept") await finishKept(row);
  const res: MoveBackSetAsideTableResponse = { table: result.table, movedTo: result.movedTo, schemaRemoved: result.schemaRemoved };
  return c.json(res);
});

setAsideRoute.delete("/:id/set-aside/:schema", requireDbAccess("id", "owner"), async (c) => {
  const row = databaseOf(c);
  const schema = c.req.param("schema");
  await assertMariaDbResponding();
  const removed = await exclusive(c, row, () => deleteSetAside(row, schema));
  if (removed instanceof Response) return removed;
  invalidateWorkingCopyStatus(row.id);
  audit.log(c.get("user").id, "db.set_aside.delete", row.id, {
    schema,
    kind: removed.kind,
    tables: removed.tables.map((t) => ({ name: t.name, rowCount: t.rowCount })),
  });
  if (removed.kind === "kept") await finishKept(row);
  return c.body(null, 204);
});
