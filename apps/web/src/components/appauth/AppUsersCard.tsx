import { useState } from "react";
import { useMutation, useQueryClient, type UseQueryResult } from "@tanstack/react-query";
import type { AppAuthUser, AppAuthUserStatus } from "@lambdata/shared";
import { Copy, Ellipsis, MailCheck, RotateCcw, Trash2, UserCheck, UserPlus, UserX, Users } from "lucide-react";
import {
  Alert,
  Avatar,
  Badge,
  Button,
  Card,
  CardHeader,
  ConfirmDialog,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  EmptyState,
  TBody,
  TD,
  TH,
  THead,
  TR,
  Table,
  TableSkeleton,
  copyText,
  useToast,
} from "../ui";
import { api, errorMessage } from "../../lib/api";
import { formatDate, formatRelativeTime } from "../../lib/format";

export const appUsersKey = ["app-auth", "users"] as const;

type UsersData = { users: AppAuthUser[] };

interface Props {
  query: UseQueryResult<UsersData>;
  onCreate: () => void;
}

export function AppUsersCard({ query, onCreate }: Props) {
  const qc = useQueryClient();
  const toast = useToast();
  const [confirm, setConfirm] = useState<{ kind: "disable" | "delete"; user: AppAuthUser } | null>(null);

  const update = useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: Partial<Pick<AppAuthUser, "status" | "emailConfirmed">> }) =>
      api.patch<{ user: AppAuthUser }>(`/app-auth/users/${encodeURIComponent(id)}`, patch),
    onMutate: async ({ id, patch }) => {
      await qc.cancelQueries({ queryKey: appUsersKey });
      const previous = qc.getQueryData<UsersData>(appUsersKey);
      qc.setQueryData<UsersData>(appUsersKey, (data) =>
        data ? { users: data.users.map((u) => (u.id === id ? { ...u, ...patch } : u)) } : data,
      );
      return { previous };
    },
    onError: (_e, _vars, context) => {
      if (context?.previous) qc.setQueryData(appUsersKey, context.previous);
    },
    onSettled: () => qc.invalidateQueries({ queryKey: appUsersKey }),
  });

  const remove = useMutation({
    mutationFn: (id: string) => api.delete(`/app-auth/users/${encodeURIComponent(id)}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: appUsersKey }),
  });

  const setStatus = (user: AppAuthUser, status: AppAuthUserStatus) =>
    update.mutate(
      { id: user.id, patch: { status } },
      {
        onSuccess: () => {
          setConfirm(null);
          toast.success(status === "disabled" ? `${user.email} can no longer sign in` : `${user.email} can sign in again`);
        },
        onError: (e) => toast.error(errorMessage(e, "Could not update the app user")),
      },
    );

  const users = query.data?.users ?? [];

  return (
    <Card flush>
      <CardHeader
        divided
        title="App users"
        description="People who sign in to the apps you build on LambData. They never see this console."
      />
      {query.isError ? (
        <div className="p-5">
          <Alert
            variant="danger"
            title="Could not load app users"
            action={
              <Button size="xs" variant="secondary" onClick={() => query.refetch()}>
                <RotateCcw aria-hidden /> Retry
              </Button>
            }
          >
            {errorMessage(query.error, "The server did not answer.")}
          </Alert>
        </div>
      ) : !query.isPending && users.length === 0 ? (
        <EmptyState
          variant="bare"
          icon={Users}
          title="No app users yet"
          description="Add one here, or turn on public signup so your apps can register their own."
          action={
            <Button size="sm" variant="secondary" onClick={onCreate}>
              <UserPlus aria-hidden /> New app user
            </Button>
          }
        />
      ) : (
        <Table flush caption="App users">
          <THead>
            <TR>
              <TH>User</TH>
              <TH>Status</TH>
              <TH className="hidden xl:table-cell">Created</TH>
              <TH className="hidden sm:table-cell">Last sign in</TH>
              <TH className="w-12">
                <span className="sr-only">Actions</span>
              </TH>
            </TR>
          </THead>
          <TBody>
            {query.isPending ? (
              <TableSkeleton rows={4} cols={4} />
            ) : (
              users.map((appUser) => {
                const busy = update.isPending && update.variables?.id === appUser.id;
                return (
                  <TR key={appUser.id}>
                    <TD>
                      <div className="flex min-w-0 items-center gap-3">
                        <Avatar size="sm" name={appUser.displayName || appUser.email} />
                        <div className="min-w-0">
                          <div className="truncate font-medium text-text">{appUser.displayName || appUser.email}</div>
                          {appUser.displayName && (
                            <div className="truncate text-label text-text-muted">{appUser.email}</div>
                          )}
                        </div>
                      </div>
                    </TD>
                    <TD>
                      <div className="flex flex-wrap items-center gap-1.5">
                        <Badge variant={appUser.status === "active" ? "success" : "muted"} dot>
                          {appUser.status === "active" ? "active" : "disabled"}
                        </Badge>
                        {!appUser.emailConfirmed && (
                          <Badge variant="outline" size="sm">
                            unconfirmed
                          </Badge>
                        )}
                      </div>
                    </TD>
                    <TD className="hidden whitespace-nowrap text-text-muted xl:table-cell" title={formatDate(appUser.createdAt)}>
                      {formatRelativeTime(appUser.createdAt)}
                    </TD>
                    <TD
                      className="hidden whitespace-nowrap text-text-muted sm:table-cell"
                      title={appUser.lastSignInAt ? formatDate(appUser.lastSignInAt) : undefined}
                    >
                      {formatRelativeTime(appUser.lastSignInAt)}
                    </TD>
                    <TD className="text-right">
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button variant="ghost" size="icon-xs" loading={busy} aria-label={`Actions for ${appUser.email}`}>
                            <Ellipsis aria-hidden />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end" className="w-52">
                          <DropdownMenuItem
                            onSelect={async () => {
                              const ok = await copyText(appUser.id);
                              if (ok) toast.success("User ID copied");
                              else toast.error("Copy blocked by the browser", { description: appUser.id });
                            }}
                          >
                            <Copy aria-hidden /> Copy user ID
                          </DropdownMenuItem>
                          {!appUser.emailConfirmed && (
                            <DropdownMenuItem
                              onSelect={() =>
                                update.mutate(
                                  { id: appUser.id, patch: { emailConfirmed: true } },
                                  {
                                    onSuccess: () => toast.success(`${appUser.email} marked as confirmed`),
                                    onError: (e) => toast.error(errorMessage(e, "Could not update the app user")),
                                  },
                                )
                              }
                            >
                              <MailCheck aria-hidden /> Mark email confirmed
                            </DropdownMenuItem>
                          )}
                          {appUser.status === "active" ? (
                            <DropdownMenuItem onSelect={() => setConfirm({ kind: "disable", user: appUser })}>
                              <UserX aria-hidden /> Disable sign-in
                            </DropdownMenuItem>
                          ) : (
                            <DropdownMenuItem onSelect={() => setStatus(appUser, "active")}>
                              <UserCheck aria-hidden /> Enable sign-in
                            </DropdownMenuItem>
                          )}
                          <DropdownMenuSeparator />
                          <DropdownMenuItem variant="danger" onSelect={() => setConfirm({ kind: "delete", user: appUser })}>
                            <Trash2 aria-hidden /> Delete
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </TD>
                  </TR>
                );
              })
            )}
          </TBody>
        </Table>
      )}

      <ConfirmDialog
        open={confirm?.kind === "disable"}
        onClose={() => setConfirm(null)}
        onConfirm={() => confirm && setStatus(confirm.user, "disabled")}
        loading={update.isPending}
        tone="danger"
        title={`Disable ${confirm?.user.email}?`}
        body="Their tokens stop working at once, and they cannot sign in until you enable them again."
        confirmLabel="Disable sign-in"
      />
      <ConfirmDialog
        open={confirm?.kind === "delete"}
        onClose={() => setConfirm(null)}
        onConfirm={() =>
          confirm &&
          remove.mutate(confirm.user.id, {
            onSuccess: () => {
              toast.success(`${confirm.user.email} deleted`);
              setConfirm(null);
            },
            onError: (e) => toast.error(errorMessage(e, "Could not delete the app user")),
          })
        }
        loading={remove.isPending}
        tone="danger"
        title={`Delete ${confirm?.user.email}?`}
        body="The account is removed and its sessions stop working. Rows it owns in your tables are kept."
        confirmLabel="Delete app user"
      />
    </Card>
  );
}
