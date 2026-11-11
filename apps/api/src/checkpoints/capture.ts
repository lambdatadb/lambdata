import type { CheckpointCreateJobResult, CheckpointTrigger } from "@lambdata/shared";
import { checkpoints, databases } from "../db/queries";
import type { CheckpointEntryRecord } from "../db/queries/checkpoints";
import { captureCodeRecords, renderCodeRecords, type CodeRecord } from "../mariadb/codeObjects";
import { openAdminConnection } from "../mariadb/controller";
import { swapRecoveryPending } from "../mariadb/schemaSwap";
import { newId } from "../util/id";
import { commitHash, treeHash, type TreeItem } from "./hash";
import { ObjectPins, ObjectWriter, removeObject, sha256Hex, storeBytes, type StoredObject } from "./store";
import {
  captureSchemaTables,
  displayName,
  openCaptureConnection,
  readTableStats,
  tableDataBytes,
  type SchemaDefaults,
  type TableStats,
} from "./tables";

export { TABLE_TYPES } from "./tables";
export const CODE_ENTRY_NAME = "code";
export const LOCAL_TOOL_TIMEOUT_MS = 6 * 60 * 60 * 1000;

export interface ProgressHooks {
  readonly jobId?: string;
  stage?(label: string): void;
  progress?(fraction: number | null): void;
  warn?(message: string): void;
}

export interface CreateCheckpointOptions {
  trigger: CheckpointTrigger;
  message?: string | null;
  userId?: string | null;
  allowUnchanged?: boolean;
  hooks?: ProgressHooks;
  exclude?: ReadonlySet<string>;
  signal?: AbortSignal;
}

export type TableStat = TableStats;

export interface LiveStats {
  tables: TableStats[];
  codeObjects: number;
  dataBytes: number;
}

const DEFAULT_MESSAGES: Record<CheckpointTrigger, string> = {
  manual: "Manual checkpoint",
  scheduled: "Automatic checkpoint",
  sync: "After sync",
  "pre-sync": "Before sync",
  "pre-restore": "Before rolling back",
  "pre-import": "Before import",
  "pre-agent": "Before changes by an access token",
  import: "Imported data",
  legacy: "Imported snapshot",
};

const MAX_MESSAGE_LENGTH = 500;

export function normalizeMessage(message: string | null | undefined, trigger: CheckpointTrigger): string {
  const flat = (message ?? "").replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, " ").trim();
  const text = flat || DEFAULT_MESSAGES[trigger];
  return text.length > MAX_MESSAGE_LENGTH ? text.slice(0, MAX_MESSAGE_LENGTH) : text;
}

export function schemaTreeItem(defaults: SchemaDefaults | null): TreeItem[] {
  if (!defaults) return [];
  return [{ kind: "schema", name: "defaults", objectHash: sha256Hex(`${defaults.characterSet}\u0000${defaults.collation}`) }];
}

export function checkpointTreeHash(entries: CheckpointEntryRecord[], defaults: SchemaDefaults | null): string {
  return treeHash([...entries, ...schemaTreeItem(defaults)]);
}

export async function captureLiveCode(schema: string): Promise<CodeRecord[]> {
  const conn = await openAdminConnection();
  try {
    return await captureCodeRecords(conn, schema);
  } finally {
    await conn.end().catch(() => conn.destroy());
  }
}

export async function liveCodeHash(schema: string): Promise<string | null> {
  const records = await captureLiveCode(schema);
  return records.length > 0 ? sha256Hex(renderCodeRecords(records)) : null;
}

async function codeObjectCount(conn: Awaited<ReturnType<typeof openCaptureConnection>>, schema: string): Promise<number> {
  const [rows] = await conn.query(
    `SELECT (SELECT COUNT(*) FROM information_schema.VIEWS WHERE TABLE_SCHEMA = ?)
          + (SELECT COUNT(*) FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = ?)
          + (SELECT COUNT(*) FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA = ?)
          + (SELECT COUNT(*) FROM information_schema.EVENTS WHERE EVENT_SCHEMA = ?) AS n`,
    [schema, schema, schema, schema],
  );
  return Number((rows as { n: unknown }[])[0]?.n ?? 0);
}

export async function collectLiveStats(schema: string, consistent: boolean): Promise<LiveStats> {
  const conn = await openCaptureConnection();
  try {
    if (consistent) {
      await conn.query("SET SESSION TRANSACTION ISOLATION LEVEL REPEATABLE READ");
      await conn.query("START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY");
    }
    const tables = await readTableStats(conn, schema);
    const dataBytes = await tableDataBytes(conn, schema);
    const codeObjects = await codeObjectCount(conn, schema);
    if (consistent) await conn.query("COMMIT").catch(() => {});
    return { tables, codeObjects, dataBytes };
  } finally {
    await conn.end().catch(() => conn.destroy());
  }
}

function invalidViewNote(name: string): string {
  return `view ${displayName(name)} could not be queried when this checkpoint was taken (it refers to a table, column or function that does not exist); rolling back keeps or re-creates it only where MariaDB accepts its definition`;
}

export function invalidViewNames(limitations: string[]): Set<string> {
  const out = new Set<string>();
  for (const l of limitations) {
    const m = /^view (.+) could not be queried when this checkpoint was taken/.exec(l);
    if (m) out.add(m[1]!);
  }
  return out;
}

export async function captureCheckpoint(
  databaseId: string,
  opts: CreateCheckpointOptions,
): Promise<CheckpointCreateJobResult> {
  const hooks = opts.hooks ?? {};
  const row = databases.byId(databaseId);
  if (!row) throw new Error("database not found");
  const schema = row.name;
  if (swapRecoveryPending(schema)) {
    throw new Error(`an interrupted replacement of ${schema} is still being completed, so no checkpoint was taken; try again shortly`);
  }
  const created: StoredObject[] = [];
  const pins = new ObjectPins(databaseId);
  try {
    hooks.stage?.("Reading the database");
    hooks.progress?.(0);
    const snap = await captureSchemaTables(schema, {
      exclude: opts.exclude,
      signal: opts.signal,
      stage: (label) => hooks.stage?.(label),
      progress: (f) => hooks.progress?.(Math.min(0.9, f * 0.9)),
      open: async () => {
        const writer = await ObjectWriter.open(databaseId, pins);
        return {
          write: (b: Uint8Array) => writer.write(b),
          abort: () => writer.abort(),
          async finish() {
            const object = await writer.finish();
            if (object.isNew) created.push(object);
            return object;
          },
        };
      },
    });
    const entries: CheckpointEntryRecord[] = snap.tables.map((t) => ({
      kind: "table",
      name: t.name,
      objectHash: t.result.hash,
      rowCount: t.rowCount,
      logicalBytes: t.result.logicalBytes,
      storedBytes: t.result.storedBytes,
      schemaHash: t.schemaHash,
      checksum: t.checksum,
      autoIncrement: t.autoIncrement ?? null,
    }));
    const limitations = [...snap.limitations];
    hooks.stage?.("Capturing views, triggers and routines");
    const records = await captureLiveCode(schema);
    for (const r of records) if (r.kind === "VIEW" && r.invalid) limitations.push(invalidViewNote(r.name));
    if (records.length > 0) {
      const code = await storeBytes(databaseId, renderCodeRecords(records), pins);
      if (code.isNew) created.push(code);
      entries.push({
        kind: "code",
        name: CODE_ENTRY_NAME,
        objectHash: code.hash,
        rowCount: null,
        logicalBytes: code.logicalBytes,
        storedBytes: code.storedBytes,
        schemaHash: null,
        checksum: null,
        autoIncrement: null,
      });
    }
    hooks.progress?.(0.95);
    const tree = checkpointTreeHash(entries, snap.schemaDefaults);
    const baseId = databases.byId(databaseId)?.baseCheckpointId ?? null;
    const base = baseId ? checkpoints.byId(baseId) : null;
    const parent = base && base.databaseId === databaseId ? base : null;
    if (parent && parent.treeHash === tree && !opts.allowUnchanged) {
      checkpoints.refreshEntryStats(
        parent.id,
        entries
          .filter((e) => e.kind === "table")
          .map((e) => ({ name: e.name, rowCount: e.rowCount, schemaHash: e.schemaHash, checksum: e.checksum, autoIncrement: e.autoIncrement ?? null })),
      );
      hooks.progress?.(1);
      return { checkpointId: null, unchanged: true, ...(limitations.length > 0 ? { limitations } : {}) };
    }
    const createdAt = Date.now();
    const message = normalizeMessage(opts.message, opts.trigger);
    const id = newId("cp");
    const tables = entries.filter((e) => e.kind === "table");
    const newHashes = new Set(created.map((o) => o.hash));
    checkpoints.insert(
      {
        id,
        databaseId,
        hash: commitHash({ parentHash: parent?.hash ?? null, treeHash: tree, message, trigger: opts.trigger, createdAt }),
        treeHash: tree,
        parentId: parent?.id ?? null,
        message,
        trigger: opts.trigger,
        format: "v1",
        createdByUserId: opts.userId ?? null,
        createdAt,
        tableCount: tables.length,
        rowCount: tables.every((t) => t.rowCount !== null)
          ? tables.reduce((n, t) => n + (t.rowCount ?? 0), 0)
          : null,
        logicalBytes: entries.reduce((n, e) => n + e.logicalBytes, 0),
        storedBytes: entries.reduce((n, e) => n + e.storedBytes, 0),
        newBytes: entries.filter((e) => newHashes.has(e.objectHash)).reduce((n, e) => n + e.storedBytes, 0),
        schemaCharset: snap.schemaDefaults?.characterSet ?? null,
        schemaCollation: snap.schemaDefaults?.collation ?? null,
        limitations,
      },
      entries,
      true,
    );
    hooks.progress?.(1);
    return { checkpointId: id, unchanged: false, ...(limitations.length > 0 ? { limitations } : {}) };
  } catch (err) {
    pins.release();
    for (const o of created) {
      await removeObject(databaseId, o.hash, () => !checkpoints.isObjectReferenced(databaseId, o.hash)).catch(() => {});
    }
    throw err;
  } finally {
    pins.release();
  }
}
