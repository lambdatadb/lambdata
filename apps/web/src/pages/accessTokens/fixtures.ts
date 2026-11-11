import type {
  AccessToken,
  AccessTokenListResponse,
  AccessTokenPresetInfo,
  Approval,
  ApprovalListResponse,
  TokenActivityEntry,
} from "@lambdata/shared";

export const FIXTURE_SECRET = "ld_fixtureSecretValue0123456789abcdefghijKLMNOP";

export const fixturePresets: AccessTokenPresetInfo[] = [
  {
    preset: "admin",
    label: "Admin",
    summary: "Manages every database on this server, like an admin in the console, but never people or settings.",
    can: ["Everything Builder can do, on every database", "Read and change databases other people created"],
    cannot: ["Manage console users, sign-in or settings", "Change the network, Tailscale or notifications", "Create or change access tokens", "Approve its own requests"],
    canRevealCredentials: true,
    defaults: { revealCredentials: false, askFirst: true, allowedFrom: ["loopback", "lan", "tailnet"], limits: { maxDatabases: null, requestsPerMinute: 120 } },
  },
  {
    preset: "read_only",
    label: "Read only",
    summary: "Looks around without changing anything.",
    can: ["List databases, tables and checkpoints", "Read metrics, sync status and jobs", "Run SELECT queries"],
    cannot: ["Change or delete anything", "See database passwords"],
    canRevealCredentials: false,
    defaults: { revealCredentials: false, askFirst: false, allowedFrom: ["loopback", "lan", "tailnet"], limits: { maxDatabases: null, requestsPerMinute: 120 } },
  },
  {
    preset: "builder",
    label: "Builder",
    summary: "Creates its own databases and manages only those.",
    can: ["Create databases, up to its limit", "Change, query, import into and roll back the databases it created", "Save checkpoints of its databases"],
    cannot: ["See or touch databases it did not create", "Manage users, settings or the network"],
    canRevealCredentials: true,
    defaults: { revealCredentials: true, askFirst: false, allowedFrom: ["loopback", "lan", "tailnet"], limits: { maxDatabases: 10, requestsPerMinute: 120 } },
  },
];

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

function token(now: number, patch: Partial<AccessToken> & Pick<AccessToken, "id" | "name" | "preset" | "prefix">): AccessToken {
  return {
    status: "active",
    paused: false,
    createdAt: now - 10 * DAY,
    createdByUserId: "usr_fixture_admin",
    createdByDisplayName: "Avery Chen",
    expiresAt: null,
    revokedAt: null,
    lastUsedAt: now - 5 * 60_000,
    lastUsedFrom: "203.0.113.7",
    lastUsedVia: "mcp",
    databaseIds: null,
    allowedFrom: ["loopback", "lan", "tailnet"],
    revealCredentials: false,
    askFirst: false,
    limits: { maxDatabases: null, requestsPerMinute: 120 },
    databasesCreated: 0,
    pendingApprovals: 0,
    ...patch,
  };
}

export function fixtureTokens(now: number): AccessToken[] {
  return [
    token(now, {
      id: "tok_builder",
      name: "Build bot",
      preset: "builder",
      prefix: "ld_ab12cd",
      revealCredentials: true,
      limits: { maxDatabases: 10, requestsPerMinute: 120 },
      databasesCreated: 3,
      pendingApprovals: 1,
      askFirst: true,
    }),
    token(now, {
      id: "tok_reader",
      name: "Reporting script",
      preset: "read_only",
      prefix: "ld_9f8e7d",
      lastUsedVia: "api",
      lastUsedFrom: "198.51.100.24",
      lastUsedAt: now - 2 * DAY,
      paused: true,
      status: "paused",
    }),
    token(now, {
      id: "tok_old",
      name: "Old experiment",
      preset: "admin",
      prefix: "ld_0a0b0c",
      status: "expired",
      expiresAt: now - 3 * DAY,
      lastUsedAt: null,
      lastUsedFrom: null,
      lastUsedVia: null,
    }),
    token(now, {
      id: "tok_gone",
      name: "Laptop agent",
      preset: "admin",
      prefix: "ld_7c7c7c",
      status: "revoked",
      revokedAt: now - 1 * DAY,
      askFirst: true,
    }),
  ];
}

export function fixtureTokenList(now: number, patch: Partial<AccessTokenListResponse> = {}): AccessTokenListResponse {
  return { tokens: fixtureTokens(now), allPaused: false, presets: fixturePresets, ...patch };
}

export function fixtureApprovals(now: number): Approval[] {
  return [
    {
      id: "apr_drop",
      tokenId: "tok_builder",
      tokenName: "Build bot",
      action: "sql.destructive",
      summary: "Run DROP TABLE staging_orders on Storefront",
      detail: "DROP TABLE staging_orders;",
      databaseId: "db_fixture_store",
      databaseName: "Storefront",
      note: "Cleaning up the staging table after the migration test",
      status: "pending",
      requestedAt: now - 10 * 60_000,
      expiresAt: now + 23 * HOUR,
      decidedAt: null,
      decidedByDisplayName: null,
      usedAt: null,
    },
    {
      id: "apr_late",
      tokenId: "tok_builder",
      tokenName: "Build bot",
      action: "database.delete",
      summary: "Delete the database Scratch Pad",
      detail: null,
      databaseId: "db_fixture_scratch",
      databaseName: "Scratch Pad",
      note: null,
      status: "pending",
      requestedAt: now - 25 * HOUR,
      expiresAt: now - HOUR,
      decidedAt: null,
      decidedByDisplayName: null,
      usedAt: null,
    },
    {
      id: "apr_used",
      tokenId: "tok_builder",
      tokenName: "Build bot",
      action: "checkpoint.rollback",
      summary: "Roll back Storefront to checkpoint a41f9c2",
      detail: null,
      databaseId: "db_fixture_store",
      databaseName: "Storefront",
      note: "Undo the failed seed run",
      status: "used",
      requestedAt: now - 2 * DAY,
      expiresAt: now - DAY,
      decidedAt: now - 2 * DAY + 5 * 60_000,
      decidedByDisplayName: "Avery Chen",
      usedAt: now - 2 * DAY + 6 * 60_000,
    },
    {
      id: "apr_denied",
      tokenId: "tok_builder",
      tokenName: "Build bot",
      action: "database.delete",
      summary: "Delete the database Ledger",
      detail: null,
      databaseId: "db_fixture_ledger",
      databaseName: "Ledger",
      note: null,
      status: "denied",
      requestedAt: now - 3 * DAY,
      expiresAt: now - 2 * DAY,
      decidedAt: now - 3 * DAY + 60_000,
      decidedByDisplayName: "Avery Chen",
      usedAt: null,
    },
  ];
}

export function fixtureApprovalList(now: number): ApprovalListResponse {
  const approvals = fixtureApprovals(now);
  return { approvals, pending: approvals.filter((a) => a.status === "pending").length };
}

export function fixtureActivity(now: number, from: number, count: number): TokenActivityEntry[] {
  return Array.from({ length: count }, (_, i) => {
    const id = from - i;
    const kind = id % 4;
    return {
      id,
      tokenId: "tok_builder",
      at: now - (1000 - id) * 60_000,
      via: kind === 1 ? "api" : "mcp",
      action: kind === 0 ? "sql.run" : kind === 1 ? "database.create" : kind === 2 ? "database.delete" : "checkpoint.list",
      summary:
        kind === 0
          ? `Ran a query on Storefront (#${id})`
          : kind === 1
            ? `Created the database Scratch ${id}`
            : kind === 2
              ? `Asked to delete Scratch ${id}`
              : `Tried to list checkpoints of Ledger (#${id})`,
      databaseId: kind === 3 ? null : "db_fixture_store",
      databaseName: kind === 3 ? null : "Storefront",
      outcome: kind === 0 ? "ok" : kind === 1 ? "error" : kind === 2 ? "waiting-approval" : "refused",
      status: kind === 0 ? 200 : kind === 1 ? 500 : kind === 2 ? 403 : 404,
      note: kind === 0 ? "Checking the order totals" : null,
      from: "203.0.113.7",
      detail: kind === 0 ? `SELECT count(*) FROM orders WHERE id > ${id};` : null,
    };
  });
}
