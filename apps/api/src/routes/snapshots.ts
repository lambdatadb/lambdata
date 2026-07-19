import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { unlinkSync } from "node:fs";
import { audit, databases, snapshots } from "../db/queries";
import { requireAuth, requireDbAccess, type AuthVariables } from "../auth/middleware";
import { createSnapshot, restoreSnapshot } from "../workers/snapshots";

export const snapshotsRoute = new Hono<{ Variables: AuthVariables }>();

snapshotsRoute.use("*", requireAuth);

snapshotsRoute.get("/:id/snapshots", requireDbAccess("id", "read"), (c) => {
  return c.json({ snapshots: snapshots.list(c.req.param("id")) });
});

snapshotsRoute.post("/:id/snapshots", requireDbAccess("id", "write"), async (c) => {
  const id = c.req.param("id");
  const row = databases.byId(id);
  if (!row) throw new HTTPException(404, { message: "not found" });
  const snap = await createSnapshot(id, "manual");
  audit.log(c.get("user").id, "snapshot.create", id, { snapshotId: snap.id });
  return c.json({ snapshot: snap });
});

snapshotsRoute.post(
  "/:id/snapshots/:snapshotId/restore",
  requireDbAccess("id", "owner"),
  async (c) => {
    const id = c.req.param("id");
    const snapId = c.req.param("snapshotId");
    const snap = snapshots.byId(snapId);
    if (!snap || snap.databaseId !== id) {
      throw new HTTPException(404, { message: "snapshot not found" });
    }
    await restoreSnapshot(id, snap);
    audit.log(c.get("user").id, "snapshot.restore", id, { snapshotId: snapId });
    return c.json({ ok: true });
  },
);

snapshotsRoute.delete(
  "/:id/snapshots/:snapshotId",
  requireDbAccess("id", "write"),
  (c) => {
    const id = c.req.param("id");
    const snapId = c.req.param("snapshotId");
    const snap = snapshots.byId(snapId);
    if (!snap || snap.databaseId !== id) {
      throw new HTTPException(404, { message: "snapshot not found" });
    }
    try {
      unlinkSync(snap.filePath);
    } catch {
      // file may already be gone
    }
    snapshots.delete(snapId);
    audit.log(c.get("user").id, "snapshot.delete", id, { snapshotId: snapId });
    return c.json({ ok: true });
  },
);
