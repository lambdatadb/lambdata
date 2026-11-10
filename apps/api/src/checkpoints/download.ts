import type { Checkpoint } from "@lambdata/shared";
import type { CheckpointEntryRecord } from "../db/queries/checkpoints";
import { assertObjectsPresent, toReadable } from "./restore";
import { downloadHeader, DOWNLOAD_POSTAMBLE } from "./sql";
import { acquireObjectLease, rawObjectStream } from "./store";

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

async function* streamBytes(stream: ReadableStream<Uint8Array>): AsyncGenerator<Uint8Array> {
  const reader = stream.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      if (value) yield value;
    }
  } finally {
    reader.releaseLock();
  }
}

export function downloadFileName(schema: string, cp: Checkpoint): string {
  const safe = schema.replace(/[^A-Za-z0-9_-]/g, "_") || "database";
  return `${safe}-${cp.shortHash}.sql.gz`;
}

export function checkpointDownloadStream(
  schema: string,
  cp: Checkpoint,
  entries: CheckpointEntryRecord[],
): ReadableStream<Uint8Array> {
  const release = acquireObjectLease(cp.databaseId);
  try {
    assertObjectsPresent(cp.databaseId, entries);
  } catch (err) {
    release();
    throw err;
  }
  const onError = (err: unknown): void => {
    console.error("[checkpoints] download failed:", err instanceof Error ? err.message : String(err));
  };
  if (cp.format === "legacy") {
    const legacy = entries.find((e) => e.kind === "legacy");
    if (!legacy) {
      release();
      throw new Error("the imported snapshot has no data entry");
    }
    return toReadable(streamBytes(rawObjectStream(cp.databaseId, legacy.objectHash)), onError, release);
  }
  const tables = entries.filter((e) => e.kind === "table").sort((a, b) => compare(a.name, b.name));
  const code = entries.find((e) => e.kind === "code");
  const header = Bun.gzipSync(
    downloadHeader({ schema, hash: cp.hash, createdAt: cp.createdAt, trigger: cp.trigger, message: cp.message }),
  );
  const footer = Bun.gzipSync(DOWNLOAD_POSTAMBLE);
  const parts = async function* (): AsyncGenerator<Uint8Array> {
    yield header;
    for (const t of tables) yield* streamBytes(rawObjectStream(cp.databaseId, t.objectHash));
    if (code) yield* streamBytes(rawObjectStream(cp.databaseId, code.objectHash));
    yield footer;
  };
  return toReadable(parts(), onError, release);
}
