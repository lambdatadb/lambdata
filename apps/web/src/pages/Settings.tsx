import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import type { AppSettings, DataDirMigrationResponse, ExperienceLevel, PathValidationResponse } from "@kilndb/shared";
import { api, ApiError } from "../lib/api";
import { useAuth } from "../lib/auth";
import { formatBytes } from "../lib/format";
import { PageHeader } from "../components/layout/PageShell";
import { Card, CardTitle } from "../components/ui/Card";
import { Button } from "../components/ui/Button";
import { Field, Input } from "../components/ui/Input";
import { Select } from "../components/ui/Select";
import { Switch } from "../components/ui/Switch";
import { Dialog } from "../components/ui/Dialog";
import { Icon } from "../components/ui/Icon";
import { useToast } from "../components/ui/Toast";
import { DataDirPicker } from "../components/storage/DataDirPicker";

export function Settings() {
  const { user, refetch } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const { data } = useQuery({
    queryKey: ["settings"],
    queryFn: () => api.get<AppSettings>("/settings"),
  });
  const [pw, setPw] = useState("");
  const [level, setLevel] = useState<ExperienceLevel>(user?.experienceLevel ?? "advanced");
  const [storageOpen, setStorageOpen] = useState(false);

  const updateMe = useMutation({
    mutationFn: (body: Record<string, unknown>) => api.patch(`/users/${user!.id}`, body),
    onSuccess: async () => {
      await refetch();
      qc.invalidateQueries();
      toast.show("Updated", "success");
    },
    onError: (e) => toast.show(e instanceof ApiError ? e.message : "update failed", "error"),
  });

  if (!user) return null;

  return (
    <>
      <PageHeader title="Settings" subtitle="Tune your profile and the look of KilnDB." />
      <div className="space-y-4">
        <Card>
          <CardTitle>Profile</CardTitle>
          <div className="grid grid-cols-2 gap-4 mt-2">
            <Field label="Email"><Input value={user.email} disabled /></Field>
            <Field label="Display name"><Input value={user.displayName ?? ""} disabled /></Field>
            <Field label="Role"><Input value={user.role} disabled /></Field>
            <Field label="Experience level">
              <Select value={level} onChange={(e) => setLevel(e.target.value as ExperienceLevel)}>
                <option value="advanced">Advanced</option>
                <option value="novice">Novice</option>
              </Select>
            </Field>
          </div>
          <div className="mt-3 flex justify-end">
            <Button
              size="sm"
              disabled={level === user.experienceLevel}
              loading={updateMe.isPending}
              onClick={() => updateMe.mutate({ experienceLevel: level })}
            >
              Save
            </Button>
          </div>
        </Card>

        <Card>
          <CardTitle>Change password</CardTitle>
          <div className="grid grid-cols-2 gap-4 mt-2">
            <Field label="New password" hint="At least 8 characters">
              <Input type="password" value={pw} onChange={(e) => setPw(e.target.value)} />
            </Field>
          </div>
          <div className="mt-3 flex justify-end">
            <Button
              size="sm"
              disabled={pw.length < 8}
              loading={updateMe.isPending}
              onClick={() => {
                updateMe.mutate({ password: pw });
                setPw("");
              }}
            >
              Update password
            </Button>
          </div>
        </Card>

        <Card>
          <CardTitle>Display</CardTitle>
          <div className="mt-3">
            <Switch
              checked={user.dataViewEnabled}
              onChange={(v) => updateMe.mutate({ dataViewEnabled: v })}
              label="Show vitals strip on database overview"
              description="A 24-hour size ribbon, writes/min heartbeat, and table/row/connection counts. Computed from periodic metadata polls — no row contents are read."
            />
          </div>
        </Card>

        <Card>
          <div className="flex items-start justify-between gap-3">
            <div>
              <CardTitle>Storage</CardTitle>
              <p className="mt-1 text-body text-text-muted">
                Where KilnDB keeps the MariaDB datadir, SQLite metadata, snapshots, and the master encryption key.
              </p>
            </div>
            {user.role === "admin" && (
              <Button size="sm" variant="secondary" onClick={() => setStorageOpen(true)}>
                <Icon name="folder_open" size={14} />
                Change…
              </Button>
            )}
          </div>
          <dl className="mt-3 grid grid-cols-[10rem_1fr] gap-y-1.5 text-body">
            <dt className="text-text-muted">Data directory</dt>
            <dd className="font-mono break-all">{data?.dataDir ?? "—"}</dd>
            <dt className="text-text-muted">Pointer config</dt>
            <dd className="font-mono text-label break-all text-text-muted">{data?.pointerPath ?? "—"}</dd>
            <dt className="text-text-muted">Free space</dt>
            <dd className="font-mono">{data?.dataDirFreeBytes != null ? formatBytes(data.dataDirFreeBytes) : "—"}</dd>
          </dl>
        </Card>

        <Card>
          <CardTitle>System</CardTitle>
          <dl className="grid grid-cols-2 gap-y-2 text-body">
            <dt className="text-text-muted">MariaDB port</dt>
            <dd className="font-mono">{data?.mariadbPort ?? "—"}</dd>
            <dt className="text-text-muted">Setup</dt>
            <dd>{data?.setupComplete ? "Complete" : "Incomplete"}</dd>
            <dt className="text-text-muted">Tailscale</dt>
            <dd>{data?.tailscaleEnabled ? "Enabled" : "Disabled"}</dd>
          </dl>
        </Card>
      </div>

      <StorageMigrationDialog
        open={storageOpen}
        onClose={() => setStorageOpen(false)}
        current={data?.dataDir ?? ""}
      />
    </>
  );
}

function StorageMigrationDialog({
  open,
  onClose,
  current,
}: {
  open: boolean;
  onClose: () => void;
  current: string;
}) {
  const toast = useToast();
  const qc = useQueryClient();
  const [path, setPath] = useState("");
  const [validation, setValidation] = useState<PathValidationResponse | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<DataDirMigrationResponse | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const reset = () => {
    setPath("");
    setValidation(null);
    setConfirming(false);
    setResult(null);
    setErr(null);
  };

  const close = () => {
    if (busy) return;
    reset();
    onClose();
  };

  const submit = async () => {
    setErr(null);
    setBusy(true);
    try {
      const r = await api.post<DataDirMigrationResponse>("/settings/data-dir", { path });
      setResult(r);
      await qc.invalidateQueries({ queryKey: ["settings"] });
      toast.show("Storage moved", "success");
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : "migration failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={close}
      size="lg"
      title="Move storage location"
      description="KilnDB will stop MariaDB, copy all data, verify, swap the pointer, and restart. Other operations will be paused for the duration."
    >
      {result ? (
        <div className="space-y-3">
          <p className="text-body text-success flex items-center gap-1.5">
            <Icon name="check_circle" size={14} />
            Migration complete.
          </p>
          <dl className="text-body grid grid-cols-[8rem_1fr] gap-y-1">
            <dt className="text-text-muted">From</dt>
            <dd className="font-mono text-label break-all">{result.oldPath}</dd>
            <dt className="text-text-muted">To</dt>
            <dd className="font-mono text-label break-all">{result.newPath}</dd>
            <dt className="text-text-muted">Copied</dt>
            <dd className="font-mono">{formatBytes(result.bytesCopied)}</dd>
            <dt className="text-text-muted">Duration</dt>
            <dd className="font-mono">{(result.durationMs / 1000).toFixed(1)} s</dd>
          </dl>
          <div className="flex justify-end pt-2">
            <Button onClick={close}>Done</Button>
          </div>
        </div>
      ) : !confirming ? (
        <div className="space-y-4">
          <div className="text-body">
            <span className="text-text-muted">Current:</span>{" "}
            <span className="font-mono text-label break-all">{current}</span>
          </div>
          <DataDirPicker
            value={path}
            onChange={setPath}
            onValidation={setValidation}
            disabled={busy}
            pickerPrompt="Select new KilnDB data directory"
          />
          {err && <p className="text-body text-danger">{err}</p>}
          <div className="flex justify-between pt-2">
            <Button variant="ghost" onClick={close}>Cancel</Button>
            <Button disabled={!validation?.ok} onClick={() => setConfirming(true)}>
              Continue
              <Icon name="arrow_forward" size={14} />
            </Button>
          </div>
        </div>
      ) : (
        <div className="space-y-4">
          <div className="rounded-md border border-warn/40 bg-warn/10 p-3 text-body">
            <div className="flex items-center gap-2 font-medium">
              <Icon name="warning" size={14} className="text-warn" />
              MariaDB will be stopped during the move.
            </div>
            <p className="mt-1 text-label text-text-muted">
              Connected clients will be dropped. Sync jobs and snapshots are paused. The old directory is deleted only
              after the new location starts cleanly.
            </p>
          </div>
          <dl className="text-body grid grid-cols-[6rem_1fr] gap-y-1">
            <dt className="text-text-muted">From</dt>
            <dd className="font-mono text-label break-all">{current}</dd>
            <dt className="text-text-muted">To</dt>
            <dd className="font-mono text-label break-all">{validation?.resolvedPath ?? path}</dd>
            {validation?.freeBytes != null && (
              <>
                <dt className="text-text-muted">Free at dest</dt>
                <dd className="font-mono">{formatBytes(validation.freeBytes)}</dd>
              </>
            )}
          </dl>
          {err && <p className="text-body text-danger">{err}</p>}
          <div className="flex justify-between pt-2">
            <Button variant="ghost" onClick={() => setConfirming(false)} disabled={busy}>Back</Button>
            <Button variant="danger" loading={busy} onClick={submit}>
              Move storage
            </Button>
          </div>
        </div>
      )}
    </Dialog>
  );
}
