import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Trash2 } from "lucide-react";
import { JobConflictNotice } from "../../components/jobs/JobConflictNotice";
import { Alert } from "../../components/ui/Alert";
import { Button } from "../../components/ui/Button";
import { Card, CardContent, CardHeader } from "../../components/ui/Card";
import { ConfirmDialog } from "../../components/ui/ConfirmDialog";
import { toast } from "../../components/ui/Toast";
import { api, errorMessage } from "../../lib/api";
import { isJobConflict } from "../../lib/jobs";
import { queryKeys } from "../../lib/queries";
import { useTerminology } from "../../lib/terminology";
import type { DatabaseTabProps } from "./types";

export function DangerTab({ db }: DatabaseTabProps) {
  const t = useTerminology();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [confirmOpen, setConfirmOpen] = useState(false);

  const remove = useMutation({
    mutationFn: () => api.delete(`/databases/${db.id}`),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: queryKeys.databases });
      void qc.invalidateQueries({ queryKey: ["dashboard"] });
    },
  });

  const conflict = isJobConflict(remove.error);

  return (
    <div className="space-y-4">
      {conflict && <JobConflictNotice error={remove.error} onCleared={() => remove.reset()} />}
      {remove.isError && !conflict && (
        <Alert variant="danger" title="The database was not deleted">
          {errorMessage(remove.error)}
        </Alert>
      )}
      <Card flush className="border-danger/40">
        <CardHeader divided title={t("danger")} description="Irreversible actions for this database." />
        <CardContent className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0 space-y-1">
            <p className="text-body font-medium text-text">Delete this database</p>
            <p className="text-body text-text-muted">
              Drops the <span className="font-mono text-code text-text">{db.name}</span> schema, its MariaDB user{" "}
              <span className="font-mono text-code text-text">{db.mysqlUser}</span> and every checkpoint. Connected clients are cut off.
            </p>
          </div>
          <Button variant="danger" className="shrink-0" onClick={() => setConfirmOpen(true)}>
            <Trash2 /> Delete database
          </Button>
        </CardContent>
      </Card>
      <ConfirmDialog
        open={confirmOpen}
        onClose={() => setConfirmOpen(false)}
        onConfirm={() =>
          remove.mutate(undefined, {
            onSuccess: () => {
              setConfirmOpen(false);
              toast.success(`${db.displayName} deleted`);
              navigate("/databases", { replace: true });
            },
            onError: () => setConfirmOpen(false),
          })
        }
        title={`Delete ${db.displayName}?`}
        body="The schema, its user and all checkpoints are removed. This cannot be undone."
        confirmLabel="Delete database"
        tone="danger"
        loading={remove.isPending}
        challenge={db.name}
      />
    </div>
  );
}
