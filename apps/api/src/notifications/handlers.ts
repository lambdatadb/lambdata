import type { AccessPolicy, Checkpoint, CheckpointTrigger, Job } from "@lambdata/shared";
import { checkpoints, imports, users } from "../db/queries";
import { notificationState } from "../db/queries/notifications";
import { healthCheck, mariadbExpected, mariadbState, type ReadyReason } from "../mariadb/controller";
import { diskStatus, formatBytes } from "../util/disk";
import type { AuditNote } from "./bus";
import {
  actorOf,
  anyEnabledDestination,
  cap,
  count,
  databaseRef,
  emit,
  forgetDatabase,
  forgetUser,
  knownUserName,
  mid,
  personName,
  rememberUser,
  subjectOf,
  type DatabaseRef,
} from "./emit";
import { cleanUserText, type EventField } from "./format";

const REFUSAL_MEMORY_MS = 6 * 60 * 60 * 1000;
const DISK_RECOVER_MARGIN = 0.05;

const refusals = new Map<string, number>();

function obj(details: unknown): Record<string, unknown> {
  return details && typeof details === "object" && !Array.isArray(details) ? (details as Record<string, unknown>) : {};
}

function str(v: unknown): string | null {
  return typeof v === "string" && v ? v : null;
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function dbPath(db: DatabaseRef | null, tab?: string, rest?: string): string | null {
  if (!db) return null;
  const base = `/databases/${encodeURIComponent(db.id)}`;
  if (!tab) return base;
  return rest ? `${base}/${tab}/${encodeURIComponent(rest)}` : `${base}/${tab}`;
}

function fieldsOf(...pairs: [string, string | null | undefined][]): EventField[] {
  return pairs.filter((p): p is [string, string] => typeof p[1] === "string" && p[1] !== "").map(([label, value]) => ({ label, value }));
}

function dbData(db: DatabaseRef | null): Record<string, string | number | boolean | null> {
  return db ? { databaseId: db.id } : {};
}

function checkpointLabel(cp: Checkpoint): string {
  return cleanUserText(cp.message) || "Checkpoint";
}

function sizeFacts(cp: Checkpoint): string {
  const parts: string[] = [];
  if (cp.tableCount !== null) parts.push(count(cp.tableCount, "table"));
  if (cp.rowCount !== null) parts.push(count(cp.rowCount, "row"));
  return parts.length > 0 ? ` It holds ${parts.join(" and ")}.` : "";
}

function codeObjects(n: number): string {
  return `${n.toLocaleString("en-US")} ${n === 1 ? "view, trigger, routine or event" : "views, triggers, routines or events"}`;
}

function onDatabaseCreated(note: AuditNote): void {
  const d = obj(note.details);
  emit("database.created", note.target, () => {
    const db = databaseRef(note.target, d.name);
    if (!db) return null;
    const actor = actorOf(note.userId);
    const mirror = d.kind === "mirror";
    const fromFile = d.importFrom !== undefined;
    return {
      title: `Database created: ${db.displayName}`,
      message: `${subjectOf(actor)} created ${mirror ? "the mirror " : ""}${db.displayName}${fromFile ? " from an uploaded file" : ""}.`,
      actor,
      database: db,
      fields: fieldsOf(["Database", db.displayName], ["Kind", mirror ? "Mirror" : "Standard"], ["By", actor?.displayName]),
      data: { ...dbData(db), kind: mirror ? "mirror" : "standard", fromFile },
      linkPath: dbPath(db),
    };
  });
}

function onDatabaseDeleted(note: AuditNote): void {
  const d = obj(note.details);
  emit("database.deleted", note.target, () => {
    const db = databaseRef(note.target, d.name);
    if (!db) return null;
    const actor = actorOf(note.userId);
    return {
      title: `Database deleted: ${db.displayName}`,
      message: `${subjectOf(actor)} deleted ${db.displayName} together with its data and checkpoints.`,
      actor,
      database: db,
      fields: fieldsOf(["Database", db.displayName], ["By", actor?.displayName]),
      data: dbData(db),
      linkPath: "/databases",
    };
  });
  if (note.target) forgetDatabase(note.target);
}

function onPasswordRotated(note: AuditNote): void {
  emit("database.password_rotated", note.target, () => {
    const db = databaseRef(note.target);
    if (!db) return null;
    const actor = actorOf(note.userId);
    return {
      title: `Password rotated: ${db.displayName}`,
      message: `${subjectOf(actor)} generated a new password for ${db.displayName}. Apps using the old password can no longer connect.`,
      actor,
      database: db,
      fields: fieldsOf(["Database", db.displayName], ["By", actor?.displayName]),
      data: dbData(db),
      linkPath: dbPath(db),
    };
  });
}

function onCheckpointCreated(note: AuditNote): void {
  const d = obj(note.details);
  const checkpointId = str(d.checkpointId);
  if (!checkpointId || d.unchanged === true) return;
  emit("checkpoint.created", note.target, () => {
    const cp = checkpoints.byId(checkpointId);
    const db = databaseRef(note.target);
    if (!cp || !db) return null;
    const actor = actorOf(note.userId);
    return {
      title: `Checkpoint made: ${checkpointLabel(cp)} (${cp.shortHash})`,
      message: `${subjectOf(actor)} made a checkpoint of ${db.displayName}.${sizeFacts(cp)}`,
      actor,
      database: db,
      fields: fieldsOf(["Database", db.displayName], ["Checkpoint", cp.shortHash], ["By", actor?.displayName]),
      data: {
        ...dbData(db),
        checkpointId: cp.id,
        hash: cp.shortHash,
        tables: cp.tableCount,
        rows: cp.rowCount,
        verified: d.verified === true,
      },
      linkPath: dbPath(db, "history", cp.id),
      occurredAt: cp.createdAt,
    };
  });
}

function rolledBack(note: AuditNote, failures: number, recovered: boolean): void {
  const d = obj(note.details);
  const type = failures > 0 ? "checkpoint.rollback_errors" : "checkpoint.rolled_back";
  emit(type, note.target, () => {
    const db = databaseRef(note.target);
    if (!db) return null;
    const checkpointId = str(d.checkpointId);
    const cp = checkpointId ? checkpoints.byId(checkpointId) : null;
    const hash = cp?.shortHash ?? str(d.hash) ?? "a checkpoint";
    const safetyId = str(d.safetyCheckpointId);
    const safety = safetyId ? checkpoints.byId(safetyId)?.shortHash : null;
    const actor = actorOf(note.userId);
    const who = recovered
      ? `A rollback of ${db.displayName} to checkpoint ${hash} was interrupted by a restart and has now finished.`
      : `${subjectOf(actor)} rolled ${db.displayName} back to checkpoint ${hash}.`;
    const errors =
      failures > 0 ? ` The tables are back, but ${codeObjects(failures)} could not be re-created and ${failures === 1 ? "is" : "are"} missing now.` : "";
    const saved = safety ? ` The state before the rollback is saved in checkpoint ${safety}.` : "";
    return {
      title: `${failures > 0 ? "Rolled back with errors" : "Rolled back"}: ${db.displayName} (${hash})`,
      message: `${who}${errors}${saved}`,
      actor,
      database: db,
      fields: fieldsOf(
        ["Database", db.displayName],
        ["Checkpoint", hash],
        ["Not re-created", failures > 0 ? String(failures) : null],
        ["By", actor?.displayName],
      ),
      data: {
        ...dbData(db),
        checkpointId: cp?.id ?? checkpointId,
        hash,
        safetyCheckpointId: safetyId,
        outcome: failures > 0 ? "done-with-errors" : "done",
        codeFailures: failures,
      },
      linkPath: dbPath(db, "history", cp?.id),
    };
  });
}

function onRollbackRefused(note: AuditNote): void {
  if (note.target) refusals.set(note.target, note.at);
  const d = obj(note.details);
  emit("checkpoint.rollback_refused", note.target, () => {
    const db = databaseRef(note.target);
    if (!db) return null;
    const hash = str(d.hash) ?? "a checkpoint";
    const actor = actorOf(note.userId);
    return {
      title: `Rollback refused: ${db.displayName}`,
      message: `${subjectOf(actor)} asked to roll ${db.displayName} back to checkpoint ${hash}. LambData stopped before changing anything because the checkpoint could not be brought back exactly. The live data is untouched.`,
      actor,
      database: db,
      fields: fieldsOf(["Database", db.displayName], ["Checkpoint", hash], ["By", actor?.displayName]),
      data: { ...dbData(db), checkpointId: str(d.checkpointId), hash },
      linkPath: dbPath(db, "history"),
    };
  });
}

function onCheckpointDeleted(note: AuditNote): void {
  const d = obj(note.details);
  emit("checkpoint.deleted", note.target, () => {
    const db = databaseRef(note.target);
    if (!db) return null;
    const hash = str(d.hash) ?? "a checkpoint";
    const actor = actorOf(note.userId);
    return {
      title: `Checkpoint deleted: ${db.displayName} (${hash})`,
      message: `${subjectOf(actor)} deleted checkpoint ${hash} of ${db.displayName}.`,
      actor,
      database: db,
      fields: fieldsOf(["Database", db.displayName], ["Checkpoint", hash], ["By", actor?.displayName]),
      data: { ...dbData(db), checkpointId: str(d.checkpointId), hash },
      linkPath: dbPath(db, "history"),
    };
  });
}

const ROLE_ARTICLE: Record<string, string> = { admin: "an admin", db_owner: "a database owner", viewer: "a viewer" };
const ROLE_LABEL: Record<string, string> = { admin: "Admin", db_owner: "Database owner", viewer: "Viewer" };

function onUserCreated(note: AuditNote): void {
  const id = note.target;
  if (!id) return;
  const name = rememberUser(id);
  emit("user.created", null, () => {
    const u = users.byId(id);
    const shown = name ?? (u ? personName(u) : "A new user");
    const actor = actorOf(note.userId);
    const role = u?.role ?? str(obj(note.details).role) ?? null;
    return {
      title: `User added: ${shown}`,
      message: `${subjectOf(actor)} added ${mid(shown)} to the console${role && ROLE_ARTICLE[role] ? ` as ${ROLE_ARTICLE[role]}` : ""}.`,
      actor,
      fields: fieldsOf(["User", shown], ["Role", role ? (ROLE_LABEL[role] ?? null) : null], ["By", actor?.displayName]),
      data: { userId: id, role },
      linkPath: "/users",
    };
  });
}

function onUserRemoved(note: AuditNote): void {
  const id = note.target;
  if (!id) return;
  const name = knownUserName(id);
  emit("user.removed", null, () => {
    const actor = actorOf(note.userId);
    return {
      title: name ? `User removed: ${name}` : "User removed",
      message: `${subjectOf(actor)} removed ${name ? mid(name) : "a user"} from the console.`,
      actor,
      fields: fieldsOf(["User", name], ["By", actor?.displayName]),
      data: { userId: id },
      linkPath: "/users",
    };
  });
  forgetUser(id);
}

function onDataApiAccess(note: AuditNote): void {
  const d = obj(note.details);
  const mode = str(d.mode);
  if ((mode !== "open" && mode !== "closed") || mode === str(d.previous)) return;
  const type = mode === "open" ? "data_api.opened" : "data_api.closed";
  emit(type, note.target, () => {
    const db = databaseRef(note.target, d.database);
    if (!db) return null;
    const actor = actorOf(note.userId);
    return {
      title: `${mode === "open" ? "Data API opened" : "Data API closed"}: ${db.displayName}`,
      message:
        mode === "open"
          ? `${subjectOf(actor)} opened ${db.displayName} to the Data API. Apps with App Auth tokens can now reach its tables, as far as its policies allow.`
          : `${subjectOf(actor)} closed ${db.displayName} to the Data API. Apps can no longer reach its tables through it.`,
      actor,
      database: db,
      fields: fieldsOf(["Database", db.displayName], ["By", actor?.displayName]),
      data: { ...dbData(db), mode },
      linkPath: "/data-api",
    };
  });
}

const POLICY_KEYS: (keyof AccessPolicy)[] = ["allowLan", "allowTailnet", "allowCloudflare", "requireCloudflareAccess", "restrictAppApis"];

function policyOf(v: unknown): AccessPolicy | null {
  const o = obj(v);
  if (!POLICY_KEYS.every((k) => typeof o[k] === "boolean")) return null;
  return Object.fromEntries(POLICY_KEYS.map((k) => [k, o[k] as boolean])) as unknown as AccessPolicy;
}

function describePolicy(p: AccessPolicy): string {
  const parts = [
    `LAN ${p.allowLan ? "allowed" : "blocked"}`,
    `tailnet ${p.allowTailnet ? "allowed" : "blocked"}`,
    `Cloudflare ${p.allowCloudflare ? "allowed" : "blocked"}`,
  ];
  if (p.requireCloudflareAccess) parts.push("Cloudflare Access required");
  if (p.restrictAppApis) parts.push("app APIs restricted");
  return parts.join(", ");
}

function onPolicyChanged(note: AuditNote): void {
  const d = obj(note.details);
  const from = policyOf(d.from);
  const to = policyOf(d.to);
  if (!to || (from && POLICY_KEYS.every((k) => from[k] === to[k]))) return;
  const byEnv = note.action === "network.policy.reset_by_env";
  emit("network.policy_changed", null, () => {
    const actor = actorOf(note.userId);
    return {
      title: "Access policy changed",
      message: byEnv
        ? `The access policy was reset to open by the server's ACCESS_POLICY environment setting: ${describePolicy(to)}.`
        : `${subjectOf(actor)} changed which networks can reach the console: ${describePolicy(to)}.`,
      actor,
      fields: fieldsOf(["By", actor?.displayName]),
      data: { ...to, resetByEnvironment: byEnv },
      linkPath: "/network",
    };
  });
}

export function handleAudit(note: AuditNote): void {
  switch (note.action) {
    case "db.create":
      return onDatabaseCreated(note);
    case "db.delete":
      return onDatabaseDeleted(note);
    case "db.rotate-password":
      return onPasswordRotated(note);
    case "db.update":
      if (note.target) databaseRef(note.target);
      return;
    case "checkpoint.create":
      return onCheckpointCreated(note);
    case "checkpoint.restore": {
      const d = obj(note.details);
      return rolledBack(note, d.outcome === "done-with-errors" ? Math.max(1, num(d.codeFailures) ?? 1) : 0, false);
    }
    case "checkpoint.restore.recovered":
      return rolledBack(note, num(obj(note.details).failures) ?? 0, true);
    case "checkpoint.restore.refused":
      return onRollbackRefused(note);
    case "checkpoint.delete":
      return onCheckpointDeleted(note);
    case "user.create":
      return onUserCreated(note);
    case "user.update":
      if (note.target) rememberUser(note.target);
      return;
    case "user.delete":
      return onUserRemoved(note);
    case "data_api.access.update":
      return onDataApiAccess(note);
    case "network.policy.update":
    case "network.policy.reset_by_env":
      return onPolicyChanged(note);
  }
}

const AUTO_LABELS: Partial<Record<CheckpointTrigger, { title: string; text: (db: string) => string }>> = {
  scheduled: { title: "Scheduled checkpoint", text: (db) => `LambData made a scheduled checkpoint of ${db}.` },
  sync: { title: "Sync checkpoint", text: (db) => `LambData recorded a checkpoint of ${db} after syncing it.` },
  "pre-sync": { title: "Safety checkpoint", text: (db) => `LambData saved the local changes of ${db} before syncing over them.` },
  "pre-restore": { title: "Safety checkpoint", text: (db) => `LambData saved ${db} before rolling it back.` },
  "pre-import": { title: "Safety checkpoint", text: (db) => `LambData saved ${db} before replacing its data from a file.` },
  import: { title: "Import checkpoint", text: (db) => `LambData recorded a checkpoint of ${db} after an import.` },
  legacy: { title: "Converted snapshot", text: (db) => `An old snapshot of ${db} became a checkpoint.` },
};

function autoCheckpoints(job: Job, ids: unknown[]): void {
  const seen = new Set<string>();
  for (const raw of ids) {
    const id = str(raw);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    emit("checkpoint.auto_created", job.databaseId, () => {
      const cp = checkpoints.byId(id);
      if (!cp || cp.databaseId !== job.databaseId || cp.trigger === "manual" || cp.createdAt < job.createdAt) return null;
      const db = databaseRef(job.databaseId);
      if (!db) return null;
      const label = AUTO_LABELS[cp.trigger] ?? { title: "Automatic checkpoint", text: (n: string) => `LambData made a checkpoint of ${n}.` };
      return {
        title: `${label.title}: ${db.displayName} (${cp.shortHash})`,
        message: `${label.text(db.displayName)}${sizeFacts(cp)}`,
        actor: null,
        database: db,
        fields: fieldsOf(["Database", db.displayName], ["Checkpoint", cp.shortHash]),
        data: { ...dbData(db), checkpointId: cp.id, hash: cp.shortHash, trigger: cp.trigger, tables: cp.tableCount, rows: cp.rowCount },
        linkPath: dbPath(db, "history", cp.id),
        occurredAt: cp.createdAt,
      };
    });
  }
}

function startedBy(actor: { displayName: string } | null): string {
  return actor ? ` that ${mid(actor.displayName)} started` : "";
}

function onCheckpointJobFailed(job: Job, rollback: boolean): void {
  emit("checkpoint.failed", job.databaseId, () => {
    const db = databaseRef(job.databaseId);
    if (!db) return null;
    const actor = actorOf(job.createdByUserId);
    const what = rollback ? "A rollback" : job.createdByUserId ? "A checkpoint" : "A scheduled checkpoint";
    return {
      title: `${rollback ? "Rollback failed" : "Checkpoint failed"}: ${db.displayName}`,
      message: `${what} of ${db.displayName}${startedBy(actor)} did not finish. Open the console to see what went wrong.`,
      actor,
      database: db,
      fields: fieldsOf(["Database", db.displayName], ["By", actor?.displayName]),
      data: { ...dbData(db), jobId: job.id, operation: rollback ? "rollback" : "checkpoint" },
      linkPath: dbPath(db, "history"),
    };
  });
}

function syncStateKey(databaseId: string): string {
  return `sync.failed:${databaseId}`;
}

function onSyncFinished(job: Job): void {
  const r = job.result ?? {};
  const dbId = job.databaseId;
  const failures = num(Array.isArray(r.codeFailures) ? r.codeFailures.length : null) ?? 0;
  const withErrors = r.outcome === "done-with-errors" || failures > 0;
  if (dbId && anyEnabledDestination()) {
    const prior = notificationState.get(syncStateKey(dbId));
    if (prior !== null) {
      notificationState.delete(syncStateKey(dbId));
      const failed = Number(obj(safeParse(prior)).failures) || 1;
      emit("sync.recovered", dbId, () => {
        const db = databaseRef(dbId);
        if (!db) return null;
        return {
          title: `Sync recovered: ${db.displayName}`,
          message: `${db.displayName} synced from its source again after ${count(failed, "failed sync")}.`,
          database: db,
          fields: fieldsOf(["Mirror", db.displayName], ["Failed before", String(failed)]),
          data: { ...dbData(db), previousFailures: failed },
          linkPath: dbPath(db, "sync"),
        };
      });
    }
  }
  emit("sync.finished", dbId, () => {
    const db = databaseRef(dbId);
    if (!db) return null;
    const actor = actorOf(job.createdByUserId);
    const tables = num(r.tables);
    const copied = tables !== null && tables > 0 ? ` and copied ${count(tables, "table")}` : "";
    const errors = withErrors ? ` It finished with errors: ${codeObjects(Math.max(1, failures))} could not be created.` : "";
    const lead = actor ? `${actor.displayName} synced ${db.displayName} from its source` : `${db.displayName} synced from its source`;
    return {
      title: `${withErrors ? "Sync finished with errors" : "Sync finished"}: ${db.displayName}`,
      message: `${lead}${copied}.${errors}`,
      actor,
      database: db,
      fields: fieldsOf(["Mirror", db.displayName], ["Tables", tables !== null ? String(tables) : null], ["By", actor?.displayName]),
      data: { ...dbData(db), tables, outcome: withErrors ? "done-with-errors" : "done", codeFailures: failures, jobId: job.id },
      linkPath: dbPath(db, "sync"),
    };
  });
  autoCheckpoints(job, [r.preSyncCheckpointId, r.checkpointId]);
}

function safeParse(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function onSyncFailed(job: Job): void {
  const dbId = job.databaseId;
  if (dbId && anyEnabledDestination()) {
    const prior = obj(safeParse(notificationState.get(syncStateKey(dbId)) ?? "null"));
    const failures = (Number(prior.failures) || 0) + 1;
    notificationState.set(syncStateKey(dbId), JSON.stringify({ failures, since: Number(prior.since) || Date.now() }));
  }
  emit("sync.failed", dbId, () => {
    const db = databaseRef(dbId);
    if (!db) return null;
    const actor = actorOf(job.createdByUserId);
    return {
      title: `Sync failed: ${db.displayName}`,
      message: actor
        ? `A sync of ${db.displayName}${startedBy(actor)} could not copy its source. Open the console to see why.`
        : `${db.displayName} could not sync from its source. Open the console to see why.`,
      actor,
      database: db,
      fields: fieldsOf(["Mirror", db.displayName], ["By", actor?.displayName]),
      data: { ...dbData(db), jobId: job.id },
      linkPath: dbPath(db, "sync"),
    };
  });
}

function onImportFinished(job: Job): void {
  const r = job.result ?? {};
  const importId = str(r.importId);
  emit("import.finished", job.databaseId, () => {
    const db = databaseRef(job.databaseId);
    if (!db) return null;
    const record = importId ? imports.recordById(importId) : null;
    const actor = actorOf(job.createdByUserId);
    const source = job.kind === "import.sqlite" ? "a SQLite file" : "a SQL dump";
    const failures = Array.isArray(r.codeFailures) ? r.codeFailures.length : 0;
    const tables = num(r.tableCount);
    const rows = num(r.rowCount);
    const facts = [tables !== null ? count(tables, "table") : null, rows !== null ? count(rows, "row") : null].filter(Boolean);
    const verb = record?.mode === "replace" ? `replaced the data of ${db.displayName} from ${source}` : `filled ${db.displayName} from ${source}`;
    const errors = failures > 0 ? ` ${cap(codeObjects(failures))} from the file could not be created.` : "";
    return {
      title: `${failures > 0 ? "Import finished with errors" : "Import finished"}: ${db.displayName}`,
      message: `${subjectOf(actor)} ${verb}${facts.length > 0 ? `: ${facts.join(", ")}` : ""}.${errors}`,
      actor,
      database: db,
      fields: fieldsOf(
        ["Database", db.displayName],
        ["Tables", tables !== null ? String(tables) : null],
        ["Rows", rows !== null ? rows.toLocaleString("en-US") : null],
        ["By", actor?.displayName],
      ),
      data: {
        ...dbData(db),
        mode: record?.mode ?? null,
        format: job.kind === "import.sqlite" ? "sqlite" : "sql",
        tables,
        rows,
        outcome: failures > 0 ? "done-with-errors" : "done",
        codeFailures: failures,
      },
      linkPath: dbPath(db),
    };
  });
  autoCheckpoints(job, [r.safetyCheckpointId, r.checkpointId]);
}

function onImportFailed(job: Job): void {
  emit("import.failed", job.databaseId, () => {
    const db = databaseRef(job.databaseId);
    if (!db) return null;
    const actor = actorOf(job.createdByUserId);
    return {
      title: `Import failed: ${db.displayName}`,
      message: `An import into ${db.displayName}${startedBy(actor)} did not finish. Open the console to see why.`,
      actor,
      database: db,
      fields: fieldsOf(["Database", db.displayName], ["By", actor?.displayName]),
      data: { ...dbData(db), jobId: job.id, format: job.kind === "import.sqlite" ? "sqlite" : "sql" },
      linkPath: dbPath(db, "import"),
    };
  });
}

function refusedDuring(job: Job): boolean {
  if (!job.databaseId) return false;
  const at = refusals.get(job.databaseId);
  for (const [id, t] of refusals) if (Date.now() - t > REFUSAL_MEMORY_MS) refusals.delete(id);
  return at !== undefined && at >= job.createdAt;
}

export function handleJobFinished(job: Job): void {
  const ok = job.status === "succeeded";
  if (job.status !== "succeeded" && job.status !== "failed") return;
  switch (job.kind) {
    case "checkpoint.create":
      if (ok) autoCheckpoints(job, [job.result?.checkpointId]);
      else onCheckpointJobFailed(job, false);
      return;
    case "checkpoint.restore":
      if (ok) autoCheckpoints(job, [job.result?.safetyCheckpointId]);
      else if (job.errorCode !== "restore.code-unrestorable" && !refusedDuring(job)) onCheckpointJobFailed(job, true);
      return;
    case "sync.run":
      if (ok) onSyncFinished(job);
      else onSyncFailed(job);
      return;
    case "import.sqlite":
    case "import.sql":
      if (ok) onImportFinished(job);
      else onImportFailed(job);
      return;
  }
}

export function handleSnapshotUnconverted(snapshotId: string, databaseId: string): void {
  emit("snapshot.unconverted", databaseId, () => {
    const failure = checkpoints.conversionFailures(databaseId).find((f) => f.snapshotId === snapshotId);
    if (!failure || failure.attempts !== 1) return null;
    const db = databaseRef(databaseId);
    if (!db) return null;
    const date = new Date(failure.createdAt).toISOString().slice(0, 10);
    return {
      title: `Snapshot not converted: ${db.displayName}`,
      message: `An old snapshot of ${db.displayName} from ${date} could not be turned into a checkpoint. It is kept, listed in the database's history as not converted, and retried every hour.`,
      database: db,
      fields: fieldsOf(["Database", db.displayName], ["Snapshot from", date]),
      data: { ...dbData(db), snapshotId, snapshotCreatedAt: failure.createdAt },
      linkPath: dbPath(db, "history"),
    };
  });
}

const MARIADB_KEY = "mariadb.down";
const DISK_KEY = "disk.low";

function minutesSince(since: number): string {
  const minutes = Math.max(1, Math.round((Date.now() - since) / 60_000));
  return count(minutes, "minute");
}

async function emitMariaDbDown(unexpectedRestart: boolean): Promise<void> {
  let failedStart = false;
  if (!unexpectedRestart) {
    try {
      const health = await healthCheck();
      failedStart = /failed to start/i.test(health.error ?? "");
    } catch {}
  }
  emit("mariadb.down", null, () => ({
    title: failedStart ? "MariaDB failed to start" : "MariaDB is down",
    message: failedStart
      ? "The database server failed to start. LambData keeps retrying; databases are unreachable until it starts."
      : "The database server stopped unexpectedly. LambData is restarting it; databases are unreachable until it is back.",
    data: { state: mariadbState(), failedToStart: failedStart },
    linkPath: "/",
  }));
}

function emitMariaDbRecovered(since: number | null): void {
  emit("mariadb.recovered", null, () => ({
    title: "MariaDB is back",
    message: since ? `The database server is running again after about ${minutesSince(since)}.` : "The database server is running again.",
    data: { downSince: since },
    linkPath: "/",
  }));
}

export async function checkMariaDb(readyReason?: ReadyReason): Promise<void> {
  if (!anyEnabledDestination()) return;
  const marked = notificationState.get(MARIADB_KEY);
  const since = marked !== null ? Number(obj(safeParse(marked)).since) || null : null;
  if (readyReason) {
    if (marked !== null) {
      notificationState.delete(MARIADB_KEY);
      emitMariaDbRecovered(since);
    } else if (readyReason === "restart" || readyReason === "retry") {
      await emitMariaDbDown(true);
      emitMariaDbRecovered(null);
    }
    return;
  }
  if (!mariadbExpected()) return;
  const state = mariadbState();
  if ((state === "restarting" || state === "failed") && marked === null) {
    notificationState.set(MARIADB_KEY, JSON.stringify({ since: Date.now() }));
    await emitMariaDbDown(false);
  } else if (state === "running" && marked !== null) {
    notificationState.delete(MARIADB_KEY);
    emitMariaDbRecovered(since);
  }
}

export function checkDisk(): void {
  if (!anyEnabledDestination()) return;
  const status = diskStatus();
  if (status.freeBytes === null) return;
  const marked = notificationState.get(DISK_KEY) !== null;
  const free = formatBytes(status.freeBytes);
  const floor = formatBytes(status.floorBytes);
  if (!marked && status.belowFloor) {
    notificationState.set(DISK_KEY, JSON.stringify({ since: Date.now() }));
    emit("disk.low", null, () => ({
      title: `Disk space low: ${free} free`,
      message: `Free space on the data volume fell below the ${floor} floor. LambData refuses uploads, files in Storage, checkpoints and syncs until space is freed, so that MariaDB keeps running.`,
      fields: fieldsOf(["Free", free], ["Floor", floor]),
      data: { freeBytes: status.freeBytes, floorBytes: status.floorBytes, totalBytes: status.totalBytes },
      linkPath: "/settings",
    }));
  } else if (marked && status.freeBytes >= status.floorBytes * (1 + DISK_RECOVER_MARGIN)) {
    notificationState.delete(DISK_KEY);
    emit("disk.recovered", null, () => ({
      title: `Disk space recovered: ${free} free`,
      message: `Free space on the data volume is back above the ${floor} floor. Uploads, checkpoints and syncs work again.`,
      fields: fieldsOf(["Free", free], ["Floor", floor]),
      data: { freeBytes: status.freeBytes, floorBytes: status.floorBytes, totalBytes: status.totalBytes },
      linkPath: "/settings",
    }));
  }
}
