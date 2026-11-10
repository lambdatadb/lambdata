import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { SettingsLimits } from "@lambdata/shared";
import { Button, Card, CardContent, CardFooter, DescriptionItem, DescriptionList, Field, FieldGroup, Input, Skeleton, useToast } from "../ui";
import { api, errorMessage } from "../../lib/api";
import { formatBytes, pluralize } from "../../lib/format";
import { queryKeys } from "../../lib/queries";

const MAX_RETENTION = 1000;
const MAX_INTERVAL = 8760;

function wholeNumber(value: string, max: number): number | null {
  const n = Number(value);
  return Number.isInteger(n) && n >= 1 && n <= max ? n : null;
}

export function CheckpointLimitsCard({ limits, isAdmin }: { limits: SettingsLimits | undefined; isAdmin: boolean }) {
  if (!limits) {
    return (
      <Card>
        <div className="space-y-3" role="status" aria-label="Loading limits">
          <Skeleton className="h-4 w-48" />
          <Skeleton className="h-4 w-64" />
        </div>
      </Card>
    );
  }
  return <LimitsForm key={`${limits.checkpointMaxAutoRetention}:${limits.checkpointMinIntervalHours}`} limits={limits} isAdmin={isAdmin} />;
}

function LimitsForm({ limits, isAdmin }: { limits: SettingsLimits; isAdmin: boolean }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [retention, setRetention] = useState(String(limits.checkpointMaxAutoRetention));
  const [intervalHours, setIntervalHours] = useState(String(limits.checkpointMinIntervalHours));
  const keep = wholeNumber(retention, MAX_RETENTION);
  const hours = wholeNumber(intervalHours, MAX_INTERVAL);
  const dirty = keep !== limits.checkpointMaxAutoRetention || hours !== limits.checkpointMinIntervalHours;

  const save = useMutation({
    mutationFn: () => api.patch("/settings", { checkpointMaxAutoRetention: keep, checkpointMinIntervalHours: hours }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: queryKeys.settings });
      void qc.invalidateQueries({ queryKey: ["checkpoints"] });
      toast.success("Checkpoint limits saved");
    },
    onError: (e) => toast.error(errorMessage(e, "Could not save the limits")),
  });

  return (
    <Card flush>
      <CardContent className="space-y-5">
        {isAdmin ? (
          <FieldGroup>
            <Field
              label="Most automatic checkpoints kept per database"
              hint="Database owners can set their policies to keep up to this many. Admins are not limited by it."
              error={keep === null ? `Enter a whole number from 1 to ${MAX_RETENTION}.` : undefined}
            >
              <Input mono type="number" inputMode="numeric" min={1} max={MAX_RETENTION} value={retention} onChange={(e) => setRetention(e.target.value)} />
            </Field>
            <Field
              label="Shortest interval between automatic checkpoints (hours)"
              hint="Database owners cannot schedule automatic checkpoints more often than this. Admins are not limited by it."
              error={hours === null ? `Enter a whole number from 1 to ${MAX_INTERVAL}.` : undefined}
            >
              <Input mono type="number" inputMode="numeric" min={1} max={MAX_INTERVAL} value={intervalHours} onChange={(e) => setIntervalHours(e.target.value)} />
            </Field>
          </FieldGroup>
        ) : (
          <DescriptionList>
            <DescriptionItem term="Automatic checkpoints kept, at most">{limits.checkpointMaxAutoRetention}</DescriptionItem>
            <DescriptionItem term="Automatic checkpoints, at most">
              one every {pluralize(limits.checkpointMinIntervalHours, "hour")}
            </DescriptionItem>
          </DescriptionList>
        )}
        <p className="text-label text-text-muted">
          LambData also stops taking checkpoints, imports and uploads when less than {formatBytes(limits.diskFloorBytes)} is free on
          the data directory.
        </p>
      </CardContent>
      {isAdmin && (
        <CardFooter>
          <Button size="sm" variant="secondary" disabled={!dirty || keep === null || hours === null} loading={save.isPending} onClick={() => save.mutate()}>
            Save limits
          </Button>
        </CardFooter>
      )}
    </Card>
  );
}
