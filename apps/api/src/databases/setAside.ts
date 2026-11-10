import type { RowDataPacket } from "mysql2/promise";
import type { Database, MoveBackSetAsideTableResponse, SetAsideKind, SetAsideSchema, SetAsideTable } from "@lambdata/shared";
import { db } from "../db/client";
import { databases } from "../db/queries";
import { readJournals } from "../mariadb/journal";
import { withRootConnection } from "../mariadb/controller";
import { quoteName } from "../mariadb/codeObjects";
import { QUARANTINE_PREFIX, STAGING_PREFIX, TRASH_PREFIX, swapInProgress } from "../mariadb/schemaSwap";
import { quoteIdent } from "../util/ident";

const SUFFIX_LENGTH = 8;
const MAX_IDENT_LENGTH = 64;
const TABLE_TYPES = ["BASE TABLE", "SYSTEM VERSIONED", "SEQUENCE"];
const COUNT_LIMIT_SEC = 2;

export class SetAsideError extends Error {
  readonly status: 404 | 409;

  constructor(status: 404 | 409, message: string) {
    super(message);
    this.name = "SetAsideError";
    this.status = status;
  }
}

interface JournalFields {
  live?: string;
  staging?: string;
  trash?: string;
  databaseId?: string | null;
  createdAt?: number;
  phase?: string;
}

interface Candidate {
  schema: string;
  kind: SetAsideKind;
  createdAt: number | null;
}

function slugFor(prefix: string, live: string): string {
  const room = MAX_IDENT_LENGTH - prefix.length - SUFFIX_LENGTH - 1;
  return live.toLowerCase().replace(/[^a-z0-9_]/g, "_").slice(0, room);
}

function namePattern(prefix: string): RegExp {
  return new RegExp(`^${prefix}[0-9a-z]{${SUFFIX_LENGTH}}_([a-z0-9_]+)$`);
}

const QUARANTINE_NAME = namePattern(QUARANTINE_PREFIX);
const TRASH_NAME = namePattern(TRASH_PREFIX);

export function isSetAsideName(name: string): boolean {
  return name.length <= MAX_IDENT_LENGTH && (QUARANTINE_NAME.test(name) || TRASH_NAME.test(name));
}

function journals(): JournalFields[] {
  return readJournals<JournalFields>("swap")
    .map((j) => j.data)
    .filter((j): j is JournalFields => j !== null && typeof j === "object");
}

function quarantineAudit(): Map<string, { databaseId: string | null; at: number }> {
  const rows = db
    .query("SELECT target, details, at FROM audit_log WHERE action = 'database.swap.quarantined'")
    .all() as { target: string | null; details: string | null; at: number }[];
  const out = new Map<string, { databaseId: string | null; at: number }>();
  for (const r of rows) {
    try {
      const name = (JSON.parse(r.details ?? "{}") as { quarantine?: unknown }).quarantine;
      if (typeof name === "string") out.set(name, { databaseId: r.target, at: r.at });
    } catch {
      continue;
    }
  }
  return out;
}

async function existingSchemas(): Promise<string[]> {
  return withRootConnection(async (c) => {
    const [rows] = await c.query<RowDataPacket[]>(
      "SELECT SCHEMA_NAME AS n FROM information_schema.SCHEMATA WHERE SCHEMA_NAME LIKE '\\_ld\\_quarantine\\_%' OR SCHEMA_NAME LIKE '\\_ld\\_trash\\_%'",
    );
    return rows.map((r) => String(r.n));
  });
}

function candidatesFor(row: Database, present: string[]): Candidate[] {
  const out: Candidate[] = [];
  const pending = journals();
  const busy = swapInProgress(row.id) || swapInProgress(row.name);
  const audited = quarantineAudit();
  const others = databases.list().filter((d) => d.id !== row.id);
  const ownSlug = slugFor(QUARANTINE_PREFIX, row.name);
  const slugShared = others.some((d) => slugFor(QUARANTINE_PREFIX, d.name) === ownSlug);
  const heldElsewhere = new Set<string>();
  for (const j of pending) {
    const mine = j.databaseId === row.id || (j.databaseId == null && j.live === row.name);
    if (typeof j.staging === "string") heldElsewhere.add(j.staging);
    if (typeof j.trash !== "string") continue;
    if (!mine || busy || j.phase !== "prepared") heldElsewhere.add(j.trash);
  }
  for (const name of present) {
    if (heldElsewhere.has(name) || name.startsWith(STAGING_PREFIX)) continue;
    const quarantine = QUARANTINE_NAME.exec(name);
    if (quarantine) {
      const record = audited.get(name);
      const owned = record ? record.databaseId === row.id : quarantine[1] === ownSlug && !slugShared;
      if (owned) out.push({ schema: name, kind: "quarantine", createdAt: record?.at ?? null });
      continue;
    }
    if (!TRASH_NAME.test(name) || busy) continue;
    const journal = pending.find(
      (j) => j.trash === name && j.phase === "prepared" && (j.databaseId === row.id || (j.databaseId == null && j.live === row.name)),
    );
    if (journal) out.push({ schema: name, kind: "kept", createdAt: typeof journal.createdAt === "number" ? journal.createdAt : null });
  }
  return out.sort((a, b) => (a.schema < b.schema ? -1 : a.schema > b.schema ? 1 : 0));
}

async function liveNames(live: string): Promise<Set<string>> {
  return withRootConnection(async (c) => {
    const [rows] = await c.query<RowDataPacket[]>("SELECT TABLE_NAME AS n FROM information_schema.TABLES WHERE TABLE_SCHEMA = ?", [live]);
    return new Set(rows.map((r) => String(r.n).toLowerCase()));
  });
}

async function tablesOf(schema: string, taken: Set<string>): Promise<SetAsideTable[]> {
  return withRootConnection(async (c) => {
    const [rows] = await c.query<RowDataPacket[]>(
      `SELECT TABLE_NAME AS n, DATA_LENGTH + INDEX_LENGTH AS bytes FROM information_schema.TABLES
        WHERE TABLE_SCHEMA = ? AND TABLE_TYPE IN (?) ORDER BY TABLE_NAME`,
      [schema, TABLE_TYPES],
    );
    const out: SetAsideTable[] = [];
    for (const r of rows) {
      const name = String(r.n);
      let rowCount: number | null = null;
      try {
        const [count] = await c.query<RowDataPacket[]>(
          `SET STATEMENT max_statement_time = ${COUNT_LIMIT_SEC} FOR SELECT COUNT(*) AS n FROM ${quoteIdent(schema)}.${quoteName(name)}`,
        );
        rowCount = Number(count[0]?.n ?? 0);
      } catch {
        rowCount = null;
      }
      out.push({
        name,
        rowCount,
        sizeBytes: r.bytes === null || r.bytes === undefined ? null : Number(r.bytes),
        nameFreeInDatabase: !taken.has(name.toLowerCase()),
      });
    }
    return out;
  });
}

export async function listSetAside(row: Database): Promise<SetAsideSchema[]> {
  const candidates = candidatesFor(row, await existingSchemas());
  if (candidates.length === 0) return [];
  const taken = await liveNames(row.name);
  const out: SetAsideSchema[] = [];
  for (const c of candidates) {
    const tables = await tablesOf(c.schema, taken);
    const sizes = tables.map((t) => t.sizeBytes);
    out.push({
      schema: c.schema,
      kind: c.kind,
      createdAt: c.createdAt,
      sizeBytes: sizes.some((s) => s === null) ? null : sizes.reduce<number>((n, s) => n + (s ?? 0), 0),
      tables,
    });
  }
  return out;
}

export async function findSetAside(row: Database, schema: string): Promise<SetAsideSchema> {
  if (!isSetAsideName(schema)) throw new SetAsideError(404, "There is no table set aside for this database under that name.");
  const found = (await listSetAside(row)).find((s) => s.schema === schema);
  if (!found) throw new SetAsideError(404, "There is no table set aside for this database under that name.");
  return found;
}

async function triggersOn(schema: string, table: string): Promise<string[]> {
  return withRootConnection(async (c) => {
    const [rows] = await c.query<RowDataPacket[]>(
      "SELECT TRIGGER_NAME AS n FROM information_schema.TRIGGERS WHERE EVENT_OBJECT_SCHEMA = ? AND EVENT_OBJECT_TABLE = ? ORDER BY 1",
      [schema, table],
    );
    return rows.map((r) => String(r.n));
  });
}

async function schemaEmpty(schema: string): Promise<boolean> {
  return withRootConnection(async (c) => {
    const [rows] = await c.query<RowDataPacket[]>(
      `SELECT (SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = ?)
            + (SELECT COUNT(*) FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA = ?)
            + (SELECT COUNT(*) FROM information_schema.EVENTS WHERE EVENT_SCHEMA = ?) AS n`,
      [schema, schema, schema],
    );
    return Number(rows[0]?.n ?? 0) === 0;
  });
}

export async function moveBackSetAside(row: Database, schema: string, table: string, as?: string): Promise<MoveBackSetAsideTableResponse & { kind: SetAsideKind }> {
  const found = await findSetAside(row, schema);
  const entry = found.tables.find((t) => t.name === table);
  if (!entry) throw new SetAsideError(404, `The schema ${schema} holds no table named ${table}.`);
  const target = as ?? table;
  const taken = await liveNames(row.name);
  if (taken.has(target.toLowerCase())) {
    throw new SetAsideError(
      409,
      `${row.name} already has a table or view named ${target}. Choose another name to move ${table} back under, or remove that object first.`,
    );
  }
  const triggers = await triggersOn(schema, table);
  if (triggers.length > 0) {
    throw new SetAsideError(
      409,
      `${table} has ${triggers.length} trigger(s) (${triggers.join(", ")}), and MariaDB cannot move a table with triggers into another database, so it was not moved. Its data is untouched in ${schema}.`,
    );
  }
  try {
    await withRootConnection(async (c) => {
      await c.query(`RENAME TABLE ${quoteIdent(schema)}.${quoteName(table)} TO ${quoteIdent(row.name)}.${quoteName(target)}`);
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new SetAsideError(409, `${table} could not be moved back into ${row.name}: ${message}. Nothing was changed.`);
  }
  let schemaRemoved = false;
  if (await schemaEmpty(schema)) {
    await withRootConnection(async (c) => {
      await c.query(`DROP DATABASE IF EXISTS ${quoteIdent(schema)}`);
    });
    schemaRemoved = true;
  }
  return { table, movedTo: target, schemaRemoved, kind: found.kind };
}

export async function deleteSetAside(row: Database, schema: string): Promise<SetAsideSchema> {
  const found = await findSetAside(row, schema);
  await withRootConnection(async (c) => {
    await c.query(`DROP DATABASE IF EXISTS ${quoteIdent(schema)}`);
  });
  return found;
}
