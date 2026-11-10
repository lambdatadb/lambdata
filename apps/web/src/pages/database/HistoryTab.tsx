import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { ChevronDown, GitBranch, GitCommitHorizontal } from "lucide-react";
import type { Checkpoint, CheckpointCreateJobResult, CheckpointListResponse, Job } from "@lambdata/shared";
import { QueryError } from "../../components/layout/QueryError";
import { Button } from "../../components/ui/Button";
import { Card } from "../../components/ui/Card";
import { EmptyState } from "../../components/ui/EmptyState";
import { Skeleton } from "../../components/ui/Skeleton";
import { toast } from "../../components/ui/Toast";
import { CheckpointDrawer } from "../../components/checkpoints/CheckpointDrawer";
import { CheckpointRow, type CheckpointActions } from "../../components/checkpoints/CheckpointRow";
import { CreateCheckpointDialog } from "../../components/checkpoints/CreateCheckpointDialog";
import { DeleteCheckpointDialog, EditMessageDialog, useUpdateCheckpoint } from "../../components/checkpoints/EditDialogs";
import { bottomLanes, layoutGraph } from "../../components/checkpoints/graph";
import { ContinuationCell, graphColumnWidth } from "../../components/checkpoints/GraphCell";
import { HistoryHeader } from "../../components/checkpoints/HistoryHeader";
import { OperationPanel } from "../../components/checkpoints/OperationPanel";
import {
  checkpointKeys,
  historyPermissions,
  refreshWorkingCopyStatus,
  useCheckpointList,
  useWorkingCopyStatus,
} from "../../components/checkpoints/queries";
import { RollbackDialog } from "../../components/checkpoints/RollbackDialog";
import { SetAsideCard } from "../../components/checkpoints/SetAsideCard";
import { useSetAside } from "../../components/checkpoints/setAside";
import { UnconvertedSnapshots } from "../../components/checkpoints/UnconvertedSnapshots";
import { useHistoryJobs, type TrackedJobMeta } from "../../components/checkpoints/useHistoryJobs";
import { WorkingCopyRow, workingTone } from "../../components/checkpoints/WorkingCopyRow";
import { errorMessage } from "../../lib/api";
import { useAuth } from "../../lib/auth";
import { databasePath } from "../../lib/commands";
import { pluralize } from "../../lib/format";
import { jobKindNoun } from "../../lib/jobs";
import { createLimitations, createVerified } from "../../lib/jobOutcome";
import type { DatabaseTabProps } from "./types";

const WORKING = "__working__";
const PAGE = 40;

function useNarrow(query = "(max-width: 639px)") {
  const get = () => (typeof window !== "undefined" && window.matchMedia ? window.matchMedia(query).matches : false);
  const [narrow, setNarrow] = useState(get);
  useEffect(() => {
    const mql = window.matchMedia(query);
    const onChange = () => setNarrow(mql.matches);
    onChange();
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, [query]);
  return narrow;
}

function activeLabelFor(job: Job | null): string | null {
  if (!job) return null;
  switch (job.kind) {
    case "checkpoint.create":
      return "creating checkpoint";
    case "checkpoint.restore":
      return "rolling back";
    case "sync.run":
      return "syncing";
    default:
      return "importing";
  }
}

export function HistoryTab({ db, subpath }: DatabaseTabProps) {
  const { user } = useAuth();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const permissions = historyPermissions(user, db);
  const list = useCheckpointList(db.id);
  const status = useWorkingCopyStatus(db.id);
  const setAside = useSetAside(db.id);
  const update = useUpdateCheckpoint(db);
  const narrow = useNarrow();
  const [checking, setChecking] = useState(false);
  const [restoreTarget, setRestoreTarget] = useState<Checkpoint | null>(null);
  const [editTarget, setEditTarget] = useState<Checkpoint | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Checkpoint | null>(null);
  const [limit, setLimit] = useState(PAGE);

  const checkpoints = list.data?.checkpoints ?? [];
  const byId = useMemo(() => new Map(checkpoints.map((cp) => [cp.id, cp])), [checkpoints]);
  const base = checkpoints.find((cp) => cp.isBase) ?? null;

  const onFinished = useCallback(
    async (job: Job, meta: TrackedJobMeta, shownInPanel: boolean) => {
      if (job.kind !== "checkpoint.create" || job.status !== "succeeded" || shownInPanel) return;
      const result = job.result as unknown as CheckpointCreateJobResult | null;
      if (!result || result.unchanged || !result.checkpointId) {
        toast.info(meta.previousBaseShort ? `Nothing has changed since ${meta.previousBaseShort}` : "Nothing has changed", {
          description: "The live data is identical to HEAD, so no checkpoint was recorded.",
        });
        return;
      }
      await qc.refetchQueries({ queryKey: checkpointKeys.list(db.id) });
      const fresh = qc.getQueryData<CheckpointListResponse>(checkpointKeys.list(db.id));
      const created = fresh?.checkpoints.find((cp) => cp.id === result.checkpointId);
      const name = created ? `Checkpoint ${created.shortHash}` : "Checkpoint";
      const verified = createVerified(job);
      const limitations = createLimitations(job);
      if (limitations.length > 0) {
        toast.warning(`${name} created with ${limitations.length === 1 ? "a limitation" : `${limitations.length} limitations`}`, {
          description: limitations.join(" · "),
        });
        return;
      }
      toast.success(`${name} ${verified ? "created and verified" : "created"}`, {
        description: verified ? `${created ? `“${created.message}”. ` : ""}It was loaded into a scratch copy once and can be rolled back to.` : created?.message,
      });
    },
    [qc, db.id],
  );

  const jobs = useHistoryJobs(db.id, onFinished);
  const busyReason = jobs.busy && jobs.activeJob ? `Wait for the ${jobKindNoun(jobs.activeJob.kind)} to finish` : jobs.busy ? "Another operation is running" : null;

  const layout = useMemo(
    () =>
      layoutGraph(
        [{ id: WORKING, parentId: base?.id ?? null }, ...checkpoints.map((cp) => ({ id: cp.id, parentId: cp.parentId }))],
        { workingId: WORKING },
      ),
    [checkpoints, base?.id],
  );
  const visibleRows = layout.rows.slice(0, limit + 1);
  const hidden = layout.rows.length - visibleRows.length;
  const lastVisible = visibleRows[visibleRows.length - 1];
  const continuation = hidden > 0 && lastVisible ? bottomLanes(lastVisible) : [];
  const laneCount = Math.max(1, ...visibleRows.map((r) => r.width));
  const laneWidth = narrow ? (laneCount > 4 ? 10 : 13) : laneCount > 6 ? 12 : 16;
  const graphWidth = graphColumnWidth(laneCount, laneWidth);
  const tips = useMemo(() => {
    const parents = new Set(checkpoints.map((cp) => cp.parentId).filter(Boolean));
    return checkpoints.filter((cp) => !parents.has(cp.id)).length;
  }, [checkpoints]);

  const head = subpath.split("/")[0] ?? "";
  const createOpen = head === "new";
  const selectedId = head && head !== "new" ? decodeURIComponent(head) : null;
  const historyPath = databasePath(db.id, "history");

  const actions: CheckpointActions = {
    open: (cp) => navigate(databasePath(db.id, "history", encodeURIComponent(cp.id))),
    restore: (cp) => setRestoreTarget(cp),
    edit: (cp) => setEditTarget(cp),
    remove: (cp) => setDeleteTarget(cp),
    togglePin: (cp) =>
      update.mutate(
        { cp, body: { pinned: !cp.pinned } },
        {
          onSuccess: () => toast.success(cp.pinned ? `Unpinned ${cp.shortHash}` : `Pinned ${cp.shortHash}`, {
            description: cp.pinned ? undefined : "Retention will never remove it.",
          }),
          onError: (e) => toast.error("Could not update the checkpoint", { description: errorMessage(e) }),
        },
      ),
  };

  const checkNow = async () => {
    setChecking(true);
    try {
      await refreshWorkingCopyStatus(qc, db.id);
    } catch (e) {
      toast.error("Could not compare with HEAD", { description: errorMessage(e) });
    } finally {
      setChecking(false);
    }
  };

  const openCreate = permissions.canWrite ? () => navigate(databasePath(db.id, "history", "new")) : null;
  const createDisabled = busyReason;

  return (
    <div className="space-y-4">
      <HistoryHeader db={db} data={list.data} loading={list.isPending && !list.isError} canWrite={permissions.canWrite} />

      {jobs.panelJob && (
        <OperationPanel
          key={jobs.panelJob.id}
          job={jobs.panelJob}
          meta={jobs.panelMeta}
          byId={byId}
          db={db}
          canRestore={permissions.canRestore}
          busyReason={busyReason}
          onForced={(job, cp) => {
            if (jobs.panelJob) jobs.dismiss(jobs.panelJob.id);
            jobs.start(job, { targetId: cp.id, targetShort: cp.shortHash, previousBaseShort: base?.shortHash ?? null, forced: true });
          }}
          onDismiss={() => jobs.panelJob && jobs.dismiss(jobs.panelJob.id)}
        />
      )}

      {setAside.data && setAside.data.length > 0 && (
        <SetAsideCard db={db} schemas={setAside.data} canAct={permissions.canWrite} busyReason={busyReason} />
      )}

      {list.isError ? (
        <QueryError error={list.error} title="Could not load the history" onRetry={list.refetch} retrying={list.isFetching} />
      ) : list.isPending ? (
        <GraphSkeleton />
      ) : (
        <Card flush aria-label="Checkpoint history">
          <div className="flex min-w-0 flex-wrap items-center justify-between gap-x-4 gap-y-1 border-b border-border px-4 py-2.5 text-label text-text-muted sm:px-5">
            <div className="flex min-w-0 items-center gap-2">
              <GitBranch aria-hidden className="size-3.5 shrink-0 text-text-subtle" />
              <span className="truncate font-mono text-code text-text">{db.name}</span>
              {base && (
                <>
                  <span aria-hidden className="text-text-subtle">·</span>
                  <span className="shrink-0">
                    HEAD <span className="font-mono text-code text-text">{base.shortHash}</span>
                  </span>
                </>
              )}
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <span>{pluralize(checkpoints.length, "checkpoint")}</span>
              {tips > 1 && (
                <>
                  <span aria-hidden className="text-text-subtle">·</span>
                  <span>{pluralize(tips, "branch", "branches")}</span>
                </>
              )}
            </div>
          </div>
          <ol className="min-w-0 pl-1 sm:pl-2" aria-label="Working copy and checkpoints, newest first">
            {visibleRows.map((row) => {
              if (row.id === WORKING) {
                return (
                  <WorkingCopyRow
                    key={WORKING}
                    row={row}
                    laneWidth={laneWidth}
                    graphWidth={graphWidth}
                    status={status.data}
                    statusLoading={status.isPending && status.fetchStatus !== "idle"}
                    statusError={status.isError ? status.error : null}
                    base={base}
                    activeJob={jobs.busy ? jobs.activeJob : null}
                    activeLabel={jobs.busy ? activeLabelFor(jobs.activeJob) : null}
                    checking={checking}
                    onCheck={checkNow}
                    onCreate={checkpoints.length > 0 ? openCreate : null}
                    createDisabled={createDisabled}
                  />
                );
              }
              const cp = byId.get(row.id);
              if (!cp) return null;
              return (
                <CheckpointRow
                  key={cp.id}
                  cp={cp}
                  row={row}
                  laneWidth={laneWidth}
                  graphWidth={graphWidth}
                  selected={selectedId === cp.id}
                  restoring={jobs.busy && jobs.activeJob?.kind === "checkpoint.restore" && jobs.trackedMeta?.targetId === cp.id}
                  permissions={permissions}
                  busyReason={busyReason}
                  workingState={status.data?.state ?? null}
                  workingTone={workingTone(status.data)}
                  actions={actions}
                />
              );
            })}
            {hidden > 0 && (
              <li className="relative flex min-w-0">
                <div className="relative shrink-0" style={{ width: graphWidth }}>
                  <ContinuationCell lanes={continuation} laneWidth={laneWidth} width={graphWidth} />
                </div>
                <div className="flex min-w-0 flex-1 items-center py-2.5 pl-1">
                  <Button variant="ghost" size="sm" onClick={() => setLimit((n) => n + PAGE)}>
                    <ChevronDown />
                    Show {Math.min(PAGE, hidden)} older {hidden === 1 ? "checkpoint" : "checkpoints"}
                    <span className="text-text-subtle">of {hidden}</span>
                  </Button>
                </div>
              </li>
            )}
          </ol>
          {checkpoints.length === 0 && (
            <EmptyState
              variant="bare"
              size="sm"
              icon={GitCommitHorizontal}
              className="border-t border-border"
              title="No checkpoints yet"
              description={
                <>
                  A checkpoint seals every table, view and routine as a commit you can roll back to or download.
                  {list.data && list.data.policy.autoIntervalHours > 0
                    ? " An automatic one is also taken on schedule."
                    : " Automatic checkpoints are off for this database."}
                </>
              }
              action={
                openCreate ? (
                  <Button onClick={openCreate} disabled={!!createDisabled}>
                    <GitCommitHorizontal />
                    Create the first checkpoint
                  </Button>
                ) : undefined
              }
            />
          )}
        </Card>
      )}

      {list.data?.unconverted && list.data.unconverted.length > 0 && <UnconvertedSnapshots items={list.data.unconverted} />}

      <CreateCheckpointDialog
        open={createOpen && permissions.canWrite}
        db={db}
        status={status.data}
        baseShort={base?.shortHash ?? null}
        onClose={() => navigate(historyPath)}
        onStarted={(job) => jobs.start(job, { previousBaseShort: base?.shortHash ?? null })}
      />
      <RollbackDialog
        db={db}
        target={restoreTarget}
        base={base}
        status={status.data}
        onClose={() => setRestoreTarget(null)}
        onStarted={(job, cp) => {
          jobs.start(job, { targetId: cp.id, targetShort: cp.shortHash, previousBaseShort: base?.shortHash ?? null });
          if (selectedId) navigate(historyPath);
        }}
      />
      <EditMessageDialog db={db} target={editTarget} onClose={() => setEditTarget(null)} />
      <DeleteCheckpointDialog
        db={db}
        target={deleteTarget}
        parent={deleteTarget?.parentId ? byId.get(deleteTarget.parentId) ?? null : null}
        onClose={() => setDeleteTarget(null)}
        onDeleted={(cp) => {
          if (selectedId === cp.id) navigate(historyPath);
        }}
      />
      <CheckpointDrawer
        databaseId={db.id}
        checkpointId={selectedId}
        fallback={selectedId ? byId.get(selectedId) ?? null : null}
        byId={byId}
        permissions={permissions}
        busyReason={busyReason}
        workingState={status.data?.state ?? null}
        onClose={() => navigate(historyPath)}
        onOpen={actions.open}
        onRestore={(cp) => setRestoreTarget(cp)}
      />
    </div>
  );
}

function GraphSkeleton() {
  return (
    <Card flush role="status" aria-label="Loading history">
      <div className="border-b border-border px-5 py-3">
        <Skeleton className="h-3.5 w-48" />
      </div>
      <div className="relative">
        <div aria-hidden className="absolute bottom-6 left-[22px] top-6 w-0.5 rounded-full bg-bg-hover" />
        {Array.from({ length: 5 }, (_, i) => (
          <div key={i} className="flex items-start gap-4 py-3 pl-4 pr-5">
            <div aria-hidden className="relative z-10 mt-1.5 size-3 shrink-0 rounded-full border-2 border-bg-hover bg-bg-panel" />
            <div className="min-w-0 flex-1 space-y-2">
              <Skeleton className={i % 2 ? "h-3.5 w-56" : "h-3.5 w-72 max-w-full"} />
              <Skeleton className="h-3 w-40" />
            </div>
            <Skeleton className="hidden h-3.5 w-14 sm:block" />
          </div>
        ))}
      </div>
    </Card>
  );
}
