import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { TableBreakdown } from "@lambdata/shared";
import { databases, metrics } from "../db/queries";
import { requireAuth, requireDbAccess, type AuthVariables } from "../auth/middleware";
import { getTableBreakdown } from "../mariadb/manager";
import { assertMariaDbResponding } from "../util/mariadbHealth";

const DAY_MS = 24 * 60 * 60 * 1000;

export const RANGE_MS: Readonly<Record<string, number>> = {
  "1d": DAY_MS,
  "5d": 5 * DAY_MS,
  "15d": 15 * DAY_MS,
  "24h": DAY_MS,
  "7d": 7 * DAY_MS,
  "30d": 30 * DAY_MS,
};

export function rangeMsFor(range: string | undefined, fallback: keyof typeof RANGE_MS): number {
  return (range !== undefined && Object.hasOwn(RANGE_MS, range) ? RANGE_MS[range] : undefined) ?? RANGE_MS[fallback]!;
}

export function bucketMsFor(windowMs: number, maxPointsParam: string | undefined): number | undefined {
  if (!maxPointsParam) return undefined;
  const n = Number(maxPointsParam);
  if (!Number.isFinite(n)) return undefined;
  const maxPoints = Math.min(5000, Math.max(10, Math.floor(n)));
  return Math.ceil(windowMs / maxPoints);
}

export const metricsRoute = new Hono<{ Variables: AuthVariables }>();

metricsRoute.use("*", requireAuth);

metricsRoute.get("/:id/metrics", requireDbAccess("id", "read"), (c) => {
  const id = c.req.param("id");
  if (!databases.byId(id)) throw new HTTPException(404, { message: "not found" });
  const windowMs = rangeMsFor(c.req.query("range"), "24h");
  const bucketMs = bucketMsFor(windowMs, c.req.query("maxPoints"));
  const samples = metrics.range(id, Date.now() - windowMs, bucketMs);
  return c.json({ samples });
});

metricsRoute.get("/:id/tables", requireDbAccess("id", "read"), async (c) => {
  const id = c.req.param("id");
  const row = databases.byId(id);
  if (!row) throw new HTTPException(404, { message: "not found" });
  await assertMariaDbResponding();
  const tables = await getTableBreakdown(row.name);
  const res: TableBreakdown = { collectedAt: Date.now(), tables };
  return c.json(res);
});
