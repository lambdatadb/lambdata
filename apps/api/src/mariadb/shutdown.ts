import { holdSwapsForShutdown } from "./schemaSwap";
import { liftAllWriteFences } from "./writeFence";

export const SHUTDOWN_SWAP_WAIT_MS = 8_000;

export async function settleMariaDbWork(timeoutMs: number = SHUTDOWN_SWAP_WAIT_MS): Promise<void> {
  const unfinished = await holdSwapsForShutdown(timeoutMs);
  if (unfinished > 0) {
    console.warn(`[mariadb] ${unfinished} database swap(s) did not finish before shutdown; they are completed at the next start`);
  }
  await liftAllWriteFences().catch((err) => {
    console.error("[mariadb] could not reopen databases before stopping:", err instanceof Error ? err.message : String(err));
  });
}
