import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { AppAuthSettings } from "@lambdata/shared";
import { ShieldAlert, UserPlus } from "lucide-react";
import { Badge, Button, Card, ConfirmDialog, Skeleton, Switch, useToast } from "../ui";
import { api, errorMessage } from "../../lib/api";
import { formatDate, formatRelativeTime, pluralize } from "../../lib/format";
import { dataAccessKey, useDataAccessOverview } from "../dataapi/useDataAccess";

export const appAuthSettingsKey = ["app-auth", "settings"] as const;

export function SignupCard({ settings }: { settings: AppAuthSettings | undefined }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [confirming, setConfirming] = useState(false);
  const overview = useDataAccessOverview();
  const openDatabases = overview.data?.supported ? overview.data.databases.filter((d) => d.mode === "open") : [];

  const update = useMutation({
    mutationFn: (allowSignup: boolean) => api.patch<{ settings: AppAuthSettings }>("/app-auth/settings", { allowSignup }),
    onSuccess: (res) => {
      qc.setQueryData(appAuthSettingsKey, res);
      qc.invalidateQueries({ queryKey: appAuthSettingsKey });
      qc.invalidateQueries({ queryKey: dataAccessKey });
    },
  });

  const commit = (allowSignup: boolean, message?: string) =>
    update.mutate(allowSignup, {
      onSuccess: () => {
        setConfirming(false);
        toast.success(message ?? (allowSignup ? "Public signup is on" : "Public signup is off"));
      },
      onError: (e) => toast.error(errorMessage(e, "Could not change signup")),
    });

  const on = settings?.allowSignup === true;
  const refused = settings?.signupRefusedCount ?? 0;
  const lastRefused = settings?.signupRefusedLastAt ?? null;

  return (
    <>
      {settings?.signupDisabledByUpgrade && (
        <Card flush className="border-warn/40" role="region" aria-labelledby="signup-upgrade-title">
          <div className="flex flex-wrap items-start gap-x-4 gap-y-3 px-5 py-4">
            <span className="grid size-8 shrink-0 place-items-center rounded-md border border-warn/30 bg-warn/10 text-warn">
              <ShieldAlert className="size-4" aria-hidden />
            </span>
            <div className="min-w-0 flex-1 basis-64 space-y-1">
              <h2 id="signup-upgrade-title" className="text-heading font-semibold text-text">
                The upgrade turned public signup off
              </h2>
              <p className="text-body text-text-muted">
                Signup had never been turned on explicitly, so it is now off by default. Apps that let people register
                themselves get a refusal until you decide.
              </p>
              <p className="text-label text-text-muted">
                {refused > 0 ? (
                  <>
                    {pluralize(refused, "signup attempt")} refused since the upgrade
                    {lastRefused ? (
                      <>
                        , the last one <span title={formatDate(lastRefused)}>{formatRelativeTime(lastRefused)}</span>
                      </>
                    ) : null}
                    .
                  </>
                ) : (
                  "No signup attempts have been refused yet."
                )}
              </p>
            </div>
            <div className="flex shrink-0 flex-wrap gap-2">
              <Button variant="ghost" size="sm" disabled={update.isPending} onClick={() => commit(false, "Public signup stays off")}>
                Keep it off
              </Button>
              <Button variant="secondary" size="sm" disabled={update.isPending} onClick={() => setConfirming(true)}>
                Turn signup on
              </Button>
            </div>
          </div>
        </Card>
      )}
      <Card className="flex flex-wrap items-center gap-x-4 gap-y-3">
        <span className="hidden size-10 shrink-0 place-items-center rounded-lg border border-border-strong bg-bg-raised text-text-muted sm:grid">
          <UserPlus className="size-[18px]" aria-hidden />
        </span>
        <div className="min-w-0 flex-1 basis-64 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-heading font-semibold text-text">Public signup</h2>
            {settings ? (
              <Badge variant={on ? "warn" : "muted"} dot size="lg">
                {on ? "On" : "Off"}
              </Badge>
            ) : (
              <Skeleton className="h-6 w-12" />
            )}
          </div>
          <p className="text-body text-text-muted">
            {!settings
              ? "Checking whether apps can register their own users."
              : on
                ? "Anyone who can reach this server can create an app user through the signup endpoint."
                : "Off by default. Apps cannot register their own users; add app users here instead."}
          </p>
        </div>
        <Switch
          checked={on}
          disabled={!settings || update.isPending}
          onCheckedChange={(next) => (next ? setConfirming(true) : commit(false))}
          label="Allow signup"
        />
        <ConfirmDialog
          open={confirming}
          onClose={() => setConfirming(false)}
          onConfirm={() => commit(true)}
          loading={update.isPending}
          size="md"
          title="Turn on public signup?"
          confirmLabel="Turn on signup"
          body={
            <>
              Anyone who can reach this server can create an app user and get an access token.{" "}
              {openDatabases.length > 0 ? (
                <>
                  <span className="text-text">
                    {openDatabases.length} {openDatabases.length === 1 ? "database is" : "databases are"} open
                  </span>{" "}
                  ({openDatabases.map((d) => d.displayName).join(", ")}), so new users can read and write their tables
                  that have no policy.
                </>
              ) : (
                "Closed databases still deny every table that has no policy."
              )}
            </>
          }
        />
      </Card>
    </>
  );
}
