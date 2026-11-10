import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { AppAuthSettings, AppAuthUser } from "@lambdata/shared";
import { MailCheck, ShieldCheck, UserCheck, UserPlus, Users } from "lucide-react";
import { api, errorMessage } from "../lib/api";
import { useAuth } from "../lib/auth";
import { PageHeader } from "../components/layout/PageShell";
import { Alert, Button, EmptyState, StatTile } from "../components/ui";
import { AppUsersCard, appUsersKey } from "../components/appauth/AppUsersCard";
import { CreateAppUserDialog } from "../components/appauth/CreateAppUserDialog";
import { SignupCard, appAuthSettingsKey } from "../components/appauth/SignupCard";
import { EndpointsCard, TokenSettingsCard } from "../components/appauth/TokenSettingsCard";

export function AppAuth() {
  const { user } = useAuth();
  const isAdmin = user?.role === "admin";
  const [createOpen, setCreateOpen] = useState(false);

  const usersQuery = useQuery({
    queryKey: appUsersKey,
    queryFn: () => api.get<{ users: AppAuthUser[] }>("/app-auth/users"),
    enabled: isAdmin,
  });
  const settingsQuery = useQuery({
    queryKey: appAuthSettingsKey,
    queryFn: () => api.get<{ settings: AppAuthSettings }>("/app-auth/settings"),
    enabled: isAdmin,
  });

  if (!isAdmin) {
    return (
      <>
        <PageHeader title="Auth" subtitle="Users of the apps you build on LambData, and how they sign in." />
        <EmptyState
          icon={ShieldCheck}
          title="Admins only"
          description="App users, public signup and token settings are managed by admins. Ask one if you need a change here."
        />
      </>
    );
  }

  const users = usersQuery.data?.users ?? [];
  const settings = settingsQuery.data?.settings;
  const loadingUsers = usersQuery.isPending;

  return (
    <>
      <PageHeader
        title="Auth"
        subtitle="Users of the apps you build on LambData, and how they sign in."
        actions={
          <Button onClick={() => setCreateOpen(true)}>
            <UserPlus aria-hidden /> New app user
          </Button>
        }
      />
      <div className="space-y-5">
        {settingsQuery.isError ? (
          <Alert
            variant="danger"
            title="Could not load auth settings"
            action={
              <Button size="xs" variant="secondary" onClick={() => settingsQuery.refetch()}>
                Retry
              </Button>
            }
          >
            {errorMessage(settingsQuery.error, "The server did not answer.")}
          </Alert>
        ) : (
          <SignupCard settings={settings} />
        )}

        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          <StatTile label="App users" icon={Users} loading={loadingUsers} value={usersQuery.data ? users.length : null} />
          <StatTile
            label="Can sign in"
            icon={UserCheck}
            loading={loadingUsers}
            value={usersQuery.data ? users.filter((u) => u.status === "active").length : null}
          />
          <StatTile
            label="Email confirmed"
            className="col-span-2 sm:col-span-1"
            icon={MailCheck}
            loading={loadingUsers}
            value={usersQuery.data ? users.filter((u) => u.emailConfirmed).length : null}
          />
        </div>

        <div className="grid grid-cols-1 items-start gap-5 xl:grid-cols-[minmax(0,1fr)_21rem]">
          <AppUsersCard query={usersQuery} onCreate={() => setCreateOpen(true)} />
          <div className="space-y-5">
            <TokenSettingsCard settings={settings} />
            <EndpointsCard signupEnabled={settings?.allowSignup} />
          </div>
        </div>
      </div>
      <CreateAppUserDialog open={createOpen} onClose={() => setCreateOpen(false)} />
    </>
  );
}
