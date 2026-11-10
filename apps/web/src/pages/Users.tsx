import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { ExperienceLevel, Role, User } from "@lambdata/shared";
import { Ellipsis, KeyRound, RotateCcw, ShieldCheck, Trash2, UserCog, UserPlus, Users as UsersIcon } from "lucide-react";
import { api, errorMessage } from "../lib/api";
import { ROLE_LABELS, roleLabel, useAuth } from "../lib/auth";
import { formatDate, formatRelativeTime } from "../lib/format";
import { queryKeys, useConsoleUsers } from "../lib/queries";
import { PageHeader } from "../components/layout/PageShell";
import {
  Alert,
  Avatar,
  Badge,
  Button,
  Card,
  ConfirmDialog,
  Dialog,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
  EmptyState,
  Field,
  FieldGroup,
  Input,
  RadioGroup,
  RadioGroupItem,
  SegmentedControl,
  TBody,
  TD,
  TH,
  THead,
  TR,
  Table,
  TableSkeleton,
  useToast,
} from "../components/ui";

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const ROLES: { value: Role; label: string; description: string }[] = [
  { value: "admin", label: ROLE_LABELS.admin, description: "Everything, including users, settings and the activity log." },
  { value: "db_owner", label: ROLE_LABELS.db_owner, description: "Creates and manages their own databases, buckets and policies." },
  { value: "viewer", label: ROLE_LABELS.viewer, description: "Read-only access to the console." },
];

export function Users() {
  const { user: me } = useAuth();
  const isAdmin = me?.role === "admin";
  const qc = useQueryClient();
  const toast = useToast();
  const [createOpen, setCreateOpen] = useState(false);
  const [passwordFor, setPasswordFor] = useState<User | null>(null);
  const [toDelete, setToDelete] = useState<User | null>(null);

  const usersQuery = useConsoleUsers({ enabled: isAdmin });
  const users = usersQuery.data?.users ?? [];

  const changeRole = useMutation({
    mutationFn: ({ id, role }: { id: string; role: Role }) => api.patch<{ user: User }>(`/users/${encodeURIComponent(id)}`, { role }),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.users }),
  });

  const remove = useMutation({
    mutationFn: (id: string) => api.delete(`/users/${encodeURIComponent(id)}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.users }),
  });

  if (!isAdmin || !me) {
    return (
      <>
        <PageHeader title="Users" subtitle="Who can sign in to this console, and what they can do." />
        <EmptyState icon={ShieldCheck} title="Admins only" description="Console users are managed by admins. Ask one to add someone or change a role." />
      </>
    );
  }

  return (
    <>
      <PageHeader
        title="Users"
        subtitle="Who can sign in to this console, and what they can do."
        actions={
          <Button onClick={() => setCreateOpen(true)}>
            <UserPlus aria-hidden /> Add user
          </Button>
        }
      />
      {usersQuery.isError ? (
        <Alert
          variant="danger"
          title="Could not load users"
          action={
            <Button size="xs" variant="secondary" onClick={() => usersQuery.refetch()}>
              <RotateCcw aria-hidden /> Retry
            </Button>
          }
        >
          {errorMessage(usersQuery.error, "The server did not answer.")}
        </Alert>
      ) : !usersQuery.isPending && users.length === 0 ? (
        <EmptyState icon={UsersIcon} title="No users" description="Add a teammate to give them their own sign-in." />
      ) : (
        <Card flush>
          <Table flush caption="Console users">
            <THead>
              <TR>
                <TH>User</TH>
                <TH>Role</TH>
                <TH className="hidden sm:table-cell">Last sign-in</TH>
                <TH className="hidden lg:table-cell">Added</TH>
                <TH className="w-px">
                  <span className="sr-only">Actions</span>
                </TH>
              </TR>
            </THead>
            <TBody>
              {usersQuery.isPending ? (
                <TableSkeleton rows={3} cols={4} />
              ) : (
                users.map((u) => {
                  const self = u.id === me.id;
                  return (
                    <TR key={u.id}>
                      <TD>
                        <div className="flex min-w-0 items-center gap-3">
                          <Avatar size="sm" name={u.displayName || u.email} />
                          <div className="min-w-0">
                            <div className="flex items-center gap-2">
                              <span className="truncate font-medium text-text">{u.displayName || u.email}</span>
                              {self && (
                                <Badge size="sm" variant="outline">
                                  you
                                </Badge>
                              )}
                            </div>
                            {u.displayName && <div className="truncate text-label text-text-muted">{u.email}</div>}
                          </div>
                        </div>
                      </TD>
                      <TD>
                        <Badge variant={u.role === "admin" ? "default" : "muted"}>
                          {u.role === "admin" && <ShieldCheck aria-hidden />}
                          {roleLabel(u.role)}
                        </Badge>
                      </TD>
                      <TD className="hidden whitespace-nowrap text-text-muted sm:table-cell" title={u.lastLoginAt ? formatDate(u.lastLoginAt) : undefined}>
                        {formatRelativeTime(u.lastLoginAt)}
                      </TD>
                      <TD className="hidden whitespace-nowrap text-text-muted lg:table-cell" title={formatDate(u.createdAt)}>
                        {formatRelativeTime(u.createdAt)}
                      </TD>
                      <TD className="text-right">
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button
                              variant="ghost"
                              size="icon-xs"
                              aria-label={`Actions for ${u.email}`}
                              loading={changeRole.isPending && changeRole.variables?.id === u.id}
                            >
                              <Ellipsis aria-hidden />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end" className="w-56">
                            {self ? (
                              <>
                                <DropdownMenuLabel>Your own account</DropdownMenuLabel>
                                <DropdownMenuItem asChild>
                                  <Link to="/settings">
                                    <KeyRound aria-hidden /> Change password in Settings
                                  </Link>
                                </DropdownMenuItem>
                              </>
                            ) : (
                              <>
                                <DropdownMenuSub>
                                  <DropdownMenuSubTrigger>
                                    <UserCog aria-hidden /> Role
                                  </DropdownMenuSubTrigger>
                                  <DropdownMenuSubContent>
                                    <DropdownMenuRadioGroup
                                      value={u.role}
                                      onValueChange={(role) =>
                                        changeRole.mutate(
                                          { id: u.id, role: role as Role },
                                          {
                                            onSuccess: () => toast.success(`${u.email} is now ${role === "admin" ? "an admin" : role === "viewer" ? "a viewer" : "a DB owner"}`),
                                            onError: (e) => toast.error(errorMessage(e, "Could not change the role")),
                                          },
                                        )
                                      }
                                    >
                                      {ROLES.map((r) => (
                                        <DropdownMenuRadioItem key={r.value} value={r.value}>
                                          {r.label}
                                        </DropdownMenuRadioItem>
                                      ))}
                                    </DropdownMenuRadioGroup>
                                  </DropdownMenuSubContent>
                                </DropdownMenuSub>
                                <DropdownMenuItem onSelect={() => setPasswordFor(u)}>
                                  <KeyRound aria-hidden /> Set a new password
                                </DropdownMenuItem>
                                <DropdownMenuSeparator />
                                <DropdownMenuItem variant="danger" onSelect={() => setToDelete(u)}>
                                  <Trash2 aria-hidden /> Remove user
                                </DropdownMenuItem>
                              </>
                            )}
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </TD>
                    </TR>
                  );
                })
              )}
            </TBody>
          </Table>
        </Card>
      )}

      <CreateUserDialog open={createOpen} onClose={() => setCreateOpen(false)} />
      <SetPasswordDialog user={passwordFor} onClose={() => setPasswordFor(null)} />
      <ConfirmDialog
        open={toDelete !== null}
        onClose={() => setToDelete(null)}
        onConfirm={() =>
          toDelete &&
          remove.mutate(toDelete.id, {
            onSuccess: () => {
              toast.success(`${toDelete.email} removed`);
              setToDelete(null);
            },
            onError: (e) => toast.error(errorMessage(e, "Could not remove the user")),
          })
        }
        loading={remove.isPending}
        tone="danger"
        title={`Remove ${toDelete?.email}?`}
        confirmLabel="Remove user"
        body="They lose console access at once. Databases and buckets they own stay where they are."
      />
    </>
  );
}

function CreateUserDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [email, setEmail] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<Role>("db_owner");
  const [level, setLevel] = useState<ExperienceLevel>("advanced");
  const [submitted, setSubmitted] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setEmail("");
    setDisplayName("");
    setPassword("");
    setRole("db_owner");
    setLevel("advanced");
    setSubmitted(false);
    setServerError(null);
  }, [open]);

  const create = useMutation({
    mutationFn: () =>
      api.post<{ user: User }>("/users", {
        email: email.trim(),
        password,
        displayName: displayName.trim() || null,
        role,
        experienceLevel: level,
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.users }),
  });

  const emailError = !email.trim() ? "Enter an email address." : !EMAIL.test(email.trim()) ? "That doesn't look like an email address." : null;
  const passwordError = password.length < 8 ? "Use at least 8 characters." : null;

  return (
    <Dialog
      open={open}
      onClose={onClose}
      size="lg"
      title="Add user"
      description="They sign in with this email and password. Share the password with them yourself."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form="create-user" loading={create.isPending}>
            Add user
          </Button>
        </>
      }
    >
      <form
        id="create-user"
        noValidate
        className="space-y-5"
        onSubmit={(e) => {
          e.preventDefault();
          setSubmitted(true);
          setServerError(null);
          if (emailError || passwordError || create.isPending) return;
          create.mutate(undefined, {
            onSuccess: (res) => {
              toast.success(`${res.user.email} added`);
              onClose();
            },
            onError: (err) => setServerError(errorMessage(err, "Could not add the user")),
          });
        }}
      >
        <FieldGroup>
          <Field label="Email" required error={(submitted && emailError) || serverError || undefined}>
            <Input type="email" autoComplete="off" value={email} onChange={(e) => setEmail(e.target.value)} />
          </Field>
          <Field label="Display name" hint="Optional">
            <Input value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
          </Field>
        </FieldGroup>
        <Field label="Initial password" required hint="At least 8 characters." error={submitted && passwordError ? passwordError : undefined}>
          <Input type="text" mono autoComplete="off" spellCheck={false} value={password} onChange={(e) => setPassword(e.target.value)} />
        </Field>
        <fieldset className="space-y-2.5">
          <legend className="mb-2.5 text-label font-medium text-text-muted">Role</legend>
          <RadioGroup value={role} onValueChange={(v) => setRole(v as Role)} aria-label="Role">
            {ROLES.map((r) => (
              <RadioGroupItem key={r.value} value={r.value} label={r.label} description={r.description} />
            ))}
          </RadioGroup>
        </fieldset>
        <Field label="Interface" id="new-user-level" hint="Novice explains database terms in plain words.">
          <SegmentedControl
            id="new-user-level"
            aria-label="Interface"
            className="w-fit"
            value={level}
            onValueChange={(v) => setLevel(v as ExperienceLevel)}
            options={[
              { value: "advanced", label: "Advanced" },
              { value: "novice", label: "Novice" },
            ]}
          />
        </Field>
      </form>
    </Dialog>
  );
}

function SetPasswordDialog({ user, onClose }: { user: User | null; onClose: () => void }) {
  const toast = useToast();
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);

  useEffect(() => {
    if (!user) return;
    setPassword("");
    setConfirm("");
    setSubmitted(false);
    setServerError(null);
  }, [user]);

  const save = useMutation({
    mutationFn: (id: string) => api.patch(`/users/${encodeURIComponent(id)}`, { password }),
  });

  const passwordError = password.length < 8 ? "Use at least 8 characters." : null;
  const confirmError = confirm !== password ? "The passwords don't match." : null;

  return (
    <Dialog
      open={user !== null}
      onClose={onClose}
      title="Set a new password"
      description={user ? `For ${user.email}. They are signed out everywhere and use this password next time; share it with them yourself.` : undefined}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form="set-password" loading={save.isPending}>
            Set password
          </Button>
        </>
      }
    >
      <form
        id="set-password"
        noValidate
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          setSubmitted(true);
          setServerError(null);
          if (!user || passwordError || confirmError || save.isPending) return;
          save.mutate(user.id, {
            onSuccess: () => {
              toast.success(`Password changed for ${user.email}`);
              onClose();
            },
            onError: (err) => setServerError(errorMessage(err, "Could not set the password")),
          });
        }}
      >
        <Field label="New password" required error={(submitted && passwordError) || serverError || undefined}>
          <Input type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} />
        </Field>
        <Field label="Repeat it" required error={submitted && confirmError ? confirmError : undefined}>
          <Input type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
        </Field>
      </form>
    </Dialog>
  );
}
