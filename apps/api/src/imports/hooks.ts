import type { ImportRecord } from "@lambdata/shared";
import { createCheckpoint } from "../checkpoints";
import { databases } from "../db/queries";

function baseCheckpointId(databaseId: string): string | null {
  return databases.byId(databaseId)?.baseCheckpointId ?? null;
}

export async function beforeReplace(databaseId: string, signal?: AbortSignal): Promise<string | null> {
  const result = await createCheckpoint(databaseId, {
    trigger: "pre-import",
    message: "Before replacing data from a file",
    signal,
  });
  return result.checkpointId;
}

export async function afterImport(databaseId: string, record: ImportRecord): Promise<string | null> {
  const result = await createCheckpoint(databaseId, {
    trigger: "import",
    message: `Imported from ${record.fileName}`,
    userId: record.importedByUserId,
  });
  return result.checkpointId ?? baseCheckpointId(databaseId);
}
