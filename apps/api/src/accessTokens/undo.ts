import { HTTPException } from "hono/http-exception";
import type { QueryUndoInfo, UndoPoint } from "@lambdata/shared";
import { checkpoints, databases, undoPoints, type StoredAccessToken } from "../db/queries";
import { createCheckpoint } from "../checkpoints";
import { JobConflictError, sanitizeErrorMessage } from "../jobs";

export const UNDO_WINDOW_MS = 30 * 60 * 1000;

const locks = new Map<string, Promise<unknown>>();

async function serialized<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const previous = locks.get(key) ?? Promise.resolve();
  const run = previous.then(fn, fn);
  const settled = run.then(
    () => undefined,
    () => undefined,
  );
  locks.set(key, settled);
  try {
    return await run;
  } finally {
    if (locks.get(key) === settled) locks.delete(key);
  }
}

export function undoMessage(token: Pick<StoredAccessToken, "name">): string {
  return `Before changes by ${token.name}`;
}

export function undoPointFor(token: Pick<StoredAccessToken, "id" | "name">, databaseId: string): UndoPoint | null {
  const stored = undoPoints.get(token.id, databaseId);
  if (!stored) return null;
  const cp = checkpoints.byId(stored.checkpointId);
  if (!cp || cp.databaseId !== databaseId) return null;
  return {
    checkpointId: cp.id,
    shortHash: cp.shortHash,
    message: cp.message,
    createdAt: cp.createdAt,
    tokenId: token.id,
    tokenName: token.name,
  };
}

export function activeUndoInfo(token: Pick<StoredAccessToken, "id" | "name">, databaseId: string, now: number = Date.now()): QueryUndoInfo | null {
  const stored = undoPoints.get(token.id, databaseId);
  if (!stored || now - stored.lastChangeAt >= UNDO_WINDOW_MS) return null;
  const point = undoPointFor(token, databaseId);
  return point ? { checkpointId: point.checkpointId, shortHash: point.shortHash, createdNow: false } : null;
}

function refusal(reason: string): HTTPException {
  return new HTTPException(409, {
    message: `The change was not run: an undo point could not be saved first (${reason}). Try again in a moment.`,
  });
}

export function ensureUndoPoint(token: StoredAccessToken, databaseId: string): Promise<QueryUndoInfo> {
  return serialized(`${token.id}:${databaseId}`, async () => {
    const active = activeUndoInfo(token, databaseId);
    if (active) return active;
    let checkpointId: string | null;
    let createdNow = true;
    try {
      const result = await createCheckpoint(databaseId, {
        trigger: "pre-agent",
        message: undoMessage(token),
        userId: token.actorUserId,
      });
      checkpointId = result.checkpointId;
      if (!checkpointId && result.unchanged) {
        checkpointId = databases.byId(databaseId)?.baseCheckpointId ?? null;
        createdNow = false;
      }
    } catch (err) {
      if (err instanceof JobConflictError) throw refusal("another operation is running on this database");
      throw refusal(sanitizeErrorMessage(err));
    }
    const cp = checkpointId ? checkpoints.byId(checkpointId) : null;
    if (!cp) throw refusal("no checkpoint was recorded");
    undoPoints.set(token.id, databaseId, cp.id);
    return { checkpointId: cp.id, shortHash: cp.shortHash, createdNow };
  });
}
