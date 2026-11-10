import { Link } from "react-router-dom";
import { useQueries } from "@tanstack/react-query";
import type { CheckpointListResponse, Database } from "@lambdata/shared";
import { Alert } from "../../components/ui/Alert";
import { checkpointKeys, checkpointPath } from "../../components/checkpoints/queries";
import { api } from "../../lib/api";
import { databasePath } from "../../lib/commands";
import { pluralize } from "../../lib/format";
import { useDatabases, useHealth } from "../../lib/queries";

const MAX_LOOKUPS = 50;

export function useUnconvertedDatabases(enabled: boolean): { databases: { db: Database; count: number }[]; checked: boolean } {
  const list = useDatabases({ enabled });
  const candidates = enabled ? (list.data ?? []).slice(0, MAX_LOOKUPS) : [];
  const results = useQueries({
    queries: candidates.map((db) => ({
      queryKey: checkpointKeys.list(db.id),
      queryFn: () => api.get<CheckpointListResponse>(checkpointPath(db.id)),
      staleTime: 60_000,
    })),
  });
  const databases = candidates
    .map((db, i) => ({ db, count: results[i]?.data?.unconverted?.length ?? 0 }))
    .filter((entry) => entry.count > 0);
  const checked = enabled && !!list.data && results.every((r) => !r.isPending);
  return { databases, checked };
}

export function UnconvertedBanner() {
  const health = useHealth();
  const detail = health.data?.checkpoints;
  const count = detail?.unconvertedSnapshots ?? 0;
  const { databases, checked } = useUnconvertedDatabases(count > 0);
  if (count === 0) return null;
  return (
    <Alert
      variant="warning"
      title={count === 1 ? "1 old snapshot could not be converted into a checkpoint" : `${count} old snapshots could not be converted into checkpoints`}
      data-unconverted={count}
    >
      <div className="space-y-1.5">
        <p>
          {count === 1 ? "It is" : "They are"} not part of any history and cannot be rolled back to from the console. LambData tries again
          every time it starts, and the original {count === 1 ? "file stays" : "files stay"} untouched on disk.
        </p>
        {databases.length > 0 ? (
          <p className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span>See why in History:</span>
            {databases.map(({ db, count: n }, i) => (
              <span key={db.id}>
                <Link to={databasePath(db.id, "history")} className="font-medium">
                  {db.displayName}
                </Link>
                <span className="text-text-subtle"> ({pluralize(n, "snapshot")})</span>
                {i < databases.length - 1 && <span aria-hidden>,</span>}
              </span>
            ))}
          </p>
        ) : checked && detail?.lastConversionError ? (
          <p className="break-words">
            Last error: <span className="font-mono text-code">{detail.lastConversionError}</span>
          </p>
        ) : null}
      </div>
    </Alert>
  );
}
