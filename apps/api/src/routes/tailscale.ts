import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { audit, settings } from "../db/queries";
import { requireAuth, requireRole, type AuthVariables } from "../auth/middleware";
import { tailscaleDown, tailscaleManager, tailscaleStatus, tailscaleUp } from "../tailscale/cli";

export const tailscaleRoute = new Hono<{ Variables: AuthVariables }>();

function requireLocalTailscaleControl(): void {
  if (tailscaleManager() === "unraid") {
    throw new HTTPException(409, {
      message: "Tailscale is managed by Unraid. Update it from the KilnDB container template.",
    });
  }
}

tailscaleRoute.use("*", requireAuth);

tailscaleRoute.get("/status", async (c) => {
  const status = await tailscaleStatus();
  return c.json(status);
});

tailscaleRoute.post("/up", requireRole("admin"), async (c) => {
  requireLocalTailscaleControl();
  const body = (await c.req.json().catch(() => ({}))) as { authKey?: string };
  const r = await tailscaleUp(body.authKey);
  if (!r.ok) throw new HTTPException(400, { message: r.error ?? "tailscale up failed" });
  settings.set("tailscale_enabled", "1");
  audit.log(c.get("user").id, "tailscale.up", null, null);
  return c.json({ ok: true });
});

tailscaleRoute.post("/down", requireRole("admin"), async (c) => {
  requireLocalTailscaleControl();
  const r = await tailscaleDown();
  if (!r.ok) throw new HTTPException(400, { message: r.error ?? "tailscale down failed" });
  settings.set("tailscale_enabled", "0");
  audit.log(c.get("user").id, "tailscale.down", null, null);
  return c.json({ ok: true });
});
