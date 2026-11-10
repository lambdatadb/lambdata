import type { NotificationTestResponse } from "@lambdata/shared";
import {
  notificationDeliveries,
  notificationDestinations,
  type DeliveryRecord,
  type DestinationRecord,
} from "../db/queries/notifications";
import { sanitizeErrorMessage } from "../jobs/sanitize";
import { newId } from "../util/id";
import { decodeConfig } from "./destinations";
import { renderRequest, type NotificationEvent } from "./format";
import { attemptRequest, notificationTuning, type AttemptOutcome } from "./send";

export const COALESCED_REASON = "combined into a summary: more than the per-minute limit of messages";
const MAX_SUMMARY_TITLES = 5;
const MAX_SUMMARY_FAILURES = 3;
const STOP_GRACE_MS = 1_000;

interface Overflow {
  count: number;
  titles: string[];
  types: string[];
  since: number;
  failures: number;
}

interface Lane {
  id: string;
  active: boolean;
  dirty: boolean;
  wake: (() => void) | null;
  sent: number[];
  overflow: Overflow | null;
  lastSummaryAt: number;
  abort: AbortController | null;
  loop: Promise<void> | null;
}

const lanes = new Map<string, Lane>();
let running = false;
let generation = 0;
let lastLoggedAt = 0;

function logProblem(message: string, err: unknown): void {
  const now = Date.now();
  if (now - lastLoggedAt < 60_000) return;
  lastLoggedAt = now;
  console.error(`[notifications] ${message}:`, sanitizeErrorMessage(err).slice(0, 300));
}

function laneFor(id: string): Lane {
  let lane = lanes.get(id);
  if (!lane) {
    lane = { id, active: false, dirty: false, wake: null, sent: [], overflow: null, lastSummaryAt: 0, abort: null, loop: null };
    lanes.set(id, lane);
  }
  return lane;
}

function pruneWindow(lane: Lane, now: number): void {
  const cutoff = now - notificationTuning.windowMs;
  while (lane.sent.length > 0 && lane.sent[0]! <= cutoff) lane.sent.shift();
}

function summaryDue(lane: Lane): number {
  const o = lane.overflow!;
  return Math.max(o.since + notificationTuning.summaryGatherMs, lane.lastSummaryAt + notificationTuning.windowMs);
}

function sleep(lane: Lane, ms: number): Promise<void> {
  if (ms <= 0 || lane.dirty || !running) return Promise.resolve();
  return new Promise((resolve) => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const finish = () => {
      if (timer) clearTimeout(timer);
      timer = null;
      if (lane.wake === finish) lane.wake = null;
      resolve();
    };
    timer = setTimeout(finish, Math.min(ms, 2_147_000_000));
    (timer as { unref?: () => void }).unref?.();
    lane.wake = finish;
  });
}

function prune(destinationId: string): void {
  try {
    notificationDeliveries.prune(destinationId, notificationTuning.keepPerDestination, Date.now() - notificationTuning.keepMs);
  } catch (err) {
    logProblem("could not prune old deliveries", err);
  }
}

function summaryEvent(lane: Lane): NotificationEvent {
  const o = lane.overflow!;
  const listed = o.titles.slice(0, MAX_SUMMARY_TITLES);
  const more = o.count - listed.length;
  const lines = listed.map((t) => `• ${t}`);
  if (more > 0) lines.push(`• and ${more} more`);
  return {
    id: newId("evt"),
    type: "summary",
    group: "summary",
    severity: "info",
    occurredAt: Date.now(),
    title: `And ${o.count} more ${o.count === 1 ? "event" : "events"}`,
    message: `More than ${notificationTuning.maxPerWindow} messages in a minute, so these were combined:\n${lines.join("\n")}`,
    actor: null,
    database: null,
    fields: [],
    data: { count: o.count, types: [...new Set(o.types)].join(",") },
    link: null,
  };
}

async function sendOnce(lane: Lane | null, dest: DestinationRecord, event: NotificationEvent, deliveryId: string): Promise<AttemptOutcome> {
  let request;
  try {
    const config = await decodeConfig(dest);
    request = renderRequest(config, dest, event, deliveryId, Date.now());
  } catch (err) {
    logProblem("could not prepare a notification", err);
    return {
      ok: false,
      retryable: false,
      aborted: false,
      responseStatus: null,
      error: "the destination's stored settings could not be read",
      retryAfterMs: null,
      durationMs: 0,
    };
  }
  if (!lane) return attemptRequest(request);
  const controller = new AbortController();
  lane.abort = controller;
  try {
    return await attemptRequest(request, controller.signal);
  } finally {
    if (lane.abort === controller) lane.abort = null;
  }
}

async function sendSummary(lane: Lane, dest: DestinationRecord): Promise<void> {
  const event = summaryEvent(lane);
  const outcome = await sendOnce(lane, dest, event, newId("ndl"));
  if (outcome.aborted) return;
  const at = Date.now();
  lane.lastSummaryAt = at;
  if (outcome.ok) {
    lane.overflow = null;
    notificationDestinations.recordSuccess(dest.id, at);
    return;
  }
  notificationDestinations.recordAttemptFailure(dest.id, at, outcome.error ?? "send failed");
  const o = lane.overflow!;
  o.failures++;
  if (o.failures >= MAX_SUMMARY_FAILURES) lane.overflow = null;
}

async function deliver(lane: Lane, dest: DestinationRecord, head: DeliveryRecord): Promise<void> {
  const attempts = head.attempts + 1;
  notificationDeliveries.markSending(head.id, attempts);
  lane.sent.push(Date.now());
  let event: NotificationEvent;
  try {
    event = JSON.parse(head.payload) as NotificationEvent;
  } catch {
    notificationDeliveries.markFailed(head.id, null, "the stored message could not be read");
    return;
  }
  const outcome = await sendOnce(lane, dest, event, head.id);
  if (outcome.aborted) {
    notificationDeliveries.requeue(head.id, head.attempts);
    return;
  }
  const at = Date.now();
  if (outcome.ok) {
    notificationDeliveries.markSent(head.id, at, outcome.responseStatus);
    notificationDestinations.recordSuccess(dest.id, at);
    prune(dest.id);
    return;
  }
  const error = outcome.error ?? "send failed";
  if (outcome.retryable && attempts <= notificationTuning.backoffMs.length) {
    const delay = outcome.retryAfterMs ?? notificationTuning.backoffMs[attempts - 1]!;
    notificationDeliveries.markRetry(head.id, at + delay, outcome.responseStatus, error);
    notificationDestinations.recordAttemptFailure(dest.id, at, error);
    return;
  }
  notificationDeliveries.markFailed(head.id, outcome.responseStatus, error);
  notificationDestinations.recordDeliveryFailure(dest.id, at, error);
  prune(dest.id);
}

type StepResult = "busy" | "idle";

function soonest(...times: number[]): number {
  return Math.min(...times);
}

async function step(lane: Lane): Promise<StepResult> {
  lane.dirty = false;
  const now = Date.now();
  const dest = notificationDestinations.recordById(lane.id);
  if (!dest || !dest.enabled) {
    lane.overflow = null;
    return "idle";
  }
  pruneWindow(lane, now);
  if (lane.overflow && now >= summaryDue(lane)) {
    await sendSummary(lane, dest);
    return "busy";
  }
  const summaryAt = lane.overflow ? summaryDue(lane) : Number.POSITIVE_INFINITY;
  const head = notificationDeliveries.nextQueued(lane.id);
  if (!head) {
    if (!lane.overflow) return "idle";
    await sleep(lane, summaryAt - now);
    return "busy";
  }
  if (head.nextAttemptAt !== null && head.nextAttemptAt > now) {
    await sleep(lane, soonest(head.nextAttemptAt, summaryAt) - now);
    return "busy";
  }
  if (lane.sent.length >= notificationTuning.maxPerWindow) {
    const coalesced = notificationDeliveries.coalesceFresh(lane.id, now, COALESCED_REASON);
    if (coalesced.length > 0) {
      if (!lane.overflow) lane.overflow = { count: 0, titles: [], types: [], since: now, failures: 0 };
      lane.overflow.count += coalesced.length;
      for (const c of coalesced) {
        if (lane.overflow.titles.length < MAX_SUMMARY_TITLES) lane.overflow.titles.push(c.title);
        lane.overflow.types.push(c.eventType);
      }
      return "busy";
    }
    await sleep(lane, soonest(lane.sent[0]! + notificationTuning.windowMs, summaryAt) - now);
    return "busy";
  }
  await deliver(lane, dest, head);
  return "busy";
}

async function runLane(lane: Lane, gen: number): Promise<void> {
  try {
    while (running && gen === generation) {
      let result: StepResult;
      try {
        result = await step(lane);
      } catch (err) {
        logProblem("a delivery step failed", err);
        await sleep(lane, 5_000);
        continue;
      }
      if (result === "idle" && !lane.dirty) break;
    }
  } finally {
    lane.active = false;
    lane.loop = null;
  }
}

export function kickDestination(id: string): void {
  if (!running) return;
  const lane = laneFor(id);
  lane.dirty = true;
  if (lane.active) {
    lane.wake?.();
    return;
  }
  lane.active = true;
  lane.loop = runLane(lane, generation);
}

export function workerRunning(): boolean {
  return running;
}

export function startWorker(): void {
  if (running) return;
  running = true;
  generation++;
  try {
    notificationDeliveries.resetSending();
    notificationDeliveries.pruneAll(notificationTuning.keepPerDestination, Date.now() - notificationTuning.keepMs);
    for (const id of notificationDeliveries.destinationsWithQueued()) kickDestination(id);
  } catch (err) {
    logProblem("could not resume pending deliveries", err);
  }
}

export async function stopWorker(): Promise<void> {
  if (!running) return;
  running = false;
  const loops: Promise<void>[] = [];
  for (const lane of lanes.values()) {
    lane.abort?.abort();
    lane.wake?.();
    if (lane.loop) loops.push(lane.loop);
  }
  if (loops.length > 0) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const grace = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, STOP_GRACE_MS);
      (timer as { unref?: () => void }).unref?.();
    });
    await Promise.race([Promise.allSettled(loops), grace]);
    clearTimeout(timer);
  }
  lanes.clear();
}

export function forgetDestination(id: string): void {
  const lane = lanes.get(id);
  if (!lane) return;
  lane.abort?.abort();
  lane.overflow = null;
  lane.dirty = true;
  lane.wake?.();
}

export function pruneAllDeliveries(): void {
  try {
    notificationDeliveries.pruneAll(notificationTuning.keepPerDestination, Date.now() - notificationTuning.keepMs);
  } catch (err) {
    logProblem("could not prune old deliveries", err);
  }
}

export function testEvent(destName: string): NotificationEvent {
  return {
    id: newId("evt"),
    type: "test",
    group: "test",
    severity: "info",
    occurredAt: Date.now(),
    title: "Test message from LambData",
    message: `If you can read this, notifications to ${destName} work. This is only a test; nothing happened.`,
    actor: null,
    database: null,
    fields: [],
    data: { test: true },
    link: null,
  };
}

export async function sendTestMessage(dest: DestinationRecord, event: NotificationEvent): Promise<NotificationTestResponse> {
  const lane = laneFor(dest.id);
  const deliveryId = newId("ndl");
  const createdAt = Date.now();
  lane.sent.push(createdAt);
  const outcome = await sendOnce(null, dest, event, deliveryId);
  const at = Date.now();
  const error = outcome.ok ? null : (outcome.error ?? "send failed");
  try {
    notificationDeliveries.insertFinished({
      id: deliveryId,
      destinationId: dest.id,
      eventType: "test",
      title: event.title,
      payload: JSON.stringify(event),
      createdAt,
      status: outcome.ok ? "sent" : "failed",
      attempts: 1,
      responseStatus: outcome.responseStatus,
      lastError: error,
      sentAt: outcome.ok ? at : null,
    });
    if (outcome.ok) notificationDestinations.recordSuccess(dest.id, at);
    else notificationDestinations.recordDeliveryFailure(dest.id, at, error!);
    prune(dest.id);
  } catch (err) {
    logProblem("could not record a test message", err);
  }
  return { ok: outcome.ok, responseStatus: outcome.responseStatus, error, durationMs: outcome.durationMs };
}
