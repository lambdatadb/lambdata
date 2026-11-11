import { closeDb } from "../../../src/db/client";
import { migrate } from "../../../src/db/migrate";
import { notificationDeliveries, notificationDestinations } from "../../../src/db/queries/notifications";
import { encryptSecret } from "../../../src/util/crypto";

const url = process.argv[2];
if (!url) throw new Error("usage: seedPending.ts <webhook url>");

migrate();
const now = Date.now();
notificationDestinations.insert({
  id: "nd_restart",
  name: "Restart check",
  kind: "webhook",
  enabled: true,
  configEnc: await encryptSecret(JSON.stringify({ kind: "webhook", url, secret: "restart-secret", headers: {} })),
  target: new URL(url).origin,
  hasSecret: true,
  headerNames: [],
  ntfyPriority: null,
  events: ["user.created"],
  databaseIds: null,
  iconUrl: null,
  skipUnchanged: false,
  createdByUserId: null,
  createdAt: now,
  updatedAt: now,
});
const event = (n: number) =>
  JSON.stringify({
    id: `evt_restart_${n}`,
    type: "user.created",
    group: "access",
    severity: "info",
    occurredAt: now,
    title: `Queued before restart ${n}`,
    message: "Written by a process that stopped before sending it.",
    actor: null,
    database: null,
    fields: [],
    data: {},
    link: null,
  });
notificationDeliveries.insertMany([1, 2].map((n) => ({
  id: `ndl_restart_${n}`,
  destinationId: "nd_restart",
  eventType: "user.created",
  title: `Queued before restart ${n}`,
  payload: event(n),
  createdAt: now + n,
})));
closeDb();
