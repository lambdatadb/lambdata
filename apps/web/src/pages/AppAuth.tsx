import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  AppAuthSettings,
  AppAuthUser,
  AppAuthUserStatus,
} from "@kilndb/shared";
import { api, ApiError } from "../lib/api";
import { useAuth } from "../lib/auth";
import { PageHeader } from "../components/layout/PageShell";
import { Card, CardTitle, SectionLabel } from "../components/ui/Card";
import { Badge } from "../components/ui/Badge";
import { Button } from "../components/ui/Button";
import { ConfirmDialog } from "../components/ui/ConfirmDialog";
import { Dialog } from "../components/ui/Dialog";
import { Field, Input } from "../components/ui/Input";
import { Select } from "../components/ui/Select";
import { StatTile } from "../components/ui/StatTile";
import { Switch } from "../components/ui/Switch";
import { Spinner } from "../components/ui/Spinner";
import { Icon } from "../components/ui/Icon";
import { CopyableField } from "../components/ui/CopyableField";
import { Table, TBody, TD, TH, THead, TR, TableEmpty, TableSkeleton } from "../components/ui/Table";
import { useToast } from "../components/ui/Toast";
import { formatDate, formatRelativeTime } from "../lib/format";

export function AppAuth() {
  const { user } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const [createOpen, setCreateOpen] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<AppAuthUser | null>(null);

  const users = useQuery({
    queryKey: ["app-auth", "users"],
    queryFn: () => api.get<{ users: AppAuthUser[] }>("/app-auth/users"),
    enabled: user?.role === "admin",
  });
  const settings = useQuery({
    queryKey: ["app-auth", "settings"],
    queryFn: () => api.get<{ settings: AppAuthSettings }>("/app-auth/settings"),
    enabled: user?.role === "admin",
  });

  const updateUser = useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: Partial<AppAuthUser> }) =>
      api.patch<{ user: AppAuthUser }>(`/app-auth/users/${id}`, patch),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["app-auth", "users"] });
      toast.show("App user updated", "success");
    },
    onError: (e) => toast.show(e instanceof ApiError ? e.message : "update failed", "error"),
  });

  const deleteUser = useMutation({
    mutationFn: (id: string) => api.delete(`/app-auth/users/${id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["app-auth", "users"] });
      setPendingDelete(null);
      toast.show("App user deleted", "success");
    },
    onError: (e) => toast.show(e instanceof ApiError ? e.message : "delete failed", "error"),
  });

  if (user?.role !== "admin") {
    return <p className="text-body text-text-muted">Admin access required.</p>;
  }

  const list = users.data?.users ?? [];
  const activeCount = list.filter((u) => u.status === "active").length;
  const confirmedCount = list.filter((u) => u.emailConfirmed).length;
  const cfg = settings.data?.settings;

  return (
    <>
      <PageHeader
        title="Auth"
        subtitle="Application users, login tokens, and public signup controls."
        actions={
          <Button onClick={() => setCreateOpen(true)}>
            <Icon name="person_add" size={15} />
            New app user
          </Button>
        }
      />

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-5">
        <StatTile
          label="App users"
          value={users.data ? list.length : null}
          format={(n) => n.toLocaleString()}
          icon="group"
        />
        <StatTile
          label="Active"
          value={users.data ? activeCount : null}
          format={(n) => n.toLocaleString()}
          icon="verified_user"
        />
        <StatTile
          label="Confirmed"
          value={users.data ? confirmedCount : null}
          format={(n) => n.toLocaleString()}
          icon="mark_email_read"
        />
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-[minmax(0,1fr)_360px] gap-5">
        <Card className="p-0 overflow-hidden">
          <div className="p-5 border-b border-border flex items-center justify-between gap-3">
            <div>
              <SectionLabel>App user directory</SectionLabel>
              <p className="text-body text-text-muted">
                These users belong to apps built on KilnDB, not console operators.
              </p>
            </div>
          </div>
          <Table flush>
            <THead>
              <tr>
                <TH>User</TH>
                <TH>Status</TH>
                <TH>Email</TH>
                <TH>Created</TH>
                <TH>Last sign in</TH>
                <TH className="text-right">Actions</TH>
              </tr>
            </THead>
            <TBody>
              {users.isLoading ? (
                <TableSkeleton rows={4} cols={6} />
              ) : list.length === 0 ? (
                <TableEmpty colSpan={6}>
                  No application users yet.
                  <div className="mt-4">
                    <Button size="sm" onClick={() => setCreateOpen(true)}>
                      <Icon name="person_add" size={14} />
                      New app user
                    </Button>
                  </div>
                </TableEmpty>
              ) : (
                list.map((appUser) => (
                  <TR key={appUser.id}>
                    <TD>
                      <div className="font-medium">{appUser.displayName ?? appUser.email}</div>
                      <div className="text-label text-text-subtle font-mono">{appUser.id}</div>
                    </TD>
                    <TD>
                      <Select
                        value={appUser.status}
                        className="h-8 w-32 py-0 text-label"
                        disabled={updateUser.isPending}
                        onChange={(e) =>
                          updateUser.mutate({
                            id: appUser.id,
                            patch: { status: e.target.value as AppAuthUserStatus },
                          })
                        }
                      >
                        <option value="active">Active</option>
                        <option value="disabled">Disabled</option>
                      </Select>
                    </TD>
                    <TD>
                      <div className="text-label text-text-muted">{appUser.email}</div>
                      <Badge className="mt-1" tone={appUser.emailConfirmed ? "success" : "warn"}>
                        {appUser.emailConfirmed ? "Confirmed" : "Unconfirmed"}
                      </Badge>
                    </TD>
                    <TD className="text-text-muted whitespace-nowrap">
                      {formatDate(appUser.createdAt)}
                    </TD>
                    <TD className="text-text-muted whitespace-nowrap">
                      {formatRelativeTime(appUser.lastSignInAt)}
                    </TD>
                    <TD className="text-right">
                      <Button size="sm" variant="ghost" onClick={() => setPendingDelete(appUser)}>
                        <Icon name="delete" size={14} />
                      </Button>
                    </TD>
                  </TR>
                ))
              )}
            </TBody>
          </Table>
        </Card>

        <div className="space-y-5">
          <AuthSettingsCard settings={cfg} loading={settings.isLoading} />
          <Card>
            <SectionLabel>Client endpoints</SectionLabel>
            <div className="space-y-3">
              <CopyableField label="Sign up" value="POST /api/app-auth/signup" monospace />
              <CopyableField label="Issue token" value="POST /api/app-auth/token" monospace />
              <CopyableField label="Current user" value="GET /api/app-auth/user" monospace />
            </div>
          </Card>
        </div>
      </div>

      <ConfirmDialog
        open={pendingDelete !== null}
        onClose={() => setPendingDelete(null)}
        onConfirm={() => pendingDelete && deleteUser.mutate(pendingDelete.id)}
        title="Delete app user"
        body={
          pendingDelete && (
            <>
              Delete <span className="font-mono text-text">{pendingDelete.email}</span>? Their
              sessions and tokens stop working immediately.
            </>
          )
        }
        confirmLabel="Delete"
        tone="danger"
        loading={deleteUser.isPending}
      />
      <CreateAppUserDialog open={createOpen} onClose={() => setCreateOpen(false)} />
    </>
  );
}

function AuthSettingsCard({
  settings,
  loading,
}: {
  settings?: AppAuthSettings;
  loading: boolean;
}) {
  const qc = useQueryClient();
  const toast = useToast();
  const [ttl, setTtl] = useState(settings?.tokenTtlSeconds ?? 3600);

  useEffect(() => {
    if (settings) setTtl(settings.tokenTtlSeconds);
  }, [settings]);

  const update = useMutation({
    mutationFn: (patch: Partial<AppAuthSettings>) =>
      api.patch<{ settings: AppAuthSettings }>("/app-auth/settings", patch),
    onSuccess: (data) => {
      setTtl(data.settings.tokenTtlSeconds);
      qc.invalidateQueries({ queryKey: ["app-auth", "settings"] });
      toast.show("Auth settings updated", "success");
    },
    onError: (e) => toast.show(e instanceof ApiError ? e.message : "settings update failed", "error"),
  });

  if (loading || !settings) {
    return (
      <Card>
        <Spinner />
      </Card>
    );
  }

  return (
    <Card>
      <div className="flex items-center justify-between">
        <CardTitle>Settings</CardTitle>
        <Badge tone={settings.allowSignup ? "success" : "muted"}>
          {settings.allowSignup ? "Signup on" : "Signup off"}
        </Badge>
      </div>
      <div className="mt-4 space-y-4">
        <Switch
          checked={settings.allowSignup}
          disabled={update.isPending}
          onChange={(allowSignup) => update.mutate({ allowSignup })}
          label="Public signup"
          description="Allow apps to create users through the public signup endpoint."
        />
        <Field label="Token TTL seconds" hint={`Issuer: ${settings.issuer}`}>
          <Input
            type="number"
            min={300}
            max={60 * 60 * 24 * 30}
            value={ttl}
            onChange={(e) => setTtl(Number(e.target.value))}
          />
        </Field>
        <Button
          size="sm"
          variant="secondary"
          loading={update.isPending}
          onClick={() => update.mutate({ tokenTtlSeconds: ttl })}
        >
          Save token TTL
        </Button>
      </div>
    </Card>
  );
}

function CreateAppUserDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [email, setEmail] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [status, setStatus] = useState<AppAuthUserStatus>("active");
  const [emailConfirmed, setEmailConfirmed] = useState(true);

  const create = useMutation({
    mutationFn: () =>
      api.post<{ user: AppAuthUser }>("/app-auth/users", {
        email,
        password,
        displayName: displayName || null,
        status,
        emailConfirmed,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["app-auth", "users"] });
      setEmail("");
      setDisplayName("");
      setPassword("");
      setStatus("active");
      setEmailConfirmed(true);
      onClose();
      toast.show("App user created", "success");
    },
    onError: (e) => toast.show(e instanceof ApiError ? e.message : "create failed", "error"),
  });

  return (
    <Dialog open={open} onClose={onClose} title="New app user" size="md">
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          create.mutate();
        }}
      >
        <Field label="Email" required>
          <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoFocus />
        </Field>
        <Field label="Display name">
          <Input value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
        </Field>
        <Field label="Initial password" required hint="At least 8 characters.">
          <Input type="text" value={password} onChange={(e) => setPassword(e.target.value)} />
        </Field>
        <Field label="Status">
          <Select value={status} onChange={(e) => setStatus(e.target.value as AppAuthUserStatus)}>
            <option value="active">Active</option>
            <option value="disabled">Disabled</option>
          </Select>
        </Field>
        <Switch
          checked={emailConfirmed}
          onChange={setEmailConfirmed}
          label="Email confirmed"
          description="Self-hosted local auth does not send confirmation email yet."
        />
        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
          <Button type="submit" loading={create.isPending}>Create user</Button>
        </div>
      </form>
    </Dialog>
  );
}
