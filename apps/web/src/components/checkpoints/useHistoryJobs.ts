import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { Job } from "@lambdata/shared";
import { isJobActive, useActiveJobs, useJob, useTrackJob } from "../../lib/jobs";
import { jobState, needsAttention } from "../../lib/jobOutcome";
import { invalidateHistory, useDatabaseJobs } from "./queries";

export const REVEAL_AFTER_MS = 1_200;
export const HOLD_SUCCESS_MS = 2_400;
const FAILURE_WINDOW_MS = 24 * 60 * 60 * 1000;

export interface TrackedJobMeta {
  targetId?: string;
  targetShort?: string;
  previousBaseShort?: string | null;
  forced?: boolean;
}

interface Tracked {
  job: Job;
  meta: TrackedJobMeta;
}

const dismissed = new Set<string>();

function isProblem(job: Job): boolean {
  const state = jobState(job);
  return state === "failed" || state === "refused" || state === "done-with-errors";
}

export function pickRecentProblem(jobs: Job[], now: number): Job | null {
  const at = (j: Job) => j.finishedAt ?? j.createdAt;
  const done = jobs.filter((j) => !isJobActive(j)).sort((a, b) => at(b) - at(a));
  const problem = done.find(isProblem);
  if (!problem) return null;
  if (now - at(problem) > FAILURE_WINDOW_MS) return null;
  const resolved = done.some((j) => j.kind === problem.kind && jobState(j) === "succeeded" && at(j) > at(problem));
  return resolved ? null : problem;
}

export function useHistoryJobs(
  databaseId: string,
  onFinished: (job: Job, meta: TrackedJobMeta, shownInPanel: boolean) => void,
) {
  const qc = useQueryClient();
  const track = useTrackJob();
  const active = useActiveJobs(databaseId);
  const [tracked, setTracked] = useState<Tracked | null>(null);
  const live = useJob(tracked?.job.id ?? null, { initialJob: tracked?.job ?? null });
  const trackedJob = tracked ? (live.job?.id === tracked.job.id ? live.job : tracked.job) : null;
  const trackedActive = !!trackedJob && isJobActive(trackedJob);
  const recent = useDatabaseJobs(databaseId, active.hasActive || trackedActive);
  const [revealedId, setRevealedId] = useState<string | null>(null);
  const [, bump] = useState(0);
  const finished = useRef<Set<string>>(new Set());
  const activeIds = useRef<string[]>([]);
  const onFinishedRef = useRef(onFinished);
  onFinishedRef.current = onFinished;

  const start = useCallback(
    (job: Job, meta: TrackedJobMeta = {}) => {
      track(job);
      setTracked({ job, meta });
    },
    [track],
  );

  const otherActive = active.jobs.find((j) => j.id !== tracked?.job.id && isJobActive(j)) ?? null;
  const candidate = trackedActive ? trackedJob : otherActive;
  const busy = active.hasActive || trackedActive;

  const findJob = useCallback(
    (id: string): Job | null => {
      if (trackedJob?.id === id) return trackedJob;
      return active.jobs.find((j) => j.id === id) ?? recent.data?.find((j) => j.id === id) ?? null;
    },
    [trackedJob, active.jobs, recent.data],
  );

  useEffect(() => {
    if (!candidate || revealedId === candidate.id) return;
    const begun = candidate.startedAt ?? candidate.createdAt;
    const wait = Math.min(REVEAL_AFTER_MS, Math.max(0, REVEAL_AFTER_MS - (Date.now() - begun)));
    const timer = setTimeout(() => setRevealedId(candidate.id), wait);
    return () => clearTimeout(timer);
  }, [candidate, revealedId]);

  useEffect(() => {
    if (!trackedJob || isJobActive(trackedJob) || finished.current.has(trackedJob.id)) return;
    finished.current.add(trackedJob.id);
    void invalidateHistory(qc, databaseId);
    const wasShown = revealedId === trackedJob.id;
    const state = jobState(trackedJob);
    if (state === "failed" || state === "refused" || state === "done-with-errors" || trackedJob.kind === "checkpoint.restore") {
      setRevealedId(trackedJob.id);
    }
    onFinishedRef.current(trackedJob, tracked?.meta ?? {}, wasShown);
  }, [trackedJob, tracked, qc, databaseId, revealedId]);

  useEffect(() => {
    const ids = active.jobs.map((j) => j.id);
    const gone = activeIds.current.filter((id) => !ids.includes(id));
    activeIds.current = ids;
    if (gone.length > 0) void invalidateHistory(qc, databaseId);
  }, [active.jobs, qc, databaseId]);

  const revealed = revealedId && !dismissed.has(revealedId) ? findJob(revealedId) : null;
  const keepsUntilDismissed =
    !!revealed && (needsAttention(revealed) || (revealed.kind === "checkpoint.restore" && revealed.id === tracked?.job.id));

  const revealedKey = revealed && !isJobActive(revealed) && !keepsUntilDismissed ? revealed.id : null;

  useEffect(() => {
    if (!revealedKey) return;
    const timer = setTimeout(() => {
      dismissed.add(revealedKey);
      bump((n) => n + 1);
    }, HOLD_SUCCESS_MS);
    return () => clearTimeout(timer);
  }, [revealedKey]);

  const recentProblem = useMemo(() => pickRecentProblem(recent.data ?? [], Date.now()), [recent.data]);

  let panelJob: Job | null = revealed;
  if (!panelJob && !busy && recentProblem && !dismissed.has(recentProblem.id)) panelJob = recentProblem;
  if (panelJob && dismissed.has(panelJob.id)) panelJob = null;

  const dismiss = useCallback((id: string) => {
    dismissed.add(id);
    bump((n) => n + 1);
  }, []);

  return {
    start,
    busy,
    activeJob: candidate,
    trackedJob,
    trackedMeta: tracked?.meta ?? null,
    panelJob,
    panelMeta: panelJob && tracked && panelJob.id === tracked.job.id ? tracked.meta : null,
    dismiss,
  };
}
