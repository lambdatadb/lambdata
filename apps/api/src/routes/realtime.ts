import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { RealtimeBroadcastRequest } from "@kilndb/shared";
import { appUserFromBearer } from "../auth/appBearer";
import { requireAuth, type AuthVariables } from "../auth/middleware";
import { audit } from "../db/queries";
import { publishBroadcast, realtimeStatus } from "../realtime/hub";

export const realtimeRoute = new Hono<{ Variables: AuthVariables }>();

realtimeRoute.get("/status", requireAuth, (c) => {
  return c.json({ status: realtimeStatus() });
});

realtimeRoute.post("/broadcast", async (c) => {
  const user = await appUserFromBearer(c.req.header("Authorization"));
  const body = await c.req.json().catch(() => null) as RealtimeBroadcastRequest | null;
  if (!body || !Array.isArray(body.messages) || body.messages.length === 0) {
    throw new HTTPException(400, { message: "messages array required" });
  }
  if (body.messages.length > 100) {
    throw new HTTPException(400, { message: "at most 100 messages per request" });
  }

  let delivered = 0;
  for (const message of body.messages) {
    const channel = message.channel ?? message.topic;
    if (!channel || !message.event) {
      throw new HTTPException(400, { message: "message channel/topic and event required" });
    }
    delivered += publishBroadcast({
      channel,
      event: message.event,
      payload: message.payload ?? null,
      sender: user,
      self: message.self !== false,
    });
  }

  audit.log(null, "realtime.broadcast", null, {
    userId: user.id,
    messageCount: body.messages.length,
    delivered,
  });
  return c.json({ ok: true, delivered });
});
