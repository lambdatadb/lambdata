import type { CheckpointPolicy, CheckpointSchedule, Database, SyncJob, SyncJobResult, WorkingCopyStatus } from "@lambdata/shared";
import { fixtureDatabase } from "./jobFixtures";

const HOUR = 3_600_000;

export const fixtureMirror: Database = {
  ...fixtureDatabase,
  id: "db_fixture_game_mirror",
  name: "game_mirror",
  displayName: "Game Mirror",
  kind: "mirror",
  versioned: true,
};

export const fixturePolicy: CheckpointPolicy = {
  versioned: true,
  autoIntervalHours: 24,
  autoRetention: 7,
  checkpointOnSync: true,
  manualSyncCheckpoint: "ask",
};

export function fixtureSchedule(now = Date.now()): CheckpointSchedule {
  return { lastAutomaticAt: now - 3 * HOUR, nextDueAt: now + 21 * HOUR };
}

export const fixtureSync: SyncJob = {
  id: "sj_fixture",
  databaseId: fixtureMirror.id,
  sourceKind: "mysql",
  sourceHost: "games.example.com",
  sourcePort: 3306,
  sourceUser: "reader",
  sourceDatabase: "leaderboard",
  intervalSeconds: 3600,
  lastRunAt: Date.now() - 20 * 60_000,
  lastStatus: "ok",
  lastError: null,
  enabled: true,
};

export function fixtureSyncedStatus(databaseId = fixtureMirror.id): WorkingCopyStatus {
  return {
    databaseId,
    baseCheckpointId: "cp_head",
    state: "dirty",
    reason: null,
    computedAt: Date.now() - 60_000,
    matchesLastSync: true,
    diff: {
      fromId: "cp_head",
      toId: "working",
      tables: [{ name: "scores", change: "modified", schemaChanged: false, rowsBefore: 1180, rowsAfter: 1204 }],
      codeChanged: false,
      unchangedTables: 2,
      rowDelta: 24,
    },
  };
}

const baseResult: SyncJobResult = {
  status: "ok",
  tables: 3,
  preSyncCheckpointId: null,
  checkpointId: null,
  unchanged: false,
  outcome: "done",
  codeFailures: [],
  manual: true,
  checkpointKind: null,
  checkpointSkipped: null,
  nextAutomaticDueAt: null,
};

export function fixtureSyncResults(now = Date.now()): Record<string, SyncJobResult> {
  return {
    additional: { ...baseResult, checkpointId: "cp_additional", checkpointKind: "additional" },
    automatic: { ...baseResult, manual: false, checkpointId: "cp_auto", checkpointKind: "automatic" },
    notDue: { ...baseResult, manual: false, checkpointSkipped: "not-due", nextAutomaticDueAt: now + 21 * HOUR },
    unchanged: { ...baseResult, unchanged: true, checkpointSkipped: "unchanged" },
    declined: { ...baseResult, checkpointSkipped: "declined" },
  };
}
