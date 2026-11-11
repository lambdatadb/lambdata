import { useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CalendarClock, GitBranch, Info, RefreshCw } from "lucide-react";
import type {
  CheckpointPolicy,
  CheckpointSchedule,
  Database,
  ManualSyncCheckpointMode,
  SyncJob,
  UpdateCheckpointPolicyRequest,
} from "@lambdata/shared";
import { QueryError } from "../../components/layout/QueryError";
import { SettingsSection } from "../../components/settings/SettingsSection";
import {
  Alert,
  Badge,
  Button,
  Card,
  Field,
  Input,
  RadioGroup,
  RadioGroupItem,
  SelectMenu,
  SkeletonRows,
  Switch,
  toast,
} from "../../components/ui";
import { useCheckpointList } from "../../components/checkpoints/queries";
import {
  INTERVALS,
  SYNC_INTERVALS,
  formatDue,
  interactionNotes,
  intervalLabel,
  lastCheckFoundNothing,
  manualMode,
  settingsSummary,
  spanText,
  syncIntervalLabel,
  usePolicyMutation,
} from "../../components/checkpoints/policy";
import { api, errorMessage } from "../../lib/api";
import { useCanWriteDatabase, useIsAdmin } from "../../lib/auth";
import { databasePath } from "../../lib/commands";
import { formatDate, formatRelativeTime, pluralize } from "../../lib/format";
import { queryKeys, useAppSettings } from "../../lib/queries";
import type { DatabaseTabProps } from "./types";

export interface OwnerLimits {
  minHours: number;
  maxKeep: number;
}

export interface Draft {
  versioned: boolean;
  autoIntervalHours: number;
  autoRetention: string;
  checkpointOnSync: boolean;
  manualSyncCheckpoint: ManualSyncCheckpointMode;
  syncEnabled: boolean;
  syncIntervalSeconds: number;
}

export function draftOf(policy: CheckpointPolicy, sync: SyncJob | null): Draft {
  return {
    versioned: policy.versioned,
    autoIntervalHours: policy.autoIntervalHours,
    autoRetention: String(policy.autoRetention),
    checkpointOnSync: policy.checkpointOnSync,
    manualSyncCheckpoint: manualMode(policy),
    syncEnabled: sync?.enabled ?? true,
    syncIntervalSeconds: sync?.intervalSeconds ?? 3600,
  };
}

export function retentionProblem(value: string, limits: OwnerLimits | null): string | null {
  const n = Number(value);
  const max = limits?.maxKeep ?? 1000;
  if (!Number.isInteger(n) || n < 1 || n > max) return `Enter a whole number from 1 to ${max}.`;
  return null;
}

export function policyChanges(draft: Draft, policy: CheckpointPolicy): UpdateCheckpointPolicyRequest {
  const body: UpdateCheckpointPolicyRequest = {};
  if (draft.versioned !== policy.versioned) body.versioned = draft.versioned;
  if (draft.autoIntervalHours !== policy.autoIntervalHours) body.autoIntervalHours = draft.autoIntervalHours;
  if (Number(draft.autoRetention) !== policy.autoRetention) body.autoRetention = Number(draft.autoRetention);
  if (draft.checkpointOnSync !== policy.checkpointOnSync) body.checkpointOnSync = draft.checkpointOnSync;
  if (draft.manualSyncCheckpoint !== manualMode(policy)) body.manualSyncCheckpoint = draft.manualSyncCheckpoint;
  return body;
}

export function syncChanged(draft: Draft, sync: SyncJob | null): boolean {
  return !!sync && (draft.syncEnabled !== sync.enabled || draft.syncIntervalSeconds !== sync.intervalSeconds);
}

function policyFromDraft(draft: Draft, policy: CheckpointPolicy): CheckpointPolicy {
  const keep = Number(draft.autoRetention);
  return {
    versioned: draft.versioned,
    autoIntervalHours: draft.autoIntervalHours,
    autoRetention: Number.isInteger(keep) && keep > 0 ? keep : policy.autoRetention,
    checkpointOnSync: draft.checkpointOnSync,
    manualSyncCheckpoint: draft.manualSyncCheckpoint,
  };
}

function withCurrent(options: { value: number; label: string }[], current: number, label: (n: number) => string): { value: number; label: string }[] {
  return options.some((o) => o.value === current) ? options : [...options, { value: current, label: label(current) }];
}

export interface DatabaseSettingsProps {
  db: Database;
  policy: CheckpointPolicy;
  schedule: CheckpointSchedule | null;
  sync: SyncJob | null;
  canWrite: boolean;
  limits: OwnerLimits | null;
  saving?: boolean;
  error?: unknown;
  onSave?: (draft: Draft) => void;
  initialDraft?: Draft;
  checkpoints?: { trigger: string; createdAt: number }[];
}

function Note({ children }: { children: ReactNode }) {
  return (
    <p className="flex items-start gap-2 text-label text-text-muted" data-interaction-note>
      <Info aria-hidden className="mt-0.5 size-3.5 shrink-0 text-text-subtle" />
      <span>{children}</span>
    </p>
  );
}

export function DatabaseSettings({ db, policy, schedule, sync, canWrite, limits, saving = false, error, onSave, initialDraft, checkpoints }: DatabaseSettingsProps) {
  const [draft, setDraft] = useState<Draft>(() => initialDraft ?? draftOf(policy, sync));
  const set = (next: Partial<Draft>) => setDraft((d) => ({ ...d, ...next }));
  const mirror = db.kind === "mirror";
  const preview = policyFromDraft(draft, policy);
  const previewSync = sync ? { enabled: draft.syncEnabled, intervalSeconds: draft.syncIntervalSeconds } : null;
  const summary = settingsSummary({ kind: db.kind, policy: preview, sync: previewSync });
  const notes = interactionNotes({ kind: db.kind, policy: preview, sync: previewSync });
  const keepProblem = retentionProblem(draft.autoRetention, limits);
  const changes = policyChanges(draft, policy);
  const dirty = Object.keys(changes).length > 0 || syncChanged(draft, sync);
  const minHours = limits?.minHours ?? 1;
  const intervalOptions = withCurrent(
    INTERVALS.filter((i) => i.value === 0 || i.value >= minHours),
    policy.autoIntervalHours,
    intervalLabel,
  );
  const syncOptions = withCurrent(SYNC_INTERVALS, sync?.intervalSeconds ?? 3600, syncIntervalLabel);
  const keep = Number(draft.autoRetention);
  const afterSyncApplies = mirror && draft.versioned && draft.autoIntervalHours > 0;

  return (
    <form
      className="pb-24"
      onSubmit={(e) => {
        e.preventDefault();
        if (canWrite && dirty && !keepProblem) onSave?.(draft);
      }}
      data-settings-form={db.kind}
    >
      <Card className="mb-8 border-accent/25 p-5 sm:p-6" data-settings-summary>
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-label font-medium text-text-muted">At a glance</h2>
          {dirty && (
            <Badge variant="warn" size="sm">
              unsaved changes
            </Badge>
          )}
        </div>
        <p className="mt-2 max-w-3xl text-heading font-normal leading-7 text-text" data-summary-text>
          {summary.join(" ")}
        </p>
        <dl className="mt-4 grid gap-x-8 gap-y-2 text-label sm:grid-cols-2 sm:max-w-xl">
          <div className="flex items-center gap-2">
            <CalendarClock aria-hidden className="size-3.5 shrink-0 text-text-subtle" />
            <dt className="text-text-muted">Last automatic check</dt>
            <dd className="text-text" title={schedule?.lastAutomaticAt ? formatDate(schedule.lastAutomaticAt) : undefined}>
              {schedule?.lastAutomaticAt ? formatRelativeTime(schedule.lastAutomaticAt) : "none yet"}
              {lastCheckFoundNothing(schedule?.lastAutomaticAt, checkpoints) && <span className="text-text-muted"> (nothing had changed)</span>}
            </dd>
          </div>
          <div className="flex items-center gap-2">
            <CalendarClock aria-hidden className="size-3.5 shrink-0 text-text-subtle" />
            <dt className="text-text-muted">Next one due</dt>
            <dd className="text-text" title={schedule?.nextDueAt ? formatDate(schedule.nextDueAt) : undefined}>
              {policy.autoIntervalHours <= 0 || !schedule ? "off" : schedule.nextDueAt ? `after ${formatDue(schedule.nextDueAt)}` : "at the next check"}
            </dd>
          </div>
        </dl>
      </Card>

      {!canWrite && (
        <Alert variant="neutral" className="mb-8">
          You can see these settings. The database's owner or an admin can change them.
        </Alert>
      )}

      <fieldset disabled={!canWrite || saving} className="min-w-0">
        <SettingsSection id="versioning" title="Versioning" description="Whether this database is treated as a repository.">
          <Card>
            <Switch
              label={
                <span className="inline-flex items-center gap-1.5">
                  <GitBranch aria-hidden className="size-3.5 text-text-muted" />
                  Versioned
                </span>
              }
              description={
                mirror
                  ? "Its card shows whether the live data changed since the last checkpoint, and syncs can be recorded as checkpoints."
                  : "Its card shows whether the live data changed since the last checkpoint."
              }
              checked={draft.versioned}
              onCheckedChange={(v) => set({ versioned: v })}
              disabled={!canWrite || saving}
            />
          </Card>
        </SettingsSection>

        {mirror && (
          <SettingsSection id="sync" title="Sync" description="How often this mirror copies its source.">
            {!sync ? (
              <Alert variant="info" title="No source yet">
                Set up where it copies from on the <Link to={databasePath(db.id, "sync")}>Sync</Link> tab first.
              </Alert>
            ) : (
              <Card className="space-y-5">
                <Switch
                  label={
                    <span className="inline-flex items-center gap-1.5">
                      <RefreshCw aria-hidden className="size-3.5 text-text-muted" />
                      Sync on a schedule
                    </span>
                  }
                  description={draft.syncEnabled ? "On. Sync now works either way." : "Paused. The mirror keeps its data until you sync it by hand."}
                  checked={draft.syncEnabled}
                  onCheckedChange={(v) => set({ syncEnabled: v })}
                  disabled={!canWrite || saving}
                />
                <Field label="How often" hint={`Copies ${sync.sourceHost}/${sync.sourceDatabase}.`}>
                  <SelectMenu
                    value={String(draft.syncIntervalSeconds)}
                    onValueChange={(v) => set({ syncIntervalSeconds: Number(v) })}
                    disabled={!canWrite || saving || !draft.syncEnabled}
                    options={syncOptions.map((o) => ({ value: String(o.value), label: o.label }))}
                  />
                </Field>
              </Card>
            )}
          </SettingsSection>
        )}

        <SettingsSection
          id="checkpoints"
          title="Checkpoints"
          description="Automatic checkpoints, and what a sync adds. Checkpoints you make by hand are never removed automatically."
        >
          <Card className="space-y-5">
            <div className="grid gap-4 sm:grid-cols-2">
              <Field
                label="Automatic checkpoints"
                hint={
                  limits && limits.minHours > 1
                    ? `Skipped when nothing changed. This server allows at most one every ${pluralize(limits.minHours, "hour")}.`
                    : "Skipped when nothing changed since the last one."
                }
              >
                <SelectMenu
                  value={String(draft.autoIntervalHours)}
                  onValueChange={(v) => set({ autoIntervalHours: Number(v) })}
                  disabled={!canWrite || saving}
                  options={intervalOptions.map((o) => ({ value: String(o.value), label: o.label }))}
                />
              </Field>
              <Field
                label="How many to keep"
                error={canWrite ? (keepProblem ?? undefined) : undefined}
                hint={
                  draft.autoIntervalHours > 0 && !keepProblem
                    ? `About ${spanText(draft.autoIntervalHours * keep)} of automatic history.${limits ? ` At most ${limits.maxKeep} on this server.` : ""}`
                    : limits
                      ? `At most ${limits.maxKeep} on this server.`
                      : "The newest ones are kept."
                }
              >
                <Input
                  mono
                  type="number"
                  inputMode="numeric"
                  min={1}
                  max={limits?.maxKeep ?? 1000}
                  value={draft.autoRetention}
                  onChange={(e) => set({ autoRetention: e.target.value })}
                  disabled={!canWrite || saving || draft.autoIntervalHours <= 0}
                />
              </Field>
            </div>

            {mirror && (
              <div className="space-y-5 border-t border-border pt-5">
                <Switch
                  label="Take the automatic checkpoint right after a sync"
                  description={
                    !draft.versioned
                      ? "Takes effect once the database is versioned."
                      : draft.checkpointOnSync
                        ? "The automatic checkpoint matches a finished sync. At most one per period, however often it syncs."
                        : "Off: the schedule takes the automatic checkpoint on its own clock, and syncs record none."
                  }
                  checked={draft.checkpointOnSync}
                  onCheckedChange={(v) => set({ checkpointOnSync: v })}
                  disabled={!canWrite || saving || !afterSyncApplies}
                />
                <div className="space-y-2.5">
                  <div>
                    <p className="text-body font-medium text-text">After a manual sync</p>
                    <p className="text-label text-text-muted">
                      {draft.versioned
                        ? "An additional checkpoint does not replace the automatic one and is kept until you delete it."
                        : "Takes effect once the database is versioned."}
                    </p>
                  </div>
                  <RadioGroup
                    value={draft.manualSyncCheckpoint}
                    onValueChange={(v) => set({ manualSyncCheckpoint: v as ManualSyncCheckpointMode })}
                    disabled={!canWrite || saving || !draft.versioned}
                    aria-label="After a manual sync"
                    className="gap-3"
                  >
                    <RadioGroupItem value="ask" label="Ask each time" description="Sync now asks whether to add a checkpoint." />
                    <RadioGroupItem value="always" label="Always add a checkpoint" />
                    <RadioGroupItem value="never" label="Never" />
                  </RadioGroup>
                </div>
              </div>
            )}
            {notes.map((note) => (
              <Note key={note}>{note}</Note>
            ))}
          </Card>
        </SettingsSection>
      </fieldset>

      {canWrite && (
        <div className="sticky bottom-0 z-10 -mx-4 border-t border-border bg-bg/95 px-4 py-3 backdrop-blur sm:-mx-6 sm:px-6 lg:-mx-8 lg:px-8" data-save-bar>
          <div className="flex flex-wrap items-center justify-end gap-x-3 gap-y-2">
            {error ? <p className="mr-auto min-w-0 text-label text-danger">{errorMessage(error)}</p> : null}
            {!error && (
              <p className="mr-auto text-label text-text-muted">{dirty ? "You have unsaved changes." : "Everything is saved."}</p>
            )}
            <div className="flex shrink-0 items-center gap-2">
              <Button variant="ghost" size="sm" disabled={!dirty || saving} onClick={() => setDraft(draftOf(policy, sync))}>
                Discard
              </Button>
              <Button type="submit" size="sm" loading={saving} disabled={!dirty || !!keepProblem}>
                Save settings
              </Button>
            </div>
          </div>
        </div>
      )}
    </form>
  );
}

export function SettingsTab({ db }: DatabaseTabProps) {
  const qc = useQueryClient();
  const canWrite = useCanWriteDatabase(db);
  const isAdmin = useIsAdmin();
  const history = useCheckpointList(db.id);
  const mirror = db.kind === "mirror";
  const syncQuery = useQuery({
    queryKey: queryKeys.sync(db.id),
    queryFn: () => api.get<{ sync: SyncJob | null }>(`/databases/${db.id}/sync`),
    enabled: mirror,
  });
  const settings = useAppSettings();
  const policyMutation = usePolicyMutation(db);
  const syncMutation = useMutation({
    mutationFn: (body: Record<string, unknown>) => api.put<{ sync: SyncJob }>(`/databases/${db.id}/sync`, body),
    onSuccess: () => void qc.invalidateQueries({ queryKey: queryKeys.sync(db.id) }),
  });
  const [error, setError] = useState<unknown>(null);

  if (history.isPending || (mirror && syncQuery.isPending)) {
    return (
      <Card>
        <SkeletonRows rows={5} label="Loading settings" />
      </Card>
    );
  }
  if (history.isError) return <QueryError error={history.error} title="Could not load the settings" onRetry={history.refetch} />;
  if (mirror && syncQuery.isError) return <QueryError error={syncQuery.error} title="Could not load the sync settings" onRetry={syncQuery.refetch} />;

  const policy = history.data.policy;
  const sync = mirror ? (syncQuery.data?.sync ?? null) : null;
  const rawLimits = settings.data?.limits;
  const limits = canWrite && !isAdmin && rawLimits ? { minHours: rawLimits.checkpointMinIntervalHours, maxKeep: rawLimits.checkpointMaxAutoRetention } : null;

  const save = async (draft: Draft) => {
    setError(null);
    try {
      const body = policyChanges(draft, policy);
      if (Object.keys(body).length > 0) await policyMutation.mutateAsync(body);
      if (sync && syncChanged(draft, sync)) {
        await syncMutation.mutateAsync({
          sourceKind: sync.sourceKind,
          sourceHost: sync.sourceHost,
          sourcePort: sync.sourcePort,
          sourceUser: sync.sourceUser,
          sourceDatabase: sync.sourceDatabase,
          intervalSeconds: draft.syncIntervalSeconds,
          enabled: draft.syncEnabled,
        });
      }
      toast.success("Settings saved");
    } catch (e) {
      setError(e);
    }
  };

  return (
    <DatabaseSettings
      key={`${JSON.stringify(policy)}:${sync?.intervalSeconds ?? ""}:${sync?.enabled ?? ""}`}
      db={db}
      policy={policy}
      schedule={history.data.schedule ?? null}
      checkpoints={history.data.checkpoints}
      sync={sync}
      canWrite={canWrite}
      limits={limits}
      saving={policyMutation.isPending || syncMutation.isPending}
      error={error}
      onSave={(d) => void save(d)}
    />
  );
}
