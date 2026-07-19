import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ExperienceLevel, Role, User } from "@kilndb/shared";
import { api, ApiError } from "../lib/api";
import { useAuth } from "../lib/auth";
import { PageHeader } from "../components/layout/PageShell";
import { Card } from "../components/ui/Card";
import { Button } from "../components/ui/Button";
import { ConfirmDialog } from "../components/ui/ConfirmDialog";
import { Dialog } from "../components/ui/Dialog";
import { Field, Input } from "../components/ui/Input";
import { Select } from "../components/ui/Select";
import { Table, TBody, TD, TH, THead, TR, TableEmpty, TableSkeleton } from "../components/ui/Table";
import { useToast } from "../components/ui/Toast";
import { formatDate, formatRelativeTime } from "../lib/format";
import { Badge } from "../components/ui/Badge";
import { Icon } from "../components/ui/Icon";

export function Users() {
  const { user } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<User | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ["users"],
    queryFn: () => api.get<{ users: User[] }>("/users"),
    enabled: user?.role === "admin",
  });

  const del = useMutation({
    mutationFn: (id: string) => api.delete(`/users/${id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["users"] });
      setPendingDelete(null);
    },
    onError: (e) => toast.show(e instanceof ApiError ? e.message : "delete failed", "error"),
  });

  if (user?.role !== "admin") {
    return <p className="text-body text-text-muted">Admin access required.</p>;
  }

  const list = data?.users ?? [];

  return (
    <>
      <PageHeader
        title="Users"
        subtitle="Manage who can sign in and what they can do."
        actions={
          <Button onClick={() => setOpen(true)}>
            <Icon name="person_add" size={14} />
            Invite user
          </Button>
        }
      />
      <Card className="p-0 overflow-hidden">
        <Table flush>
          <THead>
            <tr>
              <TH>Email</TH>
              <TH>Role</TH>
              <TH>Created</TH>
              <TH>Last login</TH>
              <TH />
            </tr>
          </THead>
          <TBody>
            {isLoading ? (
              <TableSkeleton rows={3} cols={5} />
            ) : list.length === 0 ? (
              <TableEmpty colSpan={5}>No users yet. Invite a teammate to get started.</TableEmpty>
            ) : (
              list.map((u) => (
                <TR key={u.id}>
                  <TD>
                    <div className="font-medium">{u.displayName ?? u.email}</div>
                    <div className="text-label text-text-muted">{u.email}</div>
                  </TD>
                  <TD>
                    <Badge tone={u.role === "admin" ? "accent" : "muted"}>{u.role.replace("_", " ")}</Badge>
                  </TD>
                  <TD className="text-text-muted">{formatDate(u.createdAt)}</TD>
                  <TD className="text-text-muted">{formatRelativeTime(u.lastLoginAt)}</TD>
                  <TD className="text-right">
                    {u.id !== user.id && (
                      <Button size="sm" variant="ghost" onClick={() => setPendingDelete(u)}>
                        Delete
                      </Button>
                    )}
                  </TD>
                </TR>
              ))
            )}
          </TBody>
        </Table>
      </Card>
      <ConfirmDialog
        open={pendingDelete !== null}
        onClose={() => setPendingDelete(null)}
        onConfirm={() => pendingDelete && del.mutate(pendingDelete.id)}
        title="Delete user"
        body={
          pendingDelete && (
            <>
              Remove <span className="font-mono text-text">{pendingDelete.email}</span> from this
              instance? They lose console access immediately.
            </>
          )
        }
        confirmLabel="Delete user"
        tone="danger"
        loading={del.isPending}
      />
      <CreateUserDialog open={open} onClose={() => setOpen(false)} />
    </>
  );
}

function CreateUserDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [role, setRole] = useState<Role>("db_owner");
  const [experienceLevel, setExperienceLevel] = useState<ExperienceLevel>("advanced");

  const mu = useMutation({
    mutationFn: () =>
      api.post("/users", { email, password, displayName: displayName || null, role, experienceLevel }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["users"] });
      toast.show("User created", "success");
      setEmail("");
      setPassword("");
      setDisplayName("");
      setRole("db_owner");
      onClose();
    },
    onError: (e) => toast.show(e instanceof ApiError ? e.message : "create failed", "error"),
  });

  return (
    <Dialog open={open} onClose={onClose} title="Invite user" size="md">
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          mu.mutate();
        }}
      >
        <Field label="Email" required><Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} /></Field>
        <Field label="Display name"><Input value={displayName} onChange={(e) => setDisplayName(e.target.value)} /></Field>
        <Field label="Initial password" required hint="At least 8 characters">
          <Input type="text" value={password} onChange={(e) => setPassword(e.target.value)} />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Role">
            <Select value={role} onChange={(e) => setRole(e.target.value as Role)}>
              <option value="admin">Admin</option>
              <option value="db_owner">DB owner</option>
              <option value="viewer">Viewer</option>
            </Select>
          </Field>
          <Field label="Experience level">
            <Select value={experienceLevel} onChange={(e) => setExperienceLevel(e.target.value as ExperienceLevel)}>
              <option value="advanced">Advanced</option>
              <option value="novice">Novice</option>
            </Select>
          </Field>
        </div>
        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
          <Button type="submit" loading={mu.isPending}>Create</Button>
        </div>
      </form>
    </Dialog>
  );
}
