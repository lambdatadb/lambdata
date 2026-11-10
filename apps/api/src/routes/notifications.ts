import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import type {
  NotificationCatalogResponse,
  NotificationDeliveryListResponse,
  NotificationDestinationListResponse,
  NotificationDestinationResponse,
  NotificationTestResponse,
} from "@lambdata/shared";
import { requireAuth, requireRole, type AuthVariables } from "../auth/middleware";
import { audit } from "../db/queries";
import { notificationDeliveries, notificationDestinations } from "../db/queries/notifications";
import { readJson, parseQuery } from "../util/validate";
import { catalog } from "../notifications/catalog";
import { createDestination, updateDestination } from "../notifications/destinations";
import { forgetDestination, kickDestination, sendTestMessage, testEvent } from "../notifications/worker";

export const notificationsRoute = new Hono<{ Variables: AuthVariables }>();

notificationsRoute.use("*", requireAuth, requireRole("admin"));

const deliveriesQuery = z.object({ limit: z.coerce.number().int().min(1).max(100).default(50) });

function auditEntry(userId: string, action: string, target: string, dest: { name: string; kind: string }): void {
  audit.log(userId, action, target, { name: dest.name, kind: dest.kind });
}

notificationsRoute.get("/events", (c) => {
  const res: NotificationCatalogResponse = catalog();
  return c.json(res);
});

notificationsRoute.get("/destinations", (c) => {
  const res: NotificationDestinationListResponse = { destinations: notificationDestinations.list() };
  return c.json(res);
});

notificationsRoute.post("/destinations", async (c) => {
  const user = c.get("user");
  const destination = await createDestination(await readJson(c), user.id);
  auditEntry(user.id, "notification.destination.create", destination.id, destination);
  const res: NotificationDestinationResponse = { destination };
  return c.json(res, 201);
});

notificationsRoute.get("/destinations/:id", (c) => {
  const destination = notificationDestinations.byId(c.req.param("id"));
  if (!destination) throw new HTTPException(404, { message: "destination not found" });
  const res: NotificationDestinationResponse = { destination };
  return c.json(res);
});

notificationsRoute.patch("/destinations/:id", async (c) => {
  const user = c.get("user");
  const id = c.req.param("id");
  const updated = await updateDestination(id, await readJson(c));
  if (!updated) throw new HTTPException(404, { message: "destination not found" });
  if (updated.disabled) forgetDestination(id);
  else if (updated.destination.enabled) kickDestination(id);
  auditEntry(user.id, "notification.destination.update", id, updated.destination);
  const res: NotificationDestinationResponse = { destination: updated.destination };
  return c.json(res);
});

notificationsRoute.delete("/destinations/:id", (c) => {
  const user = c.get("user");
  const id = c.req.param("id");
  const existing = notificationDestinations.byId(id);
  if (!existing) throw new HTTPException(404, { message: "destination not found" });
  notificationDestinations.delete(id);
  forgetDestination(id);
  auditEntry(user.id, "notification.destination.delete", id, existing);
  return c.body(null, 204);
});

notificationsRoute.post("/destinations/:id/test", async (c) => {
  const user = c.get("user");
  const id = c.req.param("id");
  const rec = notificationDestinations.recordById(id);
  if (!rec) throw new HTTPException(404, { message: "destination not found" });
  const res: NotificationTestResponse = await sendTestMessage(rec, testEvent(rec.name));
  audit.log(user.id, "notification.destination.test", id, { name: rec.name, kind: rec.kind, ok: res.ok });
  return c.json(res);
});

notificationsRoute.get("/destinations/:id/deliveries", (c) => {
  const id = c.req.param("id");
  if (!notificationDestinations.byId(id)) throw new HTTPException(404, { message: "destination not found" });
  const { limit } = parseQuery(c, deliveriesQuery);
  const res: NotificationDeliveryListResponse = { deliveries: notificationDeliveries.list(id, limit) };
  return c.json(res);
});
