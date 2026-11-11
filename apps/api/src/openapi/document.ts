import { APPROVAL_HEADER, NOTE_HEADER, NOTE_MAX_LENGTH, type AccessTokenPreset } from "@lambdata/shared";
import { CAPABILITIES, allPresetInfo, type Capability, type CapabilityGroupId } from "../accessTokens/capabilities";
import { SCHEMAS, ref } from "./schemas";

type Schema = Record<string, unknown>;

const PRESET_LABEL: Record<AccessTokenPreset, string> = { read_only: "Read only", builder: "Builder", admin: "Admin" };

const GROUP_TAG: Record<CapabilityGroupId, string> = {
  basics: "Basics",
  databases_read: "Databases",
  databases_create: "Databases",
  databases_manage: "Databases",
  credentials: "Credentials",
  sql: "SQL",
  checkpoints_read: "Checkpoints",
  checkpoints_manage: "Checkpoints",
  sync_read: "Sync",
  sync_manage: "Sync",
  imports: "Imports",
  set_aside: "Set-aside tables",
  jobs: "Jobs",
  data_api_read: "Data API",
  data_api_manage: "Data API",
};

function asksFirst(c: Capability): boolean {
  return c.approval !== undefined;
}

const json = (schema: Schema) => ({ "application/json": { schema } });

const BODIES: Record<string, Schema> = {
  "POST /api/databases": ref("CreateDatabaseRequest"),
  "PATCH /api/databases/:id": ref("UpdateDatabaseRequest"),
  "POST /api/databases/:id/query": ref("QueryRequest"),
  "POST /api/databases/:id/checkpoints": ref("CreateCheckpointRequest"),
  "POST /api/databases/:id/checkpoints/:cid/restore": ref("RestoreCheckpointRequest"),
  "POST /api/databases/:id/sync/run": { type: "object", properties: { checkpoint: { type: "boolean" } } },
  "POST /mcp": ref("JsonRpcMessage"),
};

const SUCCESS: Record<string, [string, Schema]> = {
  "GET /api/access-tokens/current": ["200", ref("AccessTokenIdentity")],
  "GET /api/databases": ["200", ref("DatabaseList")],
  "POST /api/databases": ["200", ref("EnsureDatabaseResponse")],
  "GET /api/databases/:id": ["200", ref("DatabaseResponse")],
  "PATCH /api/databases/:id": ["200", ref("DatabaseResponse")],
  "GET /api/databases/:id/credentials": ["200", ref("CredentialsResponse")],
  "POST /api/databases/:id/rotate-password": ["200", ref("CredentialsResponse")],
  "POST /api/databases/:id/query": ["200", ref("QueryResult")],
  "GET /api/databases/:id/checkpoints": ["200", ref("CheckpointList")],
  "POST /api/databases/:id/checkpoints": ["202", ref("JobResponse")],
  "POST /api/databases/:id/checkpoints/:cid/restore": ["202", ref("JobResponse")],
  "POST /api/databases/:id/sync/run": ["202", ref("JobResponse")],
  "POST /api/databases/:id/imports": ["202", ref("JobResponse")],
  "GET /api/jobs": ["200", ref("JobList")],
  "GET /api/jobs/:jobId": ["200", ref("JobResponse")],
  "GET /api/databases/:id/undo": ["200", ref("UndoPointResponse")],
  "POST /api/databases/:id/undo": ["202", ref("JobResponse")],
  "GET /api/approvals/:id": ["200", ref("ApprovalResponse")],
};

const QUERY: Record<string, Schema[]> = {
  "GET /api/jobs": [
    { name: "databaseId", in: "query", schema: { type: "string" }, description: "Only jobs of this database." },
    { name: "active", in: "query", schema: { type: "boolean" }, description: "Only queued and running jobs." },
    { name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 200, default: 50 } },
  ],
  "GET /api/databases/:id/metrics": [
    { name: "range", in: "query", schema: { type: "string", enum: ["1d", "5d", "15d", "24h", "7d", "30d"] } },
    { name: "maxPoints", in: "query", schema: { type: "integer", minimum: 10, maximum: 5000 } },
  ],
  "GET /api/databases/:id/checkpoints/status": [
    { name: "refresh", in: "query", schema: { type: "boolean" }, description: "Compute the answer fresh." },
  ],
  "GET /api/databases/:id/checkpoints/:cid/diff": [
    { name: "against", in: "query", schema: { type: "string", default: "parent" }, description: "parent, working, or another checkpoint id." },
    { name: "refresh", in: "query", schema: { type: "boolean" } },
  ],
};

const NOTE_PARAM = {
  name: NOTE_HEADER,
  in: "header",
  required: false,
  schema: { type: "string", maxLength: NOTE_MAX_LENGTH },
  description: "Why the request is made. Shown in the token's activity log.",
};

const APPROVAL_PARAM = {
  name: APPROVAL_HEADER,
  in: "header",
  required: false,
  schema: { type: "string" },
  description: "On a retry after a person approved the request: the approval id. The method, path and body must match the first request.",
};

function openApiPath(path: string): string {
  return path.replace(/:([A-Za-z0-9_]+)/g, "{$1}");
}

function pathParams(path: string): Schema[] {
  return [...path.matchAll(/:([A-Za-z0-9_]+)/g)].map((m) => ({ name: m[1], in: "path", required: true, schema: { type: "string" } }));
}

function camel(action: string): string {
  return action
    .split(/[._-]/)
    .filter(Boolean)
    .map((part, i) => (i === 0 ? part : part[0]!.toUpperCase() + part.slice(1)))
    .join("");
}

function errorResponses(c: Capability): Record<string, Schema> {
  const err = { content: json(ref("Error")) };
  const forbidden = asksFirst(c)
    ? {
        description: `Refused, or a person must approve it first (code ${"approval_required"}). Retry the identical request with ${APPROVAL_HEADER} once it is approved.`,
        content: json({ oneOf: [ref("Error"), ref("ApprovalRequired")] }),
      }
    : { description: "Refused: paused, not allowed from this connection, or not available to this preset.", ...err };
  return {
    "400": { description: "The input was not valid.", ...err },
    "401": { description: "Missing, unknown, revoked or expired access token.", ...err },
    "403": forbidden,
    "404": { description: "Not found, or outside what this token may see.", ...err },
    "409": { description: "Conflicts with the current state.", ...err },
    "429": {
      description: "Over the token's request limit. Wait for Retry-After seconds.",
      headers: { "Retry-After": { schema: { type: "integer" } } },
      ...err,
    },
  };
}

function operation(c: Capability, operationId: string): Schema {
  const key = `${c.method} ${c.path}`;
  const presets = c.presets.map((p) => PRESET_LABEL[p]);
  const notes = [`Access token presets: ${presets.join(", ")}.`];
  if (c.credentials) notes.push("Only for tokens allowed to see database passwords.");
  if (c.creates) notes.push("Counts toward the token's database limit.");
  if (asksFirst(c)) {
    notes.push(
      c.approval === "sql"
        ? "A token that asks first needs a person's approval for statements that start with DROP or TRUNCATE."
        : "A token that asks first needs a person's approval for this.",
    );
  }
  if (c.transport) notes.push("The MCP endpoint. Each tool call is checked as the matching API request.");
  const params = [...pathParams(c.path), ...(QUERY[key] ?? []), NOTE_PARAM, ...(asksFirst(c) ? [APPROVAL_PARAM] : [])];
  const op: Schema = {
    operationId,
    summary: c.summary.replace("{db}", "a database"),
    description: notes.join(" "),
    tags: [GROUP_TAG[c.group]],
    parameters: params,
    "x-lambdata-presets": [...c.presets],
    "x-lambdata-action": c.action,
  };
  if (c.approval) op["x-lambdata-ask-first"] = c.approval;
  const body = BODIES[key];
  if (body) op.requestBody = { required: true, content: json(body) };
  else if (c.method === "POST" || c.method === "PUT" || c.method === "PATCH") {
    op.requestBody = { required: false, content: json({ type: "object" }) };
  }
  const success = SUCCESS[key];
  const ok: Record<string, Schema> = success
    ? { [success[0]]: { description: success[0] === "202" ? "Started a background job." : "Success.", content: json(success[1]) } }
    : { "200": { description: "Success." } };
  if (c.transport && c.method !== "POST") {
    op.responses = { "405": { description: "Only POST is supported.", content: json(ref("Error")) }, ...errorResponses(c) };
  } else {
    op.responses = { ...ok, ...errorResponses(c) };
  }
  return op;
}

export function buildOpenApiDocument(serverUrl: string): Schema {
  const paths: Record<string, Record<string, Schema>> = {};
  const used = new Set<string>();
  for (const c of CAPABILITIES) {
    let operationId = camel(c.action);
    if (used.has(operationId)) operationId = `${operationId}${c.method[0]}${c.method.slice(1).toLowerCase()}`;
    used.add(operationId);
    const p = openApiPath(c.path);
    paths[p] ??= {};
    paths[p][c.method.toLowerCase()] = operation(c, operationId);
  }
  const presets = allPresetInfo()
    .map((p) => `- **${p.label}**: ${p.summary}`)
    .join("\n");
  return {
    openapi: "3.1.0",
    info: {
      title: "LambData management API",
      version: "1",
      description: [
        "The part of the LambData management API that access tokens can reach. Every path listed here is exactly what the access token gate allows; anything else is refused.",
        "",
        "Presets:",
        presets,
        "",
        `Send the token as Authorization: Bearer ld_… . Add ${NOTE_HEADER} to say why. Errors have the shape { "error": "…" }; when a person must approve a request first, the 403 body also has code "approval_required" and the approval.`,
      ].join("\n"),
    },
    servers: [{ url: serverUrl }],
    security: [{ accessToken: [] }],
    tags: [...new Set(Object.values(GROUP_TAG))].map((name) => ({ name })),
    paths,
    components: {
      securitySchemes: {
        accessToken: { type: "http", scheme: "bearer", description: "An access token, which starts with ld_." },
      },
      schemas: SCHEMAS,
    },
  };
}
