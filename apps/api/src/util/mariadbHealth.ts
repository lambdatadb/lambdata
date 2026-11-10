import { HTTPException } from "hono/http-exception";
import { healthCheck, mariadbState, type MariaDbHealth } from "../mariadb/controller";

export const healthLimits = { timeoutMs: 2_000 };

export type BoundedHealth = MariaDbHealth & { timedOut?: boolean };

let running: Promise<MariaDbHealth> | null = null;
let runningSince = 0;
let lastRestarts = 0;

function seconds(): number {
  return Math.round(healthLimits.timeoutMs / 100) / 10;
}

export function notRespondingMessage(): string {
  return `MariaDB did not answer within ${seconds()} seconds; it may be frozen or overloaded`;
}

function timedOut(): BoundedHealth {
  return { ok: false, error: notRespondingMessage(), state: mariadbState(), restarts: lastRestarts, timedOut: true };
}

export async function boundedHealthCheck(): Promise<BoundedHealth> {
  if (running && Date.now() - runningSince >= healthLimits.timeoutMs) return timedOut();
  if (!running) {
    runningSince = Date.now();
    running = healthCheck()
      .then((h) => {
        lastRestarts = h.restarts;
        return h;
      })
      .finally(() => {
        running = null;
      });
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), Math.max(0, runningSince + healthLimits.timeoutMs - Date.now()));
  });
  try {
    const result = await Promise.race([running, timeout]);
    if (result) return result;
  } finally {
    clearTimeout(timer);
  }
  return timedOut();
}

export async function mariadbResponding(): Promise<boolean> {
  return !(await boundedHealthCheck()).timedOut;
}

export async function assertMariaDbResponding(): Promise<void> {
  if (!(await mariadbResponding())) throw new HTTPException(503, { message: notRespondingMessage() });
}
