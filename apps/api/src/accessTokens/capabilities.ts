import type {
  AccessTokenPreset,
  AccessTokenPresetDefaults,
  AccessTokenPresetInfo,
  ApprovalAction,
  Role,
} from "@lambdata/shared";

export type CapabilityMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export type CapabilityScope =
  | { kind: "none" }
  | { kind: "database"; param: string }
  | { kind: "databaseName"; param: string }
  | { kind: "databaseQuery"; query: string }
  | { kind: "job"; param: string }
  | { kind: "upload"; param: string }
  | { kind: "approval"; param: string };

export type CapabilityApproval = Exclude<ApprovalAction, "sql.destructive"> | "sql";

export type CapabilityGroupId =
  | "basics"
  | "databases_read"
  | "databases_create"
  | "databases_manage"
  | "credentials"
  | "sql"
  | "checkpoints_read"
  | "checkpoints_manage"
  | "sync_read"
  | "sync_manage"
  | "imports"
  | "set_aside"
  | "jobs"
  | "data_api_read"
  | "data_api_manage";

export interface Capability {
  method: CapabilityMethod;
  path: string;
  presets: readonly AccessTokenPreset[];
  group: CapabilityGroupId;
  scope: CapabilityScope;
  action: string;
  summary: string;
  credentials?: true;
  creates?: true;
  transport?: true;
  approval?: CapabilityApproval;
}

export const PRESETS: readonly AccessTokenPreset[] = ["read_only", "builder", "admin"];

export const PRESET_ROLE: Readonly<Record<AccessTokenPreset, Role>> = {
  read_only: "viewer",
  builder: "db_owner",
  admin: "admin",
};

const ALL = PRESETS;
const MANAGE: readonly AccessTokenPreset[] = ["builder", "admin"];

const NONE: CapabilityScope = { kind: "none" };
const DB: CapabilityScope = { kind: "database", param: "id" };
const DB_NAME: CapabilityScope = { kind: "databaseName", param: "databaseName" };
const UPLOAD: CapabilityScope = { kind: "upload", param: "uploadId" };
const APPROVAL: CapabilityScope = { kind: "approval", param: "approvalId" };

function cap(
  method: CapabilityMethod,
  path: string,
  presets: readonly AccessTokenPreset[],
  group: CapabilityGroupId,
  scope: CapabilityScope,
  action: string,
  summary: string,
  extra: Pick<Capability, "credentials" | "creates" | "transport" | "approval"> = {},
): Capability {
  return { method, path, presets, group, scope, action, summary, ...extra };
}

export const CAPABILITIES: readonly Capability[] = [
  cap("GET", "/api/access-tokens/current", ALL, "basics", NONE, "token.current", "Looked up its own access token."),
  cap("GET", "/api/openapi.json", ALL, "basics", NONE, "openapi.read", "Read the API description."),
  cap("GET", "/api/approvals", ALL, "basics", NONE, "approval.list", "Listed its approvals."),
  cap("GET", "/api/approvals/:approvalId", ALL, "basics", APPROVAL, "approval.read", "Checked an approval."),
  cap("DELETE", "/api/approvals/:approvalId", ALL, "basics", APPROVAL, "approval.cancel", "Cancelled an approval."),
  cap("POST", "/mcp", ALL, "basics", NONE, "mcp", "Used the MCP endpoint.", { transport: true }),
  cap("GET", "/mcp", ALL, "basics", NONE, "mcp", "Used the MCP endpoint.", { transport: true }),
  cap("DELETE", "/mcp", ALL, "basics", NONE, "mcp", "Used the MCP endpoint.", { transport: true }),

  cap("GET", "/api/databases", ALL, "databases_read", NONE, "database.list", "Listed databases."),
  cap("POST", "/api/databases", MANAGE, "databases_create", NONE, "database.create", "Created database {db}.", { creates: true }),
  cap("GET", "/api/databases/:id", ALL, "databases_read", DB, "database.read", "Read the details of {db}."),
  cap("PATCH", "/api/databases/:id", MANAGE, "databases_manage", DB, "database.update", "Changed the settings of {db}."),
  cap("DELETE", "/api/databases/:id", MANAGE, "databases_manage", DB, "database.delete", "Deleted {db}.", { approval: "database.delete" }),
  cap("GET", "/api/databases/:id/credentials", MANAGE, "credentials", DB, "database.credentials", "Read the connection details of {db}.", { credentials: true }),
  cap("POST", "/api/databases/:id/rotate-password", MANAGE, "credentials", DB, "database.rotate_password", "Changed the password of {db}.", { credentials: true }),
  cap("GET", "/api/databases/:id/metrics", ALL, "databases_read", DB, "database.metrics", "Read the metrics of {db}."),
  cap("GET", "/api/databases/:id/tables", ALL, "databases_read", DB, "database.tables", "Listed the tables of {db}."),
  cap("POST", "/api/databases/:id/query", ALL, "sql", DB, "sql.run", "Ran SQL on {db}.", { approval: "sql" }),

  cap("GET", "/api/databases/:id/checkpoints", ALL, "checkpoints_read", DB, "checkpoint.list", "Listed the checkpoints of {db}."),
  cap("GET", "/api/databases/:id/checkpoints/status", ALL, "checkpoints_read", DB, "checkpoint.status", "Checked what changed in {db} since its last checkpoint."),
  cap("PUT", "/api/databases/:id/checkpoints/policy", MANAGE, "checkpoints_manage", DB, "checkpoint.policy", "Changed the checkpoint policy of {db}."),
  cap("POST", "/api/databases/:id/checkpoints", MANAGE, "checkpoints_manage", DB, "checkpoint.create", "Saved a checkpoint of {db}."),
  cap("GET", "/api/databases/:id/checkpoints/:cid", ALL, "checkpoints_read", DB, "checkpoint.read", "Read a checkpoint of {db}."),
  cap("GET", "/api/databases/:id/checkpoints/:cid/diff", ALL, "checkpoints_read", DB, "checkpoint.diff", "Compared a checkpoint of {db}."),
  cap("DELETE", "/api/databases/:id/checkpoints/:cid", MANAGE, "checkpoints_manage", DB, "checkpoint.delete", "Deleted a checkpoint of {db}.", { approval: "checkpoint.delete" }),
  cap("POST", "/api/databases/:id/checkpoints/:cid/restore", MANAGE, "checkpoints_manage", DB, "checkpoint.rollback", "Rolled {db} back to a checkpoint.", { approval: "checkpoint.rollback" }),
  cap("GET", "/api/databases/:id/undo", ALL, "checkpoints_read", DB, "undo.read", "Looked up its undo point on {db}."),
  cap("POST", "/api/databases/:id/undo", MANAGE, "checkpoints_manage", DB, "undo.rollback", "Rolled {db} back to its undo point.", { approval: "checkpoint.rollback" }),

  cap("GET", "/api/databases/:id/sync", ALL, "sync_read", DB, "sync.read", "Read the sync settings of {db}."),
  cap("PUT", "/api/databases/:id/sync", MANAGE, "sync_manage", DB, "sync.configure", "Set up the sync of {db}."),
  cap("DELETE", "/api/databases/:id/sync", MANAGE, "sync_manage", DB, "sync.remove", "Removed the sync of {db}."),
  cap("POST", "/api/databases/:id/sync/run", MANAGE, "sync_manage", DB, "sync.run", "Started a sync of {db}."),

  cap("GET", "/api/databases/:id/imports", MANAGE, "imports", DB, "import.list", "Listed the imports of {db}."),
  cap("POST", "/api/databases/:id/imports", MANAGE, "imports", DB, "import.replace", "Started an import that replaces the contents of {db}.", { approval: "import.replace" }),
  cap("GET", "/api/imports/limits", MANAGE, "imports", NONE, "import.limits", "Read the import limits."),
  cap("POST", "/api/imports/uploads", MANAGE, "imports", NONE, "import.upload", "Uploaded a file to import."),
  cap("GET", "/api/imports/uploads/:uploadId", MANAGE, "imports", UPLOAD, "import.upload_read", "Read an uploaded file."),
  cap("DELETE", "/api/imports/uploads/:uploadId", MANAGE, "imports", UPLOAD, "import.upload_delete", "Deleted an uploaded file."),
  cap("GET", "/api/imports/uploads/:uploadId/plan", MANAGE, "imports", UPLOAD, "import.plan", "Read the import plan of an uploaded file."),
  cap("POST", "/api/imports/uploads/:uploadId/create-database", MANAGE, "databases_create", UPLOAD, "import.create", "Created database {db} from an uploaded file.", { creates: true }),

  cap("GET", "/api/databases/:id/set-aside", MANAGE, "set_aside", DB, "set_aside.list", "Listed the set-aside tables of {db}."),
  cap("POST", "/api/databases/:id/set-aside/:schema/move-back", MANAGE, "set_aside", DB, "set_aside.move_back", "Moved a set-aside table back into {db}."),
  cap("DELETE", "/api/databases/:id/set-aside/:schema", MANAGE, "set_aside", DB, "set_aside.delete", "Deleted set-aside tables of {db}."),

  cap("GET", "/api/jobs", ALL, "jobs", { kind: "databaseQuery", query: "databaseId" }, "job.list", "Listed background jobs."),
  cap("GET", "/api/jobs/:jobId", ALL, "jobs", { kind: "job", param: "jobId" }, "job.read", "Checked a background job."),

  cap("GET", "/api/data-access/:databaseName", ALL, "data_api_read", DB_NAME, "data_api.access_read", "Read the Data API access of {db}."),
  cap("PUT", "/api/data-access/:databaseName", MANAGE, "data_api_manage", DB_NAME, "data_api.access_update", "Changed the Data API access of {db}."),
  cap("GET", "/api/data-policies/:databaseName", ALL, "data_api_read", DB_NAME, "data_api.policy_list", "Listed the Data API policies of {db}."),
  cap("GET", "/api/data-policies/:databaseName/:tableName", ALL, "data_api_read", DB_NAME, "data_api.policy_read", "Read a Data API policy of {db}."),
  cap("PATCH", "/api/data-policies/:databaseName/:tableName", MANAGE, "data_api_manage", DB_NAME, "data_api.policy_update", "Changed a Data API policy of {db}."),
  cap("DELETE", "/api/data-policies/:databaseName/:tableName", MANAGE, "data_api_manage", DB_NAME, "data_api.policy_reset", "Reset a Data API policy of {db}."),
  cap("GET", "/api/data-docs/:databaseName/schema", ALL, "data_api_read", DB_NAME, "data_api.docs_schema", "Read the Data API docs of {db}."),
  cap("GET", "/api/data-docs/:databaseName/openapi.json", ALL, "data_api_read", DB_NAME, "data_api.docs_openapi", "Read the Data API description of {db}."),
];

const TRIED: Readonly<Record<string, string>> = {
  "token.current": "Tried to look up its own access token.",
  "openapi.read": "Tried to read the API description.",
  "approval.list": "Tried to list its approvals.",
  "approval.read": "Tried to check an approval.",
  "approval.cancel": "Tried to cancel an approval.",
  "mcp": "Tried to use the MCP endpoint.",
  "database.list": "Tried to list databases.",
  "database.create": "Tried to create a database.",
  "database.read": "Tried to read the details of {db}.",
  "database.update": "Tried to change the settings of {db}.",
  "database.delete": "Tried to delete {db}.",
  "database.credentials": "Tried to read the connection details of {db}.",
  "database.rotate_password": "Tried to change the password of {db}.",
  "database.metrics": "Tried to read the metrics of {db}.",
  "database.tables": "Tried to list the tables of {db}.",
  "sql.run": "Tried to run SQL on {db}.",
  "checkpoint.list": "Tried to list the checkpoints of {db}.",
  "checkpoint.status": "Tried to check what changed in {db} since its last checkpoint.",
  "checkpoint.policy": "Tried to change the checkpoint policy of {db}.",
  "checkpoint.create": "Tried to save a checkpoint of {db}.",
  "checkpoint.read": "Tried to read a checkpoint of {db}.",
  "checkpoint.diff": "Tried to compare a checkpoint of {db}.",
  "checkpoint.delete": "Tried to delete a checkpoint of {db}.",
  "checkpoint.rollback": "Tried to roll {db} back to a checkpoint.",
  "undo.read": "Tried to look up its undo point on {db}.",
  "undo.rollback": "Tried to roll {db} back to its undo point.",
  "sync.read": "Tried to read the sync settings of {db}.",
  "sync.configure": "Tried to set up the sync of {db}.",
  "sync.remove": "Tried to remove the sync of {db}.",
  "sync.run": "Tried to start a sync of {db}.",
  "import.list": "Tried to list the imports of {db}.",
  "import.replace": "Tried to start an import that replaces the contents of {db}.",
  "import.limits": "Tried to read the import limits.",
  "import.upload": "Tried to upload a file to import.",
  "import.upload_read": "Tried to read an uploaded file.",
  "import.upload_delete": "Tried to delete an uploaded file.",
  "import.plan": "Tried to read the import plan of an uploaded file.",
  "import.create": "Tried to create a database from an uploaded file.",
  "set_aside.list": "Tried to list the set-aside tables of {db}.",
  "set_aside.move_back": "Tried to move a set-aside table back into {db}.",
  "set_aside.delete": "Tried to delete set-aside tables of {db}.",
  "job.list": "Tried to list background jobs.",
  "job.read": "Tried to check a background job.",
  "data_api.access_read": "Tried to read the Data API access of {db}.",
  "data_api.access_update": "Tried to change the Data API access of {db}.",
  "data_api.policy_list": "Tried to list the Data API policies of {db}.",
  "data_api.policy_read": "Tried to read a Data API policy of {db}.",
  "data_api.policy_update": "Tried to change a Data API policy of {db}.",
  "data_api.policy_reset": "Tried to reset a Data API policy of {db}.",
  "data_api.docs_schema": "Tried to read the Data API docs of {db}.",
  "data_api.docs_openapi": "Tried to read the Data API description of {db}.",
};

export const FOUND_EXISTING_SUMMARY = "Found the existing database {db}.";

export function triedSummary(capability: Capability): string {
  return TRIED[capability.action] ?? `Tried to use ${capability.method} ${capability.path}.`;
}

export function hasTriedSummary(capability: Capability): boolean {
  return Object.hasOwn(TRIED, capability.action);
}

type GroupText = string | Partial<Record<AccessTokenPreset, string>>;

const GROUP_TEXT: Readonly<Record<Exclude<CapabilityGroupId, "basics">, GroupText>> = {
  databases_read: {
    read_only: "See every database it is allowed to, with its tables and metrics",
    builder: "See the databases it created, with their tables and metrics",
    admin: "See every database it is allowed to, with its tables and metrics",
  },
  databases_create:
    "Create databases, up to its database limit; a create with ensure returns the database this token created earlier with that name",
  databases_manage: "Change and delete those databases",
  credentials: "See database passwords and connection strings, only when the token is allowed to",
  sql: {
    read_only: "Run read-only SQL; MariaDB itself refuses any change",
    builder: "Run SQL that reads and changes data",
    admin: "Run SQL that reads and changes data",
  },
  checkpoints_read: "See checkpoints, what changed since the last one, and the differences between them",
  checkpoints_manage: "Save checkpoints, roll back to them or to its own undo point, delete them and change the checkpoint policy",
  sync_read: "See how mirror databases sync",
  sync_manage: "Set up, run and remove syncs of mirror databases",
  imports: "Upload files and import them into new or existing databases",
  set_aside: "Move back or delete set-aside tables",
  jobs: "Follow the background jobs of those databases",
  data_api_read: "See Data API access, policies and docs",
  data_api_manage: "Open or close the Data API and change its policies",
};

const NEVER: readonly string[] = [
  "Manage users, sign in, or use console sessions",
  "Run first-run setup or change settings",
  "Reach system pages such as the data folder or the audit log",
  "Change network, Tailscale or Cloudflare settings",
  "Manage notifications, storage, functions, App Auth or realtime",
  "Download checkpoints",
  "Manage access tokens or decide approvals",
];

const PRESET_EXTRA_CANNOT: Readonly<Record<AccessTokenPreset, readonly string[]>> = {
  read_only: ["Change any data, database or setting", "See database passwords"],
  builder: ["See or change databases it did not create, or learn that they exist"],
  admin: [],
};

const LABEL: Readonly<Record<AccessTokenPreset, string>> = {
  read_only: "Read only",
  builder: "Builder",
  admin: "Admin",
};

const SUMMARY: Readonly<Record<AccessTokenPreset, string>> = {
  read_only: "Reads databases, checkpoints and jobs, and runs read-only SQL. It cannot change anything.",
  builder: "Creates its own databases and manages only those. Other databases stay invisible to it.",
  admin: "Manages every database, or only the ones you choose. Destructive actions ask first by default.",
};

export const PRESET_DEFAULTS: Readonly<Record<AccessTokenPreset, AccessTokenPresetDefaults>> = {
  read_only: {
    revealCredentials: false,
    askFirst: false,
    allowedFrom: ["loopback", "lan", "tailnet"],
    limits: { maxDatabases: null, requestsPerMinute: 120 },
  },
  builder: {
    revealCredentials: true,
    askFirst: false,
    allowedFrom: ["loopback", "lan", "tailnet"],
    limits: { maxDatabases: 10, requestsPerMinute: 120 },
  },
  admin: {
    revealCredentials: false,
    askFirst: true,
    allowedFrom: ["loopback", "lan", "tailnet"],
    limits: { maxDatabases: null, requestsPerMinute: 120 },
  },
};

export function canRevealCredentials(preset: AccessTokenPreset): boolean {
  return CAPABILITIES.some((c) => c.credentials === true && c.presets.includes(preset));
}

export function capabilitiesFor(preset: AccessTokenPreset): Capability[] {
  return CAPABILITIES.filter((c) => c.presets.includes(preset));
}

function groupText(group: Exclude<CapabilityGroupId, "basics">, preset: AccessTokenPreset): string {
  const text = GROUP_TEXT[group];
  if (typeof text === "string") return text;
  return text[preset] ?? Object.values(text)[0] ?? group;
}

const GROUP_ORDER = Object.keys(GROUP_TEXT) as Exclude<CapabilityGroupId, "basics">[];

export function presetCan(preset: AccessTokenPreset): string[] {
  const groups = new Set(capabilitiesFor(preset).map((c) => c.group));
  return GROUP_ORDER.filter((g) => groups.has(g)).map((g) => groupText(g, preset));
}

export function presetCannot(preset: AccessTokenPreset): string[] {
  const groups = new Set(capabilitiesFor(preset).map((c) => c.group));
  const missing = GROUP_ORDER.filter((g) => !groups.has(g) && g !== "credentials").map((g) => groupText(g, "admin"));
  return [...PRESET_EXTRA_CANNOT[preset], ...missing, ...NEVER];
}

export function presetInfo(preset: AccessTokenPreset): AccessTokenPresetInfo {
  const defaults = PRESET_DEFAULTS[preset];
  return {
    preset,
    label: LABEL[preset],
    summary: SUMMARY[preset],
    can: presetCan(preset),
    cannot: presetCannot(preset),
    canRevealCredentials: canRevealCredentials(preset),
    defaults: { ...defaults, allowedFrom: [...defaults.allowedFrom], limits: { ...defaults.limits } },
  };
}

export function allPresetInfo(): AccessTokenPresetInfo[] {
  return PRESETS.map(presetInfo);
}

export interface CapabilityMatch {
  capability: Capability;
  params: Record<string, string>;
}

function segments(path: string): string[] {
  return path.split("/").slice(1);
}

const COMPILED = CAPABILITIES.map((capability) => ({ capability, parts: segments(capability.path) }));

export function matchCapability(method: string, path: string): CapabilityMatch | null {
  const m = method === "HEAD" ? "GET" : method;
  const trimmed = path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path;
  const parts = segments(trimmed);
  for (const { capability, parts: pattern } of COMPILED) {
    if (capability.method !== m || pattern.length !== parts.length) continue;
    const params: Record<string, string> = {};
    let ok = true;
    for (let i = 0; i < pattern.length; i++) {
      const want = pattern[i]!;
      const got = parts[i]!;
      if (want.startsWith(":")) {
        if (got === "") {
          ok = false;
          break;
        }
        params[want.slice(1)] = got;
      } else if (want !== got) {
        ok = false;
        break;
      }
    }
    if (ok) return { capability, params };
  }
  return null;
}
