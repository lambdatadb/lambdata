import type { JobKind, JobStatus } from "@lambdata/shared";

const KIND_LABELS: Record<JobKind, string> = {
  "checkpoint.create": "Checkpoint",
  "checkpoint.restore": "Rollback",
  "sync.run": "Mirror sync",
  "import.sqlite": "SQLite import",
  "import.sql": "SQL dump import",
};

const KIND_SUBJECTS: Record<JobKind, { subject: string; running: string }> = {
  "checkpoint.create": { subject: "A checkpoint", running: "being created" },
  "checkpoint.restore": { subject: "A rollback", running: "running" },
  "sync.run": { subject: "A sync", running: "running" },
  "import.sqlite": { subject: "An import", running: "running" },
  "import.sql": { subject: "An import", running: "running" },
};

export function jobKindLabel(kind: JobKind | string): string {
  return (KIND_LABELS as Record<string, string>)[kind] ?? kind;
}

export function jobKindNoun(kind: JobKind | string): string {
  const label = jobKindLabel(kind);
  return /^[A-Z]{2}/.test(label) ? label : label.charAt(0).toLowerCase() + label.slice(1);
}

export function jobBusyText(kind: JobKind | string, status: JobStatus | string = "running"): string {
  const entry = (KIND_SUBJECTS as Record<string, { subject: string; running: string }>)[kind];
  const subject = entry?.subject ?? "Another operation";
  if (status === "queued") return `${subject} is already queued`;
  return `${subject} is already ${entry?.running ?? "running"}`;
}

const RAW_CONFLICT = /\ban? ([a-z]+\.[a-z]+) job is already (queued|running)\b/i;

export function friendlyJobConflict(message: string): string | null {
  const match = RAW_CONFLICT.exec(message);
  if (!match) return null;
  return `${jobBusyText(match[1]!, match[2]!.toLowerCase())} for this database.`;
}
