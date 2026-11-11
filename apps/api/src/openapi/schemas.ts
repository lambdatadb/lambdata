type Schema = Record<string, unknown>;

const ref = (name: string): Schema => ({ $ref: `#/components/schemas/${name}` });
const str = (description?: string): Schema => (description ? { type: "string", description } : { type: "string" });
const nullable = (type: string, description?: string): Schema => ({ type: [type, "null"], ...(description ? { description } : {}) });
const int = (description?: string): Schema => (description ? { type: "integer", description } : { type: "integer" });
const bool = (description?: string): Schema => (description ? { type: "boolean", description } : { type: "boolean" });
const arr = (items: Schema): Schema => ({ type: "array", items });
const obj = (properties: Record<string, Schema>, required: string[] = []): Schema => ({
  type: "object",
  properties,
  ...(required.length > 0 ? { required } : {}),
});

export const SCHEMAS: Record<string, Schema> = {
  Error: obj({ error: str("A plain sentence saying what went wrong and what to do next.") }, ["error"]),
  ApprovalRequired: obj(
    {
      error: str(),
      code: { type: "string", const: "approval_required" },
      approval: ref("Approval"),
    },
    ["error", "code", "approval"],
  ),
  Approval: obj(
    {
      id: str(),
      tokenId: str(),
      tokenName: str(),
      action: { type: "string", enum: ["database.delete", "checkpoint.rollback", "checkpoint.delete", "import.replace", "sql.destructive"] },
      summary: str(),
      detail: nullable("string"),
      databaseId: nullable("string"),
      databaseName: nullable("string"),
      note: nullable("string"),
      status: { type: "string", enum: ["pending", "approved", "denied", "expired", "used", "cancelled"] },
      requestedAt: int("Milliseconds since the Unix epoch."),
      expiresAt: int(),
      decidedAt: nullable("integer"),
      decidedByDisplayName: nullable("string"),
      approvedUntil: nullable("integer"),
      usedAt: nullable("integer"),
    },
    ["id", "tokenId", "action", "summary", "status", "requestedAt", "expiresAt"],
  ),
  ApprovalResponse: obj({ approval: ref("Approval") }, ["approval"]),
  Database: obj(
    {
      id: str(),
      name: str("The MariaDB schema name."),
      displayName: str(),
      ownerUserId: str(),
      ownerDisplayName: nullable("string"),
      kind: { type: "string", enum: ["standard", "mirror"] },
      mysqlUser: str(),
      connectionsFrom: str("MariaDB host pattern the user may connect from, such as %."),
      tailscaleExposed: bool(),
      lanExposed: bool(),
      createdAt: int(),
      status: { type: "string", enum: ["active", "suspended", "deleting"] },
      versioned: bool(),
      baseCheckpointId: nullable("string"),
      baseShortHash: nullable("string"),
      showInVitals: bool(),
      createdByTokenId: nullable("string"),
      createdByTokenName: nullable("string"),
    },
    ["id", "name", "displayName", "kind", "status", "versioned"],
  ),
  DatabaseList: obj({ databases: arr(ref("Database")) }, ["databases"]),
  DatabaseResponse: obj({ database: ref("Database") }, ["database"]),
  DatabaseCredentials: obj(
    {
      host: str(),
      port: int(),
      schema: str(),
      user: str(),
      password: str(),
      mysqlCli: str(),
      jdbc: str(),
      uri: str(),
    },
    ["host", "port", "schema", "user", "password"],
  ),
  CredentialsResponse: obj({ credentials: ref("DatabaseCredentials") }, ["credentials"]),
  CreateDatabaseRequest: obj(
    {
      displayName: str("Display name, 1 to 200 characters."),
      kind: { type: "string", enum: ["standard", "mirror"] },
      connectionsFrom: str("MariaDB host pattern, such as % or 192.168.1.%."),
      tailnetOnly: bool(),
      versioned: bool(),
      showInVitals: bool(),
      ensure: bool("When true, return the existing database with the same display name (trimmed, case-insensitive) that the caller may manage, instead of creating a second one."),
    },
    ["displayName"],
  ),
  EnsureDatabaseResponse: obj(
    {
      database: ref("Database"),
      credentials: { oneOf: [ref("DatabaseCredentials"), { type: "null" }] },
      created: bool("false when an existing database was returned."),
    },
    ["database", "credentials"],
  ),
  UpdateDatabaseRequest: obj({
    displayName: str(),
    connectionsFrom: str(),
    tailscaleExposed: bool(),
    lanExposed: bool(),
    versioned: bool(),
    showInVitals: bool(),
  }),
  QueryRequest: obj(
    {
      sql: str("One SQL statement."),
      maxRows: int("Most rows to return for an access token: 500 by default, at most 5000."),
    },
    ["sql"],
  ),
  QueryResult: obj(
    {
      columns: arr(str()),
      rows: arr(arr({})),
      durationMs: { type: "number" },
      rowCount: int(),
      truncated: bool("true when rows were cut to maxRows."),
      maxRows: int(),
      versioned: bool(),
      undo: {
        oneOf: [
          obj({ checkpointId: str(), shortHash: str(), createdNow: bool() }, ["checkpointId", "shortHash", "createdNow"]),
          { type: "null" },
        ],
      },
    },
    ["columns", "rows", "rowCount"],
  ),
  Checkpoint: obj(
    {
      id: str(),
      databaseId: str(),
      hash: str(),
      shortHash: str(),
      parentId: nullable("string"),
      message: str(),
      trigger: str(),
      format: { type: "string", enum: ["v1", "legacy"] },
      createdByDisplayName: nullable("string"),
      createdAt: int(),
      tableCount: nullable("integer"),
      rowCount: nullable("integer"),
      logicalBytes: int(),
      storedBytes: int(),
      pinned: bool(),
      isBase: bool("true for the checkpoint the database is at (HEAD)."),
    },
    ["id", "shortHash", "message", "trigger", "createdAt"],
  ),
  CheckpointList: obj({ checkpoints: arr(ref("Checkpoint")), policy: { type: "object" } }, ["checkpoints"]),
  CreateCheckpointRequest: obj({ message: str("Like a commit message."), verify: bool() }),
  RestoreCheckpointRequest: obj({ allowCodeFailures: bool() }),
  Job: obj(
    {
      id: str(),
      kind: str(),
      databaseId: nullable("string"),
      status: { type: "string", enum: ["queued", "running", "succeeded", "failed"] },
      stage: nullable("string"),
      progress: nullable("number"),
      error: nullable("string"),
      warnings: arr(str()),
      result: { type: ["object", "null"] },
      createdAt: int(),
      startedAt: nullable("integer"),
      finishedAt: nullable("integer"),
    },
    ["id", "kind", "status"],
  ),
  JobResponse: obj({ job: ref("Job") }, ["job"]),
  JobList: obj({ jobs: arr(ref("Job")) }, ["jobs"]),
  AccessToken: obj(
    {
      id: str(),
      name: str(),
      preset: { type: "string", enum: ["read_only", "builder", "admin"] },
      prefix: str(),
      status: { type: "string", enum: ["active", "paused", "expired", "revoked"] },
      paused: bool(),
      expiresAt: nullable("integer"),
      databaseIds: { type: ["array", "null"], items: str() },
      allowedFrom: arr({ type: "string", enum: ["loopback", "lan", "tailnet", "cloudflare"] }),
      revealCredentials: bool(),
      askFirst: bool(),
      limits: obj({ maxDatabases: nullable("integer"), requestsPerMinute: int() }),
      databasesCreated: int(),
      pendingApprovals: int(),
    },
    ["id", "name", "preset", "status"],
  ),
  AccessTokenIdentity: obj(
    { token: ref("AccessToken"), can: arr(str()), cannot: arr(str()), allPaused: bool() },
    ["token", "can", "cannot", "allPaused"],
  ),
  UndoPointResponse: obj(
    {
      undo: {
        oneOf: [
          obj({ checkpointId: str(), shortHash: str(), message: str(), createdAt: int(), tokenId: str(), tokenName: str() }),
          { type: "null" },
        ],
      },
      versioned: bool(),
    },
    ["undo", "versioned"],
  ),
  JsonRpcMessage: obj(
    { jsonrpc: { type: "string", const: "2.0" }, id: { type: ["string", "integer"] }, method: str(), params: { type: "object" } },
    ["jsonrpc"],
  ),
};

export { ref };
