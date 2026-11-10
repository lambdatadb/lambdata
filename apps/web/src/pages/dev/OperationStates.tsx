import { useMemo, type ReactNode } from "react";
import type { Checkpoint } from "@lambdata/shared";
import { CheckpointRow, type CheckpointActions } from "../../components/checkpoints/CheckpointRow";
import { graphColumnWidth } from "../../components/checkpoints/GraphCell";
import { layoutGraph } from "../../components/checkpoints/graph";
import { OperationPanel } from "../../components/checkpoints/OperationPanel";
import { UnconvertedSnapshots } from "../../components/checkpoints/UnconvertedSnapshots";
import { JobProgress } from "../../components/jobs/JobProgress";
import { Card } from "../../components/ui/Card";
import { toast } from "../../components/ui/Toast";
import { importOutcome, importSuccessText } from "../../components/import/result";
import {
  doneWithErrorsImport,
  doneWithErrorsRestore,
  doneWithErrorsSync,
  failedRestore,
  fixtureCheckpoints,
  fixtureDatabase,
  fixtureTarget,
  fixtureUnconverted,
  limitedCreate,
  refusedRestore,
  runningRestore,
  succeededRestore,
} from "./jobFixtures";

function Labelled({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0 space-y-2" data-kit-state={label}>
      <div className="font-mono text-micro text-text-subtle">{label}</div>
      {children}
    </div>
  );
}

const noop = () => undefined;

const rowActions: CheckpointActions = {
  open: noop,
  restore: noop,
  togglePin: noop,
  edit: noop,
  remove: noop,
};

export function OperationStates() {
  const byId = useMemo(() => new Map<string, Checkpoint>(fixtureCheckpoints.map((cp) => [cp.id, cp])), []);
  const layout = useMemo(() => layoutGraph(fixtureCheckpoints.map((cp) => ({ id: cp.id, parentId: cp.parentId }))), []);
  const laneWidth = 16;
  const graphWidth = graphColumnWidth(layout.laneCount, laneWidth);
  const meta = { targetId: fixtureTarget.id, targetShort: fixtureTarget.shortHash, previousBaseShort: "c90b5d4" };
  const permissions = { canWrite: true, canRestore: true };

  return (
    <div className="space-y-6" data-kit="operation-states">
      <div className="grid gap-4 xl:grid-cols-2">
        <Labelled label="refused · code objects · force offered">
          <OperationPanel
            job={refusedRestore}
            meta={meta}
            byId={byId}
            db={fixtureDatabase}
            canRestore
            onForced={() => toast.info("The forced rollback would start here")}
            onDismiss={noop}
          />
        </Labelled>
        <Labelled label="finished with errors · forced rollback">
          <OperationPanel job={doneWithErrorsRestore} meta={meta} byId={byId} db={fixtureDatabase} onDismiss={noop} />
        </Labelled>
        <Labelled label="failed · verification · no force">
          <OperationPanel job={failedRestore} meta={meta} byId={byId} db={fixtureDatabase} canRestore onForced={noop} onDismiss={noop} />
        </Labelled>
        <Labelled label="succeeded">
          <OperationPanel job={succeededRestore} meta={meta} byId={byId} onDismiss={noop} />
        </Labelled>
        <Labelled label="checkpoint · verified · limitations">
          <OperationPanel job={limitedCreate} meta={null} byId={byId} onDismiss={noop} />
        </Labelled>
        <Labelled label="sync · finished with errors">
          <OperationPanel job={doneWithErrorsSync} meta={null} byId={byId} onDismiss={noop} />
        </Labelled>
        <Labelled label="import · finished with errors">
          <JobProgress
            job={doneWithErrorsImport}
            title="Replacing the data from orders-2026-10.sql.gz"
            successMessage={importSuccessText(importOutcome(doneWithErrorsImport), "replace")}
          />
        </Labelled>
        <Labelled label="running">
          <OperationPanel job={runningRestore} meta={meta} byId={byId} onDismiss={noop} />
        </Labelled>
      </div>
      <Labelled label="compact · jobs list">
        <div className="max-w-sm divide-y divide-border rounded-lg border border-border bg-bg-panel">
          {[runningRestore, doneWithErrorsRestore, refusedRestore, failedRestore].map((job) => (
            <div key={job.id} className="px-4 py-3">
              <JobProgress job={job} variant="compact" />
            </div>
          ))}
        </div>
      </Labelled>
      <Labelled label="history rows · verified and limitations markers">
        <Card flush>
          <ol className="min-w-0 pl-1 sm:pl-2">
            {layout.rows.map((row) => {
              const cp = byId.get(row.id)!;
              return (
                <CheckpointRow
                  key={cp.id}
                  cp={cp}
                  row={row}
                  laneWidth={laneWidth}
                  graphWidth={graphWidth}
                  selected={false}
                  restoring={false}
                  permissions={permissions}
                  busyReason={null}
                  workingState="clean"
                  workingTone="clean"
                  actions={rowActions}
                />
              );
            })}
          </ol>
        </Card>
      </Labelled>
      <Labelled label="unconverted snapshots">
        <UnconvertedSnapshots items={fixtureUnconverted} />
      </Labelled>
    </div>
  );
}
