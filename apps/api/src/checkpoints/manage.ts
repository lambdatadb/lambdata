import { checkpoints, databases } from "../db/queries";
import { RETENTION_GROUPS, type RetentionGroup } from "../db/queries/checkpoints";
import { removeObject, sweepObjects, verifyStoredObjects, type StoreCheck } from "./store";

const protectedCheckpoints = new Map<string, number>();
const restoring = new Map<string, number>();

function bump(map: Map<string, number>, key: string, by: number): void {
  const n = (map.get(key) ?? 0) + by;
  if (n > 0) map.set(key, n);
  else map.delete(key);
}

export async function withProtectedCheckpoint<T>(databaseId: string, checkpointId: string, fn: () => Promise<T>): Promise<T> {
  bump(protectedCheckpoints, checkpointId, 1);
  bump(restoring, databaseId, 1);
  try {
    return await fn();
  } finally {
    bump(protectedCheckpoints, checkpointId, -1);
    bump(restoring, databaseId, -1);
  }
}

export function isCheckpointProtected(checkpointId: string): boolean {
  return protectedCheckpoints.has(checkpointId);
}

export function restoreInProgress(databaseId: string): boolean {
  return restoring.has(databaseId);
}

export async function deleteCheckpointRecord(databaseId: string, checkpointId: string): Promise<void> {
  const { objectHashes } = checkpoints.remove(checkpointId);
  for (const hash of objectHashes) {
    if (!checkpoints.isObjectReferenced(databaseId, hash)) {
      await removeObject(databaseId, hash, () => !checkpoints.isObjectReferenced(databaseId, hash));
    }
  }
}

export async function applyRetention(databaseId: string, groups?: RetentionGroup[]): Promise<string[]> {
  if (restoreInProgress(databaseId)) return [];
  const keep = Math.max(1, checkpoints.policy(databaseId).autoRetention);
  const removed: string[] = [];
  for (const group of groups ?? (Object.keys(RETENTION_GROUPS) as RetentionGroup[])) {
    const automatic = checkpoints.automaticForRetention(databaseId, RETENTION_GROUPS[group]);
    for (const cp of automatic.slice(keep)) {
      if (cp.pinned || cp.isBase || isCheckpointProtected(cp.id)) continue;
      await deleteCheckpointRecord(databaseId, cp.id);
      removed.push(cp.id);
    }
  }
  return removed;
}

export async function collectGarbage(databaseId: string): Promise<number> {
  if (!databases.byId(databaseId)) return 0;
  const { removed } = await sweepObjects(databaseId, checkpoints.referencedObjects(databaseId));
  return removed;
}

export async function verifyCheckpointStore(databaseId: string): Promise<StoreCheck> {
  return verifyStoredObjects(databaseId, checkpoints.referencedObjects(databaseId));
}
