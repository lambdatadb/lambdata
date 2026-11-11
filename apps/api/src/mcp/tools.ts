import type { Context } from "hono";
import { z } from "zod";
import type {
  AccessTokenIdentity,
  Approval,
  Checkpoint,
  CheckpointListResponse,
  Database,
  EnsureDatabaseResponse,
  Job,
  MetricSample,
  QueryResult,
  TableBreakdown,
  WorkingCopyStatus,
} from "@lambdata/shared";
import type { DatabaseConnectionInfo } from "@lambdata/shared";
import { matchCapability, type CapabilityMethod } from "../accessTokens/capabilities";
import type { StoredAccessToken } from "../db/queries";
import { callApi, type ApiCall, type ApiResult } from "./call";
import { compactApproval, handle, jobOf, jobStarted, compactJob, refusal } from "./outcome";
import { cap, errorResult, plainId, toolResult, type ToolResult } from "./results";

export const SQL_DEFAULT_ROWS = 100;
export const SQL_MAX_ROWS = 5000;
export const JOB_MAX_WAIT_SECONDS = 50;
const LIST_MAX = 200;
const TABLES_MAX = 500;
const CHANGES_MAX = 200;
const CELL_MAX_CHARS = 4000;
const ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const SAMPLE = "sample";

const id = (what: string) => z.string().regex(ID_PATTERN, `${what} must be an id such as the ones the list tools return`);

const note = z
  .string()
  .max(1000)
  .optional()
  .describe(
    "Why you are doing this, in one short sentence. The owner sees it in this token's activity log. At most 200 characters are kept.",
  );

const databaseId = id("database_id").describe("The id of the database, as returned by list_databases or ensure_database.");

const approvalId = id("approval_id")
  .optional()
  .describe(
    "Only when retrying after a person approved this action: the approval id from the earlier result. Send exactly the same other arguments as the first time.",
  );

export interface ToolAnnotations {
  title: string;
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint: boolean;
  openWorldHint: boolean;
}

export interface ToolDefinition {
  name: string;
  title: string;
  description: string;
  input: z.ZodObject;
  needs: readonly (readonly [CapabilityMethod, string])[];
  annotations: ToolAnnotations;
  run(c: Context, args: Record<string, unknown>): Promise<ToolResult>;
}

interface ToolSpec<S extends z.ZodObject> {
  name: string;
  title: string;
  description: string;
  input: S;
  needs: readonly (readonly [CapabilityMethod, string])[];
  readOnly?: boolean;
  destructive?: boolean;
  idempotent?: boolean;
  run(c: Context, args: z.infer<S>): Promise<ToolResult>;
}

function tool<S extends z.ZodObject>(spec: ToolSpec<S>): ToolDefinition {
  return {
    name: spec.name,
    title: spec.title,
    description: spec.description,
    input: spec.input,
    needs: spec.needs,
    annotations: {
      title: spec.title,
      readOnlyHint: spec.readOnly === true,
      destructiveHint: spec.destructive === true,
      idempotentHint: spec.idempotent === true || spec.readOnly === true,
      openWorldHint: false,
    },
    run: (c, args) => spec.run(c, args as z.infer<S>),
  };
}

function dbPath(dbId: string, rest = ""): string {
  return `/api/databases/${encodeURIComponent(dbId)}${rest}`;
}

function call(c: Context, req: ApiCall, args: { note?: string; approval_id?: string }): Promise<ApiResult> {
  return callApi(c, { ...req, note: args.note ?? null, approvalId: args.approval_id ?? null });
}

function compactDatabase(d: Database, tokenId: string | null) {
  return {
    id: d.id,
    displayName: d.displayName,
    schema: d.name,
    kind: d.kind,
    status: d.status,
    versioned: d.versioned,
    head: d.baseShortHash,
    createdAt: d.createdAt,
    owner: d.ownerDisplayName ?? null,
    createdByThisToken: tokenId !== null && d.createdByTokenId === tokenId,
  };
}

function compactCheckpoint(cp: Checkpoint) {
  return {
    id: cp.id,
    shortHash: cp.shortHash,
    message: cp.message,
    trigger: cp.trigger,
    createdAt: cp.createdAt,
    createdBy: cp.createdByDisplayName,
    tables: cp.tableCount,
    rows: cp.rowCount,
    logicalBytes: cp.logicalBytes,
    pinned: cp.pinned,
    isHead: cp.isBase,
    parentId: cp.parentId,
  };
}

function tokenIdOf(c: Context): string | null {
  return c.get("accessToken")?.token.id ?? null;
}

function cutCells(rows: unknown[][]): { rows: unknown[][]; cut: number } {
  let cut = 0;
  const out = rows.map((row) =>
    row.map((cell) => {
      if (typeof cell !== "string" || cell.length <= CELL_MAX_CHARS) return cell;
      cut++;
      return `${cell.slice(0, CELL_MAX_CHARS)}… [${cell.length - CELL_MAX_CHARS} more characters not shown]`;
    }),
  );
  return { rows: out, cut };
}

function isResultSet(result: QueryResult): boolean {
  return !(result.columns.length === 1 && result.columns[0] === "affectedRows" && result.rows.length === 1);
}

function sqlString(value: string): string {
  return `'${value.replace(/\\/g, "\\\\").replace(/'/g, "''")}'`;
}

function describeSql(table: string): string {
  const t = sqlString(table);
  return [
    "SELECT 'column' AS part, COLUMN_NAME AS name, COLUMN_TYPE AS detail, IS_NULLABLE AS nullable, COLUMN_DEFAULT AS dflt, COLUMN_KEY AS keyinfo, EXTRA AS extra, ORDINAL_POSITION AS pos",
    `FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ${t}`,
    "UNION ALL",
    "SELECT 'index', INDEX_NAME, COLUMN_NAME, NULLABLE, NULL, IF(NON_UNIQUE = 0, 'unique', ''), INDEX_TYPE, SEQ_IN_INDEX",
    `FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ${t}`,
    "UNION ALL",
    "SELECT 'foreign_key', CONSTRAINT_NAME, COLUMN_NAME, NULL, REFERENCED_TABLE_NAME, REFERENCED_COLUMN_NAME, NULL, ORDINAL_POSITION",
    `FROM information_schema.KEY_COLUMN_USAGE WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ${t} AND REFERENCED_TABLE_NAME IS NOT NULL`,
  ].join(" ");
}

type Row = { part: string; name: string; detail: unknown; nullable: unknown; dflt: unknown; keyinfo: unknown; extra: unknown; pos: number };

function shapeDescription(result: QueryResult) {
  const index = (name: string) => result.columns.indexOf(name);
  const rows: Row[] = result.rows.map((r) => ({
    part: String(r[index("part")]),
    name: String(r[index("name")]),
    detail: r[index("detail")],
    nullable: r[index("nullable")],
    dflt: r[index("dflt")],
    keyinfo: r[index("keyinfo")],
    extra: r[index("extra")],
    pos: Number(r[index("pos")]),
  }));
  const byPos = (a: Row, b: Row) => a.pos - b.pos;
  const columns = rows
    .filter((r) => r.part === "column")
    .sort(byPos)
    .map((r) => ({
      name: r.name,
      type: r.detail,
      nullable: r.nullable === "YES",
      default: r.dflt,
      key: r.keyinfo || null,
      extra: r.extra || null,
    }));
  const indexes = new Map<string, { name: string; unique: boolean; type: unknown; columns: string[] }>();
  for (const r of rows.filter((x) => x.part === "index").sort(byPos)) {
    const entry = indexes.get(r.name) ?? { name: r.name, unique: r.keyinfo === "unique", type: r.extra, columns: [] };
    entry.columns.push(String(r.detail));
    indexes.set(r.name, entry);
  }
  const foreignKeys = new Map<string, { name: string; columns: string[]; referencedTable: unknown; referencedColumns: unknown[] }>();
  for (const r of rows.filter((x) => x.part === "foreign_key").sort(byPos)) {
    const entry = foreignKeys.get(r.name) ?? { name: r.name, columns: [], referencedTable: r.dflt, referencedColumns: [] };
    entry.columns.push(String(r.detail));
    entry.referencedColumns.push(r.keyinfo);
    foreignKeys.set(r.name, entry);
  }
  return { columns, indexes: [...indexes.values()], foreignKeys: [...foreignKeys.values()] };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function finished(job: Job): boolean {
  return job.status !== "queued" && job.status !== "running";
}

function jobGuidance(job: Job, waited: boolean): string[] {
  const jid = plainId(job.id);
  switch (job.status) {
    case "succeeded":
      return ["The job finished successfully. Its result is in the data below."];
    case "failed":
      return ["The job failed. The error is in the data below."];
    default:
      return [
        waited ? "The job is still running after the wait." : "The job is still running.",
        `Call get_job again${jid ? ` with job_id "${jid}"` : ""} and wait_seconds (up to ${JOB_MAX_WAIT_SECONDS}) to keep waiting.`,
      ];
  }
}

function approvalGuidance(a: Approval): string[] {
  switch (a.status) {
    case "pending":
      return ["A person has not decided yet. Wait, then call get_approval again. Do not retry the action until it is approved."];
    case "approved":
      return [
        "It was approved. Call the same tool again with exactly the same arguments as the first time, plus approval_id set to this approval's id. It works once.",
        a.approvedUntil ? `Use it before ${new Date(a.approvedUntil).toISOString()}.` : "Use it within 60 minutes of the decision.",
      ];
    case "denied":
      return ["A person declined this action. Do not try it again; tell the user it was declined."];
    case "used":
      return ["This approval was already used. A further request needs a new approval."];
    case "expired":
      return ["This approval expired before it was used. Make the request again to ask for a new approval."];
    case "cancelled":
      return ["This approval was cancelled."];
  }
}

export function connectionGuidance(conn: DatabaseConnectionInfo | null): string[] {
  if (!conn) return [];
  const port = Number.isInteger(conn.port) ? conn.port : null;
  if (!conn.outsideConnections) {
    return [
      "Database clients on other machines cannot connect to this database yet: outside connections are off. An admin can allow them on the Network page of the LambData console. Until then only programs on the LambData server itself can connect.",
    ];
  }
  if (conn.host === null) {
    return [`Outside connections are on. Connect to this LambData server's own address${port ? ` on port ${port}` : ""}.`];
  }
  return [];
}

const whoami = tool({
  name: "whoami",
  title: "Who am I",
  description:
    "Describes the access token you are using: its name, preset (Read only, Builder or Admin), limits, whether it asks first before destructive actions, whether it may see passwords, which databases it is limited to, and whether all tokens are paused. Call this first to learn what you may do. Returns the token and two lists, what it can and cannot do.",
  input: z.object({ note }),
  needs: [["GET", "/api/access-tokens/current"]],
  readOnly: true,
  async run(c, args) {
    const res = await call(c, { method: "GET", path: "/api/access-tokens/current" }, args);
    return handle(c, "whoami", res, (body) => {
      const identity = body as AccessTokenIdentity;
      const t = identity.token;
      const lines = [`You are using an access token with the ${t.preset.replace("_", " ")} preset.`];
      if (identity.allPaused) lines.push("All access tokens are paused right now, so every other call will be refused until an admin resumes them.");
      else if (t.paused) lines.push("This access token is paused, so every other call will be refused until an admin resumes it.");
      return toolResult(lines, {
        token: {
          id: t.id,
          name: t.name,
          preset: t.preset,
          status: t.status,
          paused: t.paused,
          expiresAt: t.expiresAt,
          databaseIds: t.databaseIds,
          allowedFrom: t.allowedFrom,
          revealCredentials: t.revealCredentials,
          askFirst: t.askFirst,
          limits: t.limits,
          databasesCreated: t.databasesCreated,
          pendingApprovals: t.pendingApprovals,
        },
        can: identity.can,
        cannot: identity.cannot,
        allPaused: identity.allPaused,
      });
    });
  },
});

const listDatabases = tool({
  name: "list_databases",
  title: "List databases",
  description:
    "Lists the databases this access token may see, with id, display name, schema name, kind (standard or mirror), status and whether it is versioned. A Builder token sees only the databases it created. Use the id with the other tools. For size and row figures of one database, call get_database.",
  input: z.object({ note }),
  needs: [["GET", "/api/databases"]],
  readOnly: true,
  async run(c, args) {
    const res = await call(c, { method: "GET", path: "/api/databases" }, args);
    return handle(c, "list_databases", res, (body) => {
      const list = ((body as { databases?: Database[] }).databases ?? []).map((d) => compactDatabase(d, tokenIdOf(c)));
      const capped = cap(list, LIST_MAX);
      const lines = [`${list.length} database${list.length === 1 ? "" : "s"} visible to this access token.`];
      if (capped.omitted > 0) lines.push(`Only the first ${LIST_MAX} are listed; ${capped.omitted} more were left out.`);
      return toolResult(lines, { databases: capped.items, omitted: capped.omitted });
    });
  },
});

const getDatabase = tool({
  name: "get_database",
  title: "Get a database",
  description:
    "Returns one database: its details, the address and port database clients connect to, whether clients on other machines can connect at all, the MariaDB user and the host pattern it accepts connections from, and the latest size, table and row figures when known. Never returns a password; for the password and connection strings call get_connection_details.",
  input: z.object({ database_id: databaseId, note }),
  needs: [["GET", `/api/databases/${SAMPLE}`]],
  readOnly: true,
  async run(c, args) {
    const res = await call(c, { method: "GET", path: dbPath(args.database_id) }, args);
    if (res.status >= 400) return refusal(res);
    const body = res.body as { database: Database; connection?: DatabaseConnectionInfo | null };
    const d = body.database;
    const conn = body.connection ?? null;
    const m = await call(c, { method: "GET", path: dbPath(args.database_id, "/metrics"), query: { range: "1d", maxPoints: "24" } }, args);
    const samples = m.status < 400 ? ((m.body as { samples?: MetricSample[] }).samples ?? []) : [];
    const latest = samples.length > 0 ? samples[samples.length - 1]! : null;
    return toolResult(
      [...connectionGuidance(conn), "For the user, password and connection strings, call get_connection_details (only tokens allowed to see passwords can)."],
      {
        database: compactDatabase(d, tokenIdOf(c)),
        connection: {
          host: conn?.host ?? null,
          port: conn?.port ?? null,
          outsideConnections: conn?.outsideConnections ?? null,
          user: d.mysqlUser,
          connectionsFrom: d.connectionsFrom,
          lanExposed: d.lanExposed,
          tailnetExposed: d.tailscaleExposed,
        },
        size: latest
          ? { collectedAt: latest.collectedAt, bytes: latest.sizeBytes, tables: latest.tableCount, rows: latest.rowCount, connections: latest.connectionCount }
          : null,
      },
    );
  },
});

const ensureDatabase = tool({
  name: "ensure_database",
  title: "Create or find a database",
  description:
    "Creates a database with this display name, or returns the database this token created earlier with that name (compared trimmed and case-insensitively). If someone else created a database with that name and this token can see it, the answer is an error naming who created it and its id: it is not returned, so choose another name or ask the owner whether that database is the one to use. Safe to call again with the same name. Says whether it was created. When a database is created and this token may see passwords, the result includes its connection details once; otherwise call get_connection_details later.",
  input: z.object({
    name: z.string().trim().min(1).max(200).describe("Display name of the database, for example \"Inventory\"."),
    kind: z
      .enum(["standard", "mirror"])
      .optional()
      .describe("standard (the default) for a database you write to; mirror for a copy kept in sync from another server."),
    versioned: z
      .boolean()
      .optional()
      .describe("Mark the database versioned. Changes made through run_sql then get an automatic undo point."),
    note,
  }),
  needs: [["POST", "/api/databases"]],
  async run(c, args) {
    const body: Record<string, unknown> = { displayName: args.name, ensure: true };
    if (args.kind) body.kind = args.kind;
    if (args.versioned !== undefined) body.versioned = args.versioned;
    const res = await call(c, { method: "POST", path: "/api/databases", body }, args);
    return handle(c, "ensure_database", res, (raw) => {
      const r = raw as EnsureDatabaseResponse;
      const lines = r.created
        ? ["Created a new database."]
        : ["A database with this name already existed and this token can manage it, so it was returned unchanged. Nothing was created."];
      if (r.credentials) lines.push("The connection details are included once. Treat the password as a secret: do not write it to logs or commit it.");
      else lines.push("Connection details are not included; call get_connection_details if you need them.");
      return toolResult(lines, { created: r.created, database: compactDatabase(r.database, tokenIdOf(c)), credentials: r.credentials ?? null });
    });
  },
});

const deleteDatabase = tool({
  name: "delete_database",
  title: "Delete a database",
  description:
    "Deletes a database and all of its data. This cannot be undone. A token that asks first returns an approval to wait for instead; call this tool again with approval_id once a person approved it.",
  input: z.object({ database_id: databaseId, approval_id: approvalId, note }),
  needs: [["DELETE", `/api/databases/${SAMPLE}`]],
  destructive: true,
  async run(c, args) {
    const res = await call(c, { method: "DELETE", path: dbPath(args.database_id) }, args);
    return handle(c, "delete_database", res, () => toolResult(["The database was deleted."]));
  },
});

const getConnectionDetails = tool({
  name: "get_connection_details",
  title: "Get connection details",
  description:
    "Returns the host, port, schema, user, password and ready-made connection strings (mysql command line, JDBC, URI) of a database. Refused unless this access token may see passwords. Treat the password as a secret.",
  input: z.object({ database_id: databaseId, note }),
  needs: [["GET", `/api/databases/${SAMPLE}/credentials`]],
  readOnly: true,
  async run(c, args) {
    const res = await call(c, { method: "GET", path: dbPath(args.database_id, "/credentials") }, args);
    return handle(c, "get_connection_details", res, (body) =>
      toolResult(["Treat the password as a secret: do not write it to logs, files that get committed, or replies to other people."], body),
    );
  },
});

const listTables = tool({
  name: "list_tables",
  title: "List tables",
  description: "Lists the tables of a database with their row counts (estimates for large InnoDB tables) and sizes in bytes.",
  input: z.object({ database_id: databaseId, note }),
  needs: [["GET", `/api/databases/${SAMPLE}/tables`]],
  readOnly: true,
  async run(c, args) {
    const res = await call(c, { method: "GET", path: dbPath(args.database_id, "/tables") }, args);
    return handle(c, "list_tables", res, (body) => {
      const b = body as TableBreakdown;
      const capped = cap(b.tables ?? [], TABLES_MAX);
      const lines = [`${b.tables?.length ?? 0} table${b.tables?.length === 1 ? "" : "s"}.`];
      if (capped.omitted > 0) lines.push(`Only the first ${TABLES_MAX} are listed; ${capped.omitted} more were left out.`);
      return toolResult(lines, { collectedAt: b.collectedAt, tables: capped.items, omitted: capped.omitted });
    });
  },
});

const describeTable = tool({
  name: "describe_table",
  title: "Describe a table",
  description:
    "Returns the columns (name, type, nullable, default, key, extra), indexes and foreign keys of one table. Reads only; works with every preset that may run SQL.",
  input: z.object({
    database_id: databaseId,
    table: z
      .string()
      .min(1)
      .max(64)
      .refine((s) => !s.includes("\u0000"), "table must not contain a NUL character")
      .describe("The table name exactly as list_tables returns it."),
    note,
  }),
  needs: [["POST", `/api/databases/${SAMPLE}/query`]],
  readOnly: true,
  async run(c, args) {
    const res = await call(
      c,
      { method: "POST", path: dbPath(args.database_id, "/query"), body: { sql: describeSql(args.table), maxRows: SQL_MAX_ROWS } },
      args,
    );
    return handle(c, "describe_table", res, (body) => {
      const shaped = shapeDescription(body as QueryResult);
      if (shaped.columns.length === 0) {
        return errorResult(["There is no table with that name in this database. Check the name with list_tables."]);
      }
      return toolResult([], shaped);
    });
  },
});

const runSql = tool({
  name: "run_sql",
  title: "Run SQL",
  description:
    "Runs one SQL statement on a database and returns the columns and rows, or the number of affected rows. Read only tokens can only read; MariaDB itself refuses changes. Returns at most max_rows rows and says when the result was cut. On a versioned database the first change saves an undo point, which the result reports; undo_changes rolls back to it. On a database that is not versioned, changes cannot be undone. Statements starting with DROP or TRUNCATE may need a person's approval first; then call again with approval_id.",
  input: z.object({
    database_id: databaseId,
    sql: z.string().min(1).max(1_000_000).describe("One SQL statement. Multiple statements separated by semicolons are not supported."),
    max_rows: z
      .number()
      .int()
      .min(1)
      .max(SQL_MAX_ROWS)
      .default(SQL_DEFAULT_ROWS)
      .describe(`Most rows to return, ${SQL_DEFAULT_ROWS} by default and at most ${SQL_MAX_ROWS}. Prefer a LIMIT in the SQL.`),
    approval_id: approvalId,
    note,
  }),
  needs: [["POST", `/api/databases/${SAMPLE}/query`]],
  destructive: true,
  async run(c, args) {
    const maxRows = args.max_rows ?? SQL_DEFAULT_ROWS;
    const res = await call(c, { method: "POST", path: dbPath(args.database_id, "/query"), body: { sql: args.sql, maxRows } }, args);
    if (res.status === 400) {
      return errorResult(["The statement failed. The error from MariaDB is in the data below."], {
        error: (res.body as { error?: string } | null)?.error ?? "no message",
      });
    }
    return handle(c, "run_sql", res, (body) => {
      const r = body as QueryResult;
      const rows = r.rows ?? [];
      const kept = rows.slice(0, maxRows);
      const truncated = r.truncated === true || rows.length > maxRows;
      const { rows: shown, cut } = cutCells(kept);
      const lines: string[] = [];
      const resultSet = isResultSet(r);
      if (resultSet) lines.push(`${kept.length} row${kept.length === 1 ? "" : "s"} returned.`);
      else lines.push("The statement ran.");
      if (truncated) lines.push(`The result was cut to the first ${maxRows} rows. Add a LIMIT or a WHERE clause, or raise max_rows (at most ${SQL_MAX_ROWS}).`);
      if (cut > 0) lines.push(`${cut} long value${cut === 1 ? " was" : "s were"} shortened to ${CELL_MAX_CHARS} characters.`);
      const undo = r.undo ?? null;
      const shortHash = undo ? plainId(undo.shortHash) : null;
      if (undo) {
        lines.push(
          undo.createdNow
            ? `An undo point${shortHash ? ` (checkpoint ${shortHash})` : ""} was saved just before this change. undo_changes rolls the database back to it.`
            : `Changes are covered by the undo point${shortHash ? ` ${shortHash}` : ""} saved before this token's first change here. undo_changes rolls back to it.`,
        );
      } else if (r.versioned === false && !resultSet) {
        lines.push("This database is not versioned, so if this statement changed data, the change cannot be undone.");
      }
      return toolResult(lines, {
        columns: r.columns,
        rows: shown,
        rowCount: kept.length,
        truncated,
        maxRows,
        durationMs: Math.round(r.durationMs ?? 0),
        versioned: r.versioned ?? null,
        undo,
      });
    });
  },
});

const listCheckpoints = tool({
  name: "list_checkpoints",
  title: "List checkpoints",
  description:
    "Lists the checkpoints of a database, newest first: id, short hash, message, what made it, when, and table and row counts. The current one has isHead true. Use an id with rollback_to_checkpoint.",
  input: z.object({
    database_id: databaseId,
    limit: z.number().int().min(1).max(100).default(20).describe("Most checkpoints to return, 20 by default and at most 100."),
    note,
  }),
  needs: [["GET", `/api/databases/${SAMPLE}/checkpoints`]],
  readOnly: true,
  async run(c, args) {
    const res = await call(c, { method: "GET", path: dbPath(args.database_id, "/checkpoints") }, args);
    return handle(c, "list_checkpoints", res, (body) => {
      const b = body as CheckpointListResponse;
      const capped = cap((b.checkpoints ?? []).map(compactCheckpoint), args.limit ?? 20);
      const lines = [`${b.checkpoints?.length ?? 0} checkpoint${b.checkpoints?.length === 1 ? "" : "s"}.`];
      if (capped.omitted > 0) lines.push(`${capped.omitted} older ones were left out; raise limit to see more.`);
      return toolResult(lines, { versioned: b.policy?.versioned ?? null, checkpoints: capped.items, omitted: capped.omitted });
    });
  },
});

const createCheckpoint = tool({
  name: "create_checkpoint",
  title: "Create a checkpoint",
  description:
    "Saves a checkpoint of a database with a message, like a commit. It never interrupts the database. Runs as a background job: call get_job with wait_seconds to wait for it. If nothing changed since the last checkpoint, nothing new is saved and the job says so.",
  input: z.object({
    database_id: databaseId,
    message: z.string().max(2000).optional().describe("What this checkpoint holds, like a commit message."),
    note,
  }),
  needs: [["POST", `/api/databases/${SAMPLE}/checkpoints`]],
  async run(c, args) {
    const body: Record<string, unknown> = {};
    if (args.message !== undefined) body.message = args.message;
    const res = await call(c, { method: "POST", path: dbPath(args.database_id, "/checkpoints"), body }, args);
    return handle(c, "create_checkpoint", res, (raw) => {
      const job = jobOf(raw);
      return job ? jobStarted(job, "Saving a checkpoint.") : toolResult(["The checkpoint was requested."], raw);
    });
  },
});

const getChanges = tool({
  name: "get_changes",
  title: "Get changes",
  description:
    "Says what differs between the database now and its last checkpoint: which tables were added, removed or changed, row counts before and after, and whether views, routines or triggers changed. state is clean, dirty, unknown or no-checkpoint.",
  input: z.object({
    database_id: databaseId,
    refresh: z.boolean().default(true).describe("Compute it fresh (the default). false returns the last computed answer, which is faster."),
    note,
  }),
  needs: [["GET", `/api/databases/${SAMPLE}/checkpoints/status`]],
  readOnly: true,
  async run(c, args) {
    const res = await call(
      c,
      { method: "GET", path: dbPath(args.database_id, "/checkpoints/status"), query: { refresh: args.refresh === false ? "false" : "true" } },
      args,
    );
    return handle(c, "get_changes", res, (body) => {
      const s = (body as { status: WorkingCopyStatus }).status;
      const diff = s.diff;
      const tables = diff ? cap(diff.tables, CHANGES_MAX) : null;
      const lines =
        s.state === "clean"
          ? ["Nothing changed since the last checkpoint."]
          : s.state === "dirty"
            ? ["The database changed since its last checkpoint."]
            : s.state === "no-checkpoint"
              ? ["The database has no checkpoint yet."]
              : ["It is not known right now whether the database changed."];
      if (tables && tables.omitted > 0) lines.push(`Only ${CHANGES_MAX} changed tables are listed; ${tables.omitted} more were left out.`);
      return toolResult(lines, {
        state: s.state,
        reason: s.reason,
        lastCheckpointId: s.baseCheckpointId,
        computedAt: s.computedAt,
        changes: diff
          ? { tables: tables!.items, omittedTables: tables!.omitted, codeChanged: diff.codeChanged, unchangedTables: diff.unchangedTables, rowDelta: diff.rowDelta }
          : null,
      });
    });
  },
});

const rollbackToCheckpoint = tool({
  name: "rollback_to_checkpoint",
  title: "Roll back to a checkpoint",
  description:
    "Rolls a database back to one of its checkpoints. A safety checkpoint of the current state is saved first. Runs as a background job: call get_job with wait_seconds to wait for it. A token that asks first returns an approval to wait for instead; call again with approval_id once a person approved it.",
  input: z.object({
    database_id: databaseId,
    checkpoint_id: id("checkpoint_id").describe("The id of the checkpoint, from list_checkpoints."),
    approval_id: approvalId,
    note,
  }),
  needs: [["POST", `/api/databases/${SAMPLE}/checkpoints/${SAMPLE}/restore`]],
  destructive: true,
  async run(c, args) {
    const res = await call(
      c,
      { method: "POST", path: dbPath(args.database_id, `/checkpoints/${encodeURIComponent(args.checkpoint_id)}/restore`), body: {} },
      args,
    );
    return handle(c, "rollback_to_checkpoint", res, (raw) => {
      const job = jobOf(raw);
      return job ? jobStarted(job, "Rolling back to the checkpoint.") : toolResult(["The rollback was requested."], raw);
    });
  },
});

const undoChanges = tool({
  name: "undo_changes",
  title: "Undo my changes",
  description:
    "Rolls a versioned database back to this token's undo point, the checkpoint saved automatically before this token's first change there. Undoes every change made since then, by anyone. Runs as a background job: call get_job with wait_seconds. A token that asks first returns an approval to wait for instead; call again with approval_id once a person approved it.",
  input: z.object({ database_id: databaseId, approval_id: approvalId, note }),
  needs: [["POST", `/api/databases/${SAMPLE}/undo`]],
  destructive: true,
  async run(c, args) {
    const res = await call(c, { method: "POST", path: dbPath(args.database_id, "/undo"), body: {} }, args);
    return handle(c, "undo_changes", res, (raw) => {
      const job = jobOf(raw);
      return job ? jobStarted(job, "Rolling back to this token's undo point.") : toolResult(["The undo was requested."], raw);
    });
  },
});

const runSync = tool({
  name: "run_sync",
  title: "Run a sync",
  description:
    "Starts a sync of a mirror database from its source now. Only works on a mirror that has a sync set up. Runs as a background job: call get_job with wait_seconds; the finished job reports rows added, removed and changed per table when known.",
  input: z.object({
    database_id: databaseId,
    checkpoint: z.boolean().optional().describe("Save a checkpoint after the sync (true) or not (false). Leave it out to follow the database's setting."),
    note,
  }),
  needs: [["POST", `/api/databases/${SAMPLE}/sync/run`]],
  async run(c, args) {
    const body: Record<string, unknown> = {};
    if (args.checkpoint !== undefined) body.checkpoint = args.checkpoint;
    const res = await call(c, { method: "POST", path: dbPath(args.database_id, "/sync/run"), body }, args);
    return handle(c, "run_sync", res, (raw) => {
      const job = jobOf(raw);
      return job ? jobStarted(job, "Started a sync.") : toolResult(["The sync was requested."], raw);
    });
  },
});

const getJob = tool({
  name: "get_job",
  title: "Get a job",
  description: `Returns the state of a background job (queued, running, succeeded or failed) with its progress, error and result. With wait_seconds (at most ${JOB_MAX_WAIT_SECONDS}) it waits until the job finishes or the time runs out, so you do not need to poll quickly.`,
  input: z.object({
    job_id: id("job_id").describe("The job id from the tool that started it."),
    wait_seconds: z
      .number()
      .min(0)
      .max(JOB_MAX_WAIT_SECONDS)
      .default(0)
      .describe(`How long to wait for the job to finish, 0 (the default) to ${JOB_MAX_WAIT_SECONDS} seconds.`),
    note,
  }),
  needs: [["GET", `/api/jobs/${SAMPLE}`]],
  readOnly: true,
  async run(c, args) {
    const path = `/api/jobs/${encodeURIComponent(args.job_id)}`;
    const deadline = Date.now() + Math.min(JOB_MAX_WAIT_SECONDS, args.wait_seconds ?? 0) * 1000;
    const steps = [250, 500, 1000, 2000];
    let attempt = 0;
    for (;;) {
      const res = await call(c, { method: "GET", path }, args);
      if (res.status >= 400) return refusal(res);
      const job = jobOf(res.body);
      if (!job) return errorResult(["The server answered without a job."]);
      const left = deadline - Date.now();
      if (finished(job) || left <= 0) return toolResult(jobGuidance(job, (args.wait_seconds ?? 0) > 0), { job: compactJob(job) });
      await sleep(Math.min(left, steps[Math.min(attempt, steps.length - 1)]!));
      attempt++;
    }
  },
});

const getApproval = tool({
  name: "get_approval",
  title: "Get an approval",
  description:
    "Returns the state of an approval this token is waiting on: pending, approved, denied, expired, used or cancelled. Once it is approved, call the original tool again with the same arguments and approval_id.",
  input: z.object({
    approval_id: id("approval_id").describe("The approval id from the result that asked for approval."),
    note,
  }),
  needs: [["GET", `/api/approvals/${SAMPLE}`]],
  readOnly: true,
  async run(c, args) {
    const res = await call(c, { method: "GET", path: `/api/approvals/${encodeURIComponent(args.approval_id)}` }, args);
    return handle(c, "get_approval", res, (body) => {
      const a = (body as { approval: Approval }).approval;
      return toolResult(approvalGuidance(a), { approval: compactApproval(a) });
    });
  },
});

export const TOOLS: readonly ToolDefinition[] = [
  whoami,
  listDatabases,
  getDatabase,
  ensureDatabase,
  deleteDatabase,
  getConnectionDetails,
  listTables,
  describeTable,
  runSql,
  listCheckpoints,
  createCheckpoint,
  getChanges,
  rollbackToCheckpoint,
  undoChanges,
  runSync,
  getJob,
  getApproval,
];

const BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));

export function toolByName(name: string): ToolDefinition | null {
  return BY_NAME.get(name) ?? null;
}

export function toolAvailable(t: ToolDefinition, token: StoredAccessToken): boolean {
  return t.needs.every(([method, path]) => {
    const match = matchCapability(method, path);
    if (!match || !match.capability.presets.includes(token.preset)) return false;
    if (match.capability.credentials) return token.preset !== "read_only" && token.revealCredentials;
    return true;
  });
}

export function toolsFor(token: StoredAccessToken): ToolDefinition[] {
  return TOOLS.filter((t) => toolAvailable(t, token));
}

export function inputSchema(t: ToolDefinition): Record<string, unknown> {
  const schema = z.toJSONSchema(t.input, { io: "input" }) as Record<string, unknown>;
  delete schema.$schema;
  return schema;
}
