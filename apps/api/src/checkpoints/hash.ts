import type { CheckpointTrigger } from "@lambdata/shared";
import { sha256Hex } from "./store";

export interface TreeItem {
  kind: string;
  name: string;
  objectHash: string;
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function treeHash(items: TreeItem[]): string {
  const sorted = [...items].sort((a, b) => compare(a.kind, b.kind) || compare(a.name, b.name));
  return sha256Hex(JSON.stringify(sorted.map((i) => [i.kind, i.name, i.objectHash])));
}

export function commitHash(p: {
  parentHash: string | null;
  treeHash: string | null;
  message: string;
  trigger: CheckpointTrigger;
  createdAt: number;
  legacyObjectHash?: string;
}): string {
  const body: Record<string, unknown> = {
    parent: p.parentHash,
    tree: p.treeHash,
    message: p.message,
    trigger: p.trigger,
    createdAt: p.createdAt,
  };
  if (p.legacyObjectHash) body.legacyObject = p.legacyObjectHash;
  return sha256Hex(JSON.stringify(body));
}
