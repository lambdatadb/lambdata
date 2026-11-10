import { GitCommitHorizontal, HardDrive } from "lucide-react";
import type { DashboardSummary } from "@lambdata/shared";
import { StatTile } from "../../components/ui/StatTile";
import { formatBytes, formatRelativeTime, pluralize } from "../../lib/format";

export interface CheckpointTilesProps {
  summary: DashboardSummary | undefined;
  loading: boolean;
}

export function CheckpointTiles({ summary, loading }: CheckpointTilesProps) {
  const checkpoints = summary?.checkpoints ?? null;
  return (
    <>
      <StatTile
        label="Checkpoints (24h)"
        icon={GitCommitHorizontal}
        value={checkpoints?.last24hCount ?? null}
        loading={loading}
        hint={checkpoints?.lastAt ? `last ${formatRelativeTime(checkpoints.lastAt)}` : "none yet"}
      />
      <StatTile
        label="History storage"
        icon={HardDrive}
        value={checkpoints?.storedBytes ?? null}
        format={formatBytes}
        loading={loading}
        hint={
          checkpoints
            ? `${pluralize(checkpoints.total, "checkpoint")} · ${checkpoints.versionedDatabases} versioned`
            : "—"
        }
      />
    </>
  );
}
