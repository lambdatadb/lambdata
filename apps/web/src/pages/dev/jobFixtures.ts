import type { Checkpoint, CodeObjectFailure, Database, Job, UnconvertedSnapshot } from "@lambdata/shared";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

export const FIXTURE_NOW = Date.now();

export const fixtureDatabase: Database = {
  id: "db_fixture_storefront",
  name: "storefront",
  displayName: "Storefront",
  ownerUserId: "user_avery",
  ownerDisplayName: "Avery Chen",
  kind: "standard",
  mysqlUser: "storefront",
  connectionsFrom: "%",
  tailscaleExposed: false,
  lanExposed: true,
  createdAt: FIXTURE_NOW - 90 * 24 * HOUR,
  status: "active",
  versioned: true,
  baseCheckpointId: "cp_head",
  baseShortHash: "c90b5d4",
  showInVitals: true,
};

function checkpoint(partial: Partial<Checkpoint> & Pick<Checkpoint, "id" | "shortHash" | "message">): Checkpoint {
  return {
    databaseId: fixtureDatabase.id,
    hash: `${partial.shortHash}${"0".repeat(64 - partial.shortHash.length)}`,
    treeHash: null,
    parentId: null,
    trigger: "manual",
    format: "v1",
    createdByUserId: "user_avery",
    createdByDisplayName: "Avery Chen",
    createdAt: FIXTURE_NOW - 3 * HOUR,
    tableCount: 3,
    rowCount: 37,
    logicalBytes: 48_213,
    storedBytes: 9_870,
    newBytes: 4_100,
    pinned: false,
    isBase: false,
    limitations: [],
    verifiedAt: null,
    ...partial,
  };
}

export const fixtureTarget = checkpoint({
  id: "cp_target",
  shortHash: "a41f9c2",
  message: "Import October orders",
  createdAt: FIXTURE_NOW - 26 * HOUR,
  verifiedAt: FIXTURE_NOW - 25 * HOUR,
});

export const fixtureSafety = checkpoint({
  id: "cp_safety",
  shortHash: "e7d2a10",
  message: "Before rolling back to a41f9c2",
  trigger: "pre-restore",
  parentId: "cp_head",
  createdByUserId: null,
  createdByDisplayName: null,
  createdAt: FIXTURE_NOW - 4 * MINUTE,
});

export const fixtureLimited = checkpoint({
  id: "cp_head",
  shortHash: "c90b5d4",
  message: "Raise prices by 8 percent",
  parentId: "cp_target",
  isBase: true,
  createdAt: FIXTURE_NOW - 2 * HOUR,
  limitations: [
    "view monthly_revenue could not be queried when this checkpoint was taken (it refers to a table, column or function that does not exist); rolling back keeps or re-creates it only where MariaDB accepts its definition",
    "column legacy_flags of table products has the type geometry, which LambData does not recognise; its values are stored as raw bytes and checked when restored",
  ],
});

export const fixtureCheckpoints: Checkpoint[] = [fixtureSafety, fixtureLimited, fixtureTarget];

export const fixtureFailures: CodeObjectFailure[] = [
  {
    kind: "view",
    name: "monthly_revenue",
    error:
      "The view reads reporting.fx_rates, a table outside this database, which LambData does not re-create automatically. SELECT command denied to user for table `reporting`.`fx_rates`",
  },
  { kind: "trigger", name: "orders_before_insert", error: "Unknown column 'discount_cents' in 'NEW'" },
  { kind: "procedure", name: "refresh_stock", error: "FUNCTION storefront.stock_level does not exist" },
];

function job(partial: Partial<Job> & Pick<Job, "id" | "kind" | "status">): Job {
  return {
    databaseId: fixtureDatabase.id,
    stage: null,
    progress: partial.status === "succeeded" ? 1 : null,
    error: null,
    errorCode: null,
    errorDetails: null,
    warnings: [],
    result: null,
    createdByUserId: "user_avery",
    createdAt: FIXTURE_NOW - 6 * MINUTE,
    startedAt: FIXTURE_NOW - 6 * MINUTE,
    finishedAt: partial.status === "succeeded" || partial.status === "failed" ? FIXTURE_NOW - 4 * MINUTE : null,
    ...partial,
  };
}

export const runningRestore = job({
  id: "job_running",
  kind: "checkpoint.restore",
  status: "running",
  progress: 0.42,
  stage: "Loading a41f9c2 into a staging copy",
});

export const refusedRestore = job({
  id: "job_refused",
  kind: "checkpoint.restore",
  status: "failed",
  progress: 0.55,
  stage: "Checking that every view, trigger and routine can be re-created",
  error:
    "Rolling back to a41f9c2 was stopped before anything changed: a trial run in the staging copy showed that some of its views, triggers or routines cannot be re-created here, so the live database was left exactly as it was. these could not be re-created: view monthly_revenue (the view reads reporting.fx_rates, a table outside this database, which LambData does not re-create automatically), trigger orders_before_insert (Unknown column 'discount_cents' in 'NEW'), procedure refresh_stock (FUNCTION storefront.stock_level does not exist).",
  errorCode: "restore.code-unrestorable",
  errorDetails: { codeFailures: fixtureFailures },
});

export const failedRestore = job({
  id: "job_failed",
  kind: "checkpoint.restore",
  status: "failed",
  progress: 0.4,
  error:
    "Rolling back to a41f9c2 was stopped before anything changed: after loading the checkpoint into a staging copy, it did not match what the checkpoint recorded, so the live database was left exactly as it was. table orders: 24 rows recorded, 23 loaded; table products: the checksum of the loaded rows differs from the one recorded; table customers: column joined_on is DATE in the checkpoint but DATETIME after loading; and 2 more.",
});

export const doneWithErrorsRestore = job({
  id: "job_forced",
  kind: "checkpoint.restore",
  status: "succeeded",
  warnings: [
    "Rolled back anyway: the tables of a41f9c2 are back, but 2 view(s), trigger(s) or routine(s) could not be re-created and are now missing from the live database: view monthly_revenue, trigger orders_before_insert. Their previous definitions are in checkpoint e7d2a10, saved before this rollback.",
    "could not re-create view monthly_revenue: The view reads reporting.fx_rates, a table outside this database",
    "view sales_summary is kept as recorded but cannot be queried: it refers to a table, column or function that does not exist",
  ],
  result: {
    restoredCheckpointId: fixtureTarget.id,
    safetyCheckpointId: fixtureSafety.id,
    outcome: "done-with-errors",
    codeFailures: fixtureFailures.slice(0, 2),
  },
});

export const succeededRestore = job({
  id: "job_done",
  kind: "checkpoint.restore",
  status: "succeeded",
  result: { restoredCheckpointId: fixtureTarget.id, safetyCheckpointId: fixtureSafety.id, outcome: "done", codeFailures: [] },
});

export const doneWithErrorsSync = job({
  id: "job_sync",
  kind: "sync.run",
  status: "succeeded",
  warnings: ["could not re-create view monthly_revenue: The view reads reporting.fx_rates, a table outside this database"],
  result: {
    status: "ok",
    tables: 3,
    preSyncCheckpointId: null,
    checkpointId: null,
    unchanged: false,
    outcome: "done-with-errors",
    codeFailures: fixtureFailures.slice(0, 1),
  },
});

export const doneWithErrorsImport = job({
  id: "job_import",
  kind: "import.sql",
  status: "succeeded",
  warnings: [
    "The data was replaced, but 1 view(s), trigger(s), routine(s) or event(s) from the file could not be created and are missing from the database: trigger orders_before_insert (Unknown column 'discount_cents' in 'NEW'). The previous contents are saved in checkpoint e7d2a10.",
    "3 view(s), trigger(s), routine(s) or event(s) from the previous contents were removed with the old tables; the imported file does not define them.",
  ],
  result: {
    importId: "imp_fixture",
    tableCount: 3,
    rowCount: 37,
    safetyCheckpointId: fixtureSafety.id,
    checkpointId: null,
    durationMs: 2_400,
    outcome: "done-with-errors",
    codeFailures: fixtureFailures.slice(1, 2),
  },
});

export const limitedCreate = job({
  id: "job_create",
  kind: "checkpoint.create",
  status: "succeeded",
  result: { checkpointId: fixtureLimited.id, unchanged: false, limitations: fixtureLimited.limitations, verified: true },
});

export const fixtureUnconverted: UnconvertedSnapshot[] = [
  {
    snapshotId: "snap_0193",
    databaseId: fixtureDatabase.id,
    createdAt: FIXTURE_NOW - 41 * 24 * HOUR,
    trigger: "scheduled",
    sizeBytes: 2_481_920,
    reason: "the snapshot file ends in the middle of a statement (gzip stream truncated at 2.3 MB); it cannot be loaded as it is",
    failedAt: FIXTURE_NOW - 2 * HOUR,
    attempts: 3,
  },
  {
    snapshotId: "snap_0188",
    databaseId: fixtureDatabase.id,
    createdAt: FIXTURE_NOW - 58 * 24 * HOUR,
    trigger: "manual",
    sizeBytes: 1_102_336,
    reason: "the snapshot file /data/snapshots/storefront-1757000000000.sql.gz is missing",
    failedAt: FIXTURE_NOW - 2 * HOUR,
    attempts: 1,
  },
];
