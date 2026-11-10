import type { CodeObjectFailure, ImportJobResult, Job } from "@lambdata/shared";
import { formatDuration, pluralize } from "../../lib/format";
import { readCodeFailures } from "../../lib/jobOutcome";

export interface ImportOutcome extends Omit<ImportJobResult, "durationMs" | "outcome" | "codeFailures"> {
  durationMs: number | null;
  withErrors: boolean;
  codeFailures: CodeObjectFailure[];
}

export function isImportJob(job: Pick<Job, "kind"> | null | undefined): boolean {
  return job?.kind === "import.sqlite" || job?.kind === "import.sql";
}

export function importOutcome(job: Job | null | undefined): ImportOutcome | null {
  const result = job?.result as (Partial<ImportJobResult> & { durationMs?: unknown; outcome?: unknown; codeFailures?: unknown }) | null | undefined;
  if (!result || typeof result.importId !== "string") return null;
  const codeFailures = readCodeFailures(result.codeFailures);
  return {
    importId: result.importId,
    tableCount: typeof result.tableCount === "number" ? result.tableCount : null,
    rowCount: typeof result.rowCount === "number" ? result.rowCount : null,
    safetyCheckpointId: typeof result.safetyCheckpointId === "string" ? result.safetyCheckpointId : null,
    checkpointId: typeof result.checkpointId === "string" ? result.checkpointId : null,
    durationMs: typeof result.durationMs === "number" && Number.isFinite(result.durationMs) ? result.durationMs : null,
    withErrors: result.outcome === "done-with-errors" || codeFailures.length > 0,
    codeFailures,
  };
}

export function importContents(result: ImportOutcome | null): string | null {
  if (!result) return null;
  const parts: string[] = [];
  if (result.tableCount !== null) parts.push(pluralize(result.tableCount, "table"));
  if (result.rowCount !== null) parts.push(pluralize(result.rowCount, "row"));
  return parts.length ? parts.join(" and ") : null;
}

export function importSuccessText(result: ImportOutcome | null, mode: "create" | "replace"): string {
  const contents = importContents(result);
  const loaded = contents ? `${contents} ${mode === "create" ? "imported" : "are live"}` : mode === "create" ? "The data is imported" : "The new data is live";
  const timing = result?.durationMs != null ? ` (loading took ${formatDuration(result.durationMs)})` : "";
  const errors = result?.withErrors
    ? " The tables are in place, but some views, triggers or routines from the file could not be created; they are listed below."
    : "";
  const undo =
    mode === "replace" && result?.safetyCheckpointId
      ? " The data from before is kept in a safety checkpoint, so this can be undone from History."
      : "";
  return `${loaded}${timing}.${errors}${undo}`;
}
