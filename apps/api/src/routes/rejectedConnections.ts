import { Hono } from "hono";
import type { RejectedConnectionsResponse } from "@lambdata/shared";
import { audit, databases } from "../db/queries";
import { requireAuth, requireDbAccess, requireRole, type AuthVariables } from "../auth/middleware";
import { refreshRejections, rejectionsSince, rejectionsSupported, markRejectionsSince } from "../connections/capture";
import { toRejectedConnection } from "../connections/classify";
import { allRejections, clearRejections, rejectionsForDatabase, type RejectionGroup } from "../connections/store";

export const databaseRejectedConnectionsRoute = new Hono<{ Variables: AuthVariables }>();
export const networkRejectedConnectionsRoute = new Hono<{ Variables: AuthVariables }>();

function respond(groups: RejectionGroup[]): RejectedConnectionsResponse {
  const cache = new Map<string, { displayName: string; connectionsFrom: string } | null>();
  const lookup = (id: string) => {
    if (!cache.has(id)) {
      const row = databases.byId(id);
      cache.set(id, row ? { displayName: row.displayName, connectionsFrom: row.connectionsFrom } : null);
    }
    return cache.get(id) ?? null;
  };
  const supported = rejectionsSupported();
  return {
    supported,
    since: supported ? rejectionsSince() : null,
    rejections: groups.map((g) => toRejectedConnection(g, lookup)),
  };
}

databaseRejectedConnectionsRoute.get("/:id/rejected-connections", requireAuth, requireDbAccess("id", "read"), (c) => {
  refreshRejections();
  return c.json(respond(rejectionsForDatabase(c.req.param("id"))));
});

networkRejectedConnectionsRoute.get("/rejected-connections", requireAuth, requireRole("admin"), (c) => {
  refreshRejections();
  return c.json(respond(allRejections()));
});

networkRejectedConnectionsRoute.delete("/rejected-connections", requireAuth, requireRole("admin"), (c) => {
  refreshRejections();
  const removed = clearRejections();
  markRejectionsSince();
  audit.log(c.get("user").id, "network.rejected_connections.clear", null, { removed });
  return c.json(respond([]));
});
