import { useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { CalendarClock, GitBranch, HardDrive, Settings2 } from "lucide-react";
import type {
  CheckpointListResponse,
  CheckpointPolicy,
  CheckpointPolicyResponse,
  Database,
  UpdateCheckpointPolicyRequest,
} from "@lambdata/shared";
import { Button } from "../ui/Button";
import { Card } from "../ui/Card";
import { Field } from "../ui/Field";
import { Input } from "../ui/Input";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/Popover";
import { SelectMenu } from "../ui/Select";
import { Skeleton } from "../ui/Skeleton";
import { Switch } from "../ui/Switch";
import { toast } from "../ui/Toast";
import { cn } from "../ui/cn";
import { api, errorMessage } from "../../lib/api";
import { formatBytes, pluralize } from "../../lib/format";
import { queryKeys, useAppSettings } from "../../lib/queries";
import { savingsPercent } from "./meta";
import { checkpointKeys, checkpointPath } from "./queries";

const INTERVALS: { value: number; label: string }[] = [
  { value: 0, label: "Off" },
  { value: 1, label: "Every hour" },
  { value: 6, label: "Every 6 hours" },
  { value: 12, label: "Every 12 hours" },
  { value: 24, label: "Daily" },
  { value: 168, label: "Weekly" },
];

export function intervalLabel(hours: number): string {
  const known = INTERVALS.find((i) => i.value === hours);
  if (known) return known.label;
  return hours % 24 === 0 ? `Every ${hours / 24} days` : `Every ${hours} hours`;
}

export function policySummary(policy: CheckpointPolicy, mirror: boolean): string {
  if (policy.autoIntervalHours <= 0) return mirror && policy.versioned && policy.checkpointOnSync ? "Automatic off · after sync" : "Automatic off";
  const parts = [intervalLabel(policy.autoIntervalHours), `keep ${policy.autoRetention}`];
  if (mirror && policy.versioned && policy.checkpointOnSync) parts.push("after sync");
  return parts.join(" · ");
}

function usePolicyMutation(db: Database) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: UpdateCheckpointPolicyRequest) =>
      api.put<CheckpointPolicyResponse>(checkpointPath(db.id, "/policy"), body),
    onSuccess: (res) => {
      qc.setQueryData<CheckpointListResponse>(checkpointKeys.list(db.id), (prev) => (prev ? { ...prev, policy: res.policy } : prev));
      void qc.invalidateQueries({ queryKey: queryKeys.database(db.id) });
      void qc.invalidateQueries({ queryKey: queryKeys.databases, exact: true });
      void qc.invalidateQueries({ queryKey: queryKeys.dashboardSummary });
      void qc.invalidateQueries({ queryKey: checkpointKeys.status(db.id) });
    },
  });
}

export interface HistoryHeaderProps {
  db: Database;
  data: CheckpointListResponse | undefined;
  loading: boolean;
  canWrite: boolean;
}

export function HistoryHeader({ db, data, loading, canWrite }: HistoryHeaderProps) {
  const policy = data?.policy;
  const storage = data?.storage;
  const versioned = policy?.versioned ?? db.versioned;
  const mutation = usePolicyMutation(db);
  const unshared = (data?.checkpoints ?? []).reduce((n, cp) => n + cp.storedBytes, 0);
  const saving = savingsPercent(storage?.storedBytes ?? 0, unshared);

  return (
    <Card flush className="grid grid-cols-1 divide-y divide-border md:grid-cols-[minmax(0,1.25fr)_minmax(0,1fr)_minmax(0,1fr)] md:divide-x md:divide-y-0">
      <div className="min-w-0 px-5 py-4">
        <Switch
          label={
            <span className="inline-flex items-center gap-1.5">
              <GitBranch aria-hidden className="size-3.5 text-text-muted" />
              Versioned
            </span>
          }
          description="Treat this database as a repository: show clean or changed on its card, and record a checkpoint after every sync that changes data."
          checked={versioned}
          disabled={!canWrite || mutation.isPending || loading}
          onCheckedChange={(next) =>
            mutation.mutate(
              { versioned: next },
              {
                onSuccess: () => toast.success(next ? "Versioning turned on" : "Versioning turned off"),
                onError: (e) => toast.error("Could not change versioning", { description: errorMessage(e) }),
              },
            )
          }
        />
      </div>
      <div className="min-w-0 px-5 py-4">
        <div className="flex items-center justify-between gap-2 text-label font-medium text-text-muted">
          <span>History storage</span>
          <HardDrive aria-hidden className="size-3.5 text-text-subtle" />
        </div>
        {loading ? (
          <div className="mt-2 space-y-1.5">
            <Skeleton className="h-6 w-28" />
            <Skeleton className="h-3 w-40" />
          </div>
        ) : !storage ? (
          <p className="mt-1.5 text-body text-text-subtle">Unavailable</p>
        ) : (
          <>
            <div className="mt-1 flex flex-wrap items-baseline gap-x-2">
              <span className="font-mono text-metric font-medium tracking-[-0.04em] text-text">{formatBytes(storage.storedBytes)}</span>
              <span className="text-label text-text-muted">on disk</span>
            </div>
            <StorageBar stored={storage.storedBytes} unshared={unshared} />
            <p className="mt-1.5 text-micro text-text-subtle">
              {storage.checkpoints === 0 ? (
                "No checkpoints stored yet"
              ) : (
                <>
                  {pluralize(storage.checkpoints, "checkpoint")} ·{" "}
                  <span className="font-mono text-text-muted">{formatBytes(storage.logicalBytes)}</span> of SQL, compressed
                  {saving !== null && saving > 0 && (
                    <>
                      {" "}
                      · sharing unchanged tables saves{" "}
                      <span className="text-text-muted">
                        {formatBytes(unshared - storage.storedBytes)} ({saving}%)
                      </span>
                    </>
                  )}
                </>
              )}
            </p>
          </>
        )}
      </div>
      <div className="min-w-0 px-5 py-4">
        <div className="flex items-center justify-between gap-2 text-label font-medium text-text-muted">
          <span>Automatic checkpoints</span>
          <CalendarClock aria-hidden className="size-3.5 text-text-subtle" />
        </div>
        {loading ? (
          <div className="mt-2 space-y-1.5">
            <Skeleton className="h-5 w-32" />
            <Skeleton className="h-3 w-44" />
          </div>
        ) : !policy ? (
          <p className="mt-1.5 text-body text-text-subtle">Unavailable</p>
        ) : (
          <div className="mt-1.5 flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
            <div className="min-w-0">
              <div className="text-body font-medium text-text">{policySummary(policy, db.kind === "mirror")}</div>
              <p className="text-micro text-text-subtle">Manual, pinned and HEAD checkpoints are always kept</p>
            </div>
            <PolicyPopover db={db} policy={policy} canWrite={canWrite} />
          </div>
        )}
      </div>
    </Card>
  );
}

function StorageBar({ stored, unshared }: { stored: number; unshared: number }) {
  const ratio = unshared > 0 ? Math.min(1, stored / unshared) : 0;
  const label =
    unshared > 0
      ? `${formatBytes(stored)} on disk; ${formatBytes(unshared)} if every checkpoint stored all of its tables`
      : "Nothing stored yet";
  return (
    <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-bg-hover" role="img" aria-label={label} title={label}>
      <div className="h-full rounded-full bg-accent" style={{ width: `${unshared > 0 ? Math.max(2, ratio * 100) : 0}%` }} />
    </div>
  );
}

function PolicyPopover({ db, policy, canWrite }: { db: Database; policy: CheckpointPolicy; canWrite: boolean }) {
  const [open, setOpen] = useState(false);
  const [intervalHours, setIntervalHours] = useState(String(policy.autoIntervalHours));
  const [retention, setRetention] = useState(String(policy.autoRetention));
  const [onSync, setOnSync] = useState(policy.checkpointOnSync);
  const mutation = usePolicyMutation(db);

  useEffect(() => {
    if (!open) return;
    setIntervalHours(String(policy.autoIntervalHours));
    setRetention(String(policy.autoRetention));
    setOnSync(policy.checkpointOnSync);
    mutation.reset();
  }, [open]);

  const limits = useAppSettings().data?.limits;
  const minHours = limits?.checkpointMinIntervalHours ?? 1;
  const maxKeep = limits?.checkpointMaxAutoRetention ?? 1000;
  const allowed = INTERVALS.filter((i) => i.value === 0 || i.value >= minHours);
  const options = allowed.some((i) => i.value === policy.autoIntervalHours)
    ? allowed
    : [...allowed, { value: policy.autoIntervalHours, label: intervalLabel(policy.autoIntervalHours) }];
  const keep = Number(retention);
  const keepInvalid = !Number.isInteger(keep) || keep < 1 || keep > maxKeep;
  const dirty =
    Number(intervalHours) !== policy.autoIntervalHours || keep !== policy.autoRetention || onSync !== policy.checkpointOnSync;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="secondary" size="xs">
          <Settings2 />
          {canWrite ? "Change" : "Details"}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 p-0">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (!canWrite || keepInvalid || !dirty) return;
            mutation.mutate(
              { autoIntervalHours: Number(intervalHours), autoRetention: keep, checkpointOnSync: onSync },
              {
                onSuccess: () => {
                  toast.success("History policy saved");
                  setOpen(false);
                },
              },
            );
          }}
        >
          <div className="border-b border-border px-4 py-3">
            <div className="text-body font-medium text-text">History policy</div>
            <p className="text-label text-text-muted">How LambData records checkpoints for {db.displayName} on its own.</p>
          </div>
          <fieldset disabled={!canWrite || mutation.isPending} className="space-y-4 px-4 py-4">
            <Field
              label="Automatic checkpoint"
              hint={
                minHours > 1
                  ? `Skipped when nothing changed since the last one. This server allows at most one every ${pluralize(minHours, "hour")}.`
                  : "Skipped when nothing changed since the last one."
              }
            >
              <SelectMenu
                size="sm"
                value={intervalHours}
                onValueChange={setIntervalHours}
                disabled={!canWrite}
                options={options.map((o) => ({ value: String(o.value), label: o.label }))}
              />
            </Field>
            <Field
              label="Automatic checkpoints to keep"
              hint="Older automatic, sync and safety checkpoints are removed. Manual and pinned ones stay."
              error={keepInvalid ? `Enter a whole number from 1 to ${maxKeep}` : undefined}
            >
              <Input
                inputSize="sm"
                type="number"
                inputMode="numeric"
                min={1}
                max={maxKeep}
                value={retention}
                onChange={(e) => setRetention(e.target.value)}
                mono
              />
            </Field>
            {db.kind === "mirror" && (
              <Switch
                size="sm"
                label="Checkpoint after each sync"
                description={
                  policy.versioned
                    ? "Records the mirror's state after every sync that changed data."
                    : "Takes effect once the database is versioned."
                }
                checked={onSync}
                onCheckedChange={setOnSync}
                disabled={!canWrite}
              />
            )}
            {mutation.isError && <p className="text-label text-danger">{errorMessage(mutation.error)}</p>}
          </fieldset>
          <div className={cn("flex items-center justify-end gap-2 border-t border-border px-4 py-3", !canWrite && "justify-between")}>
            {!canWrite && <span className="text-micro text-text-subtle">Read-only for your role</span>}
            <Button variant="ghost" size="sm" onClick={() => setOpen(false)}>
              {canWrite ? "Cancel" : "Close"}
            </Button>
            {canWrite && (
              <Button type="submit" size="sm" loading={mutation.isPending} disabled={keepInvalid || !dirty}>
                Save
              </Button>
            )}
          </div>
        </form>
      </PopoverContent>
    </Popover>
  );
}
