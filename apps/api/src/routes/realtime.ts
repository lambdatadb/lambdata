import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { appUserFromBearer } from "../auth/appBearer";
import { requireAuth, type AuthVariables } from "../auth/middleware";
import { audit } from "../db/queries";
import {
  RealtimeError,
  assertBroadcastAllowed,
  normalizeChannel,
  normalizeEvent,
  publishBroadcast,
  realtimeStatus,
} from "../realtime/hub";
import { parseJson } from "../util/validate";

export const realtimeRoute = new Hono<{ Variables: AuthVariables }>();

const broadcastSchema = z.object({
  messages: z
    .array(
      z
        .object({
          channel: z.string().optional(),
          topic: z.string().optional(),
          event: z.string().min(1, "event required"),
          payload: z.unknown().optional(),
          self: z.boolean().optional(),
        })
        .refine((m) => !!(m.channel ?? m.topic), "message channel/topic and event required"),
    )
    .min(1, "messages array required")
    .max(100, "at most 100 messages per request"),
});

realtimeRoute.get("/status", requireAuth, (c) => {
  return c.json({ status: realtimeStatus() });
});

realtimeRoute.post("/broadcast", async (c) => {
  const user = await appUserFromBearer(c.req.header("Authorization"));
  const body = await parseJson(c, broadcastSchema);
  const messages = body.messages.map((message) => {
    try {
      const channel = normalizeChannel(message.channel ?? message.topic ?? "");
      assertBroadcastAllowed(channel);
      return {
        channel,
        event: normalizeEvent(message.event),
        payload: message.payload ?? null,
        self: message.self !== false,
      };
    } catch (err) {
      if (err instanceof RealtimeError) throw new HTTPException(err.status, { message: err.message });
      throw err;
    }
  });

  let delivered = 0;
  for (const message of messages) {
    delivered += publishBroadcast({ ...message, sender: user });
  }

  audit.log(null, "realtime.broadcast", null, {
    userId: user.id,
    messageCount: messages.length,
    delivered,
  });
  return c.json({ ok: true, delivered });
});
