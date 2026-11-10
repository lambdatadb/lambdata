import type { CodeObjectFailure, Job, JobErrorCode } from "@lambdata/shared";

export type JobState = "queued" | "running" | "succeeded" | "done-with-errors" | "refused" | "failed";

export const CODE_REFUSAL: JobErrorCode = "restore.code-unrestorable";

type JobFacts = Pick<Job, "status" | "result"> & Partial<Pick<Job, "kind" | "error" | "errorCode" | "errorDetails" | "stage">>;

function isCodeFailure(value: unknown): value is CodeObjectFailure {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return typeof v.kind === "string" && typeof v.name === "string" && typeof v.error === "string";
}

export function readCodeFailures(value: unknown): CodeObjectFailure[] {
  return Array.isArray(value) ? value.filter(isCodeFailure) : [];
}

function resultField(job: JobFacts, key: string): unknown {
  const result = job.result;
  return result && typeof result === "object" ? (result as Record<string, unknown>)[key] : undefined;
}

export function isCodeRefusal(job: JobFacts): boolean {
  return job.status === "failed" && job.errorCode === CODE_REFUSAL;
}

export function isDoneWithErrors(job: JobFacts): boolean {
  if (job.status !== "succeeded") return false;
  return resultField(job, "outcome") === "done-with-errors" || readCodeFailures(resultField(job, "codeFailures")).length > 0;
}

export function jobState(job: JobFacts): JobState {
  if (job.status === "queued" || job.status === "running") return job.status;
  if (job.status === "failed") return isCodeRefusal(job) ? "refused" : "failed";
  return isDoneWithErrors(job) ? "done-with-errors" : "succeeded";
}

export function jobCodeFailures(job: JobFacts): CodeObjectFailure[] {
  if (job.status === "failed") return readCodeFailures(job.errorDetails?.codeFailures);
  if (job.status === "succeeded") return readCodeFailures(resultField(job, "codeFailures"));
  return [];
}

const RESTATED_SUMMARIES = [
  /^Rolled back anyway: the tables of \S+ are back, but /,
  /^The tables of \S+ are back, but \d+ view\(s\)/,
  /^The data was (?:imported|replaced), but \d+ view\(s\)/,
];

const PER_OBJECT = /^could not re-create (\w+) (.+?): /;

export function restatesCodeFailures(warning: string, failures: Pick<CodeObjectFailure, "kind" | "name">[]): boolean {
  if (failures.length === 0) return false;
  if (RESTATED_SUMMARIES.some((pattern) => pattern.test(warning))) return true;
  const match = PER_OBJECT.exec(warning);
  if (!match) return false;
  const kind = match[1]!.toLowerCase();
  const name = match[2]!.toLowerCase();
  return failures.some((f) => f.kind.toLowerCase() === kind && f.name.toLowerCase() === name);
}

export function visibleWarnings(job: JobFacts & Pick<Job, "warnings">): string[] {
  const failures = jobCodeFailures(job);
  return job.warnings.filter((w) => !restatesCodeFailures(w, failures));
}

export function createLimitations(job: JobFacts): string[] {
  if (job.kind !== "checkpoint.create" || job.status !== "succeeded") return [];
  const value = resultField(job, "limitations");
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string" && v.trim().length > 0) : [];
}

export function createVerified(job: JobFacts): boolean {
  return job.kind === "checkpoint.create" && job.status === "succeeded" && resultField(job, "verified") === true;
}

export function needsAttention(job: JobFacts): boolean {
  const state = jobState(job);
  return state === "failed" || state === "refused" || state === "done-with-errors" || createLimitations(job).length > 0;
}

const KIND_NOUNS: Record<string, [string, string]> = {
  view: ["view", "views"],
  trigger: ["trigger", "triggers"],
  procedure: ["procedure", "procedures"],
  function: ["function", "functions"],
  routine: ["routine", "routines"],
  event: ["event", "events"],
  sequence: ["sequence", "sequences"],
};

function joinList(parts: string[]): string {
  if (parts.length <= 1) return parts[0] ?? "";
  return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

export function describeFailureKinds(failures: Pick<CodeObjectFailure, "kind">[]): string {
  if (failures.length === 0) return "Some views, triggers or routines";
  const counts = new Map<string, number>();
  let other = 0;
  for (const f of failures) {
    const kind = f.kind.toLowerCase();
    if (KIND_NOUNS[kind]) counts.set(kind, (counts.get(kind) ?? 0) + 1);
    else other++;
  }
  const parts = [...counts].map(([kind, n]) => `${n} ${KIND_NOUNS[kind]![n === 1 ? 0 : 1]}`);
  if (other > 0) parts.push(`${other} ${other === 1 ? "other object" : "other objects"}`);
  return joinList(parts);
}

export function splitErrorMessage(message: string): { lead: string; items: string[] } {
  const text = message.trim();
  const firstSemi = text.indexOf("; ");
  if (firstSemi < 0) return { lead: text, items: [] };
  const head = text.slice(0, firstSemi);
  const boundary = head.lastIndexOf(". ");
  if (boundary < 0) return { lead: text, items: [] };
  const lead = text.slice(0, boundary + 1).trim();
  const items = text
    .slice(boundary + 2)
    .split("; ")
    .map((item) => item.trim().replace(/\.$/, ""))
    .filter(Boolean);
  if (items.length < 2) return { lead: text, items: [] };
  return { lead, items };
}

const TARGET_PATTERN = /\bRolling back to ([0-9a-f]{7,64})\b/i;

export function refusedTargetHash(job: JobFacts): string | null {
  for (const text of [job.error, job.stage]) {
    const match = text ? TARGET_PATTERN.exec(text) : null;
    if (match) return match[1]!.toLowerCase();
  }
  return null;
}
