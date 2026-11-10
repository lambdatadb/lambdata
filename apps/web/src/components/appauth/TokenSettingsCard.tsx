import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { AppAuthSettings } from "@lambdata/shared";
import { Button, Card, CardHeader, CopyButton, DescriptionItem, DescriptionList, Field, Input, Skeleton, useToast } from "../ui";
import { api, absoluteUrl, errorMessage } from "../../lib/api";
import { appAuthSettingsKey } from "./SignupCard";

const MIN_TTL = 300;
const MAX_TTL = 60 * 60 * 24 * 30;

function humanDuration(seconds: number): string {
  if (seconds % 86_400 === 0) return `${seconds / 86_400} ${seconds === 86_400 ? "day" : "days"}`;
  if (seconds % 3_600 === 0) return `${seconds / 3_600} ${seconds === 3_600 ? "hour" : "hours"}`;
  if (seconds % 60 === 0) return `${seconds / 60} minutes`;
  return `${seconds} seconds`;
}

export function TokenSettingsCard({ settings }: { settings: AppAuthSettings | undefined }) {
  return (
    <Card>
      <CardHeader title="Access tokens" description="Issued by the token endpoint and accepted by the Data API, Realtime and Functions." />
      {settings ? (
        <TokenForm key={settings.tokenTtlSeconds} settings={settings} />
      ) : (
        <div className="space-y-3" role="status" aria-label="Loading token settings">
          <Skeleton className="h-3.5 w-24" />
          <Skeleton className="h-9 w-full" />
          <Skeleton className="h-3.5 w-40" />
        </div>
      )}
    </Card>
  );
}

function TokenForm({ settings }: { settings: AppAuthSettings }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [ttl, setTtl] = useState(String(settings.tokenTtlSeconds));
  const parsed = Number(ttl);
  const valid = ttl.trim() !== "" && Number.isInteger(parsed) && parsed >= MIN_TTL && parsed <= MAX_TTL;
  const dirty = parsed !== settings.tokenTtlSeconds;

  const save = useMutation({
    mutationFn: (tokenTtlSeconds: number) =>
      api.patch<{ settings: AppAuthSettings }>("/app-auth/settings", { tokenTtlSeconds }),
    onSuccess: (res) => {
      qc.setQueryData(appAuthSettingsKey, res);
      qc.invalidateQueries({ queryKey: appAuthSettingsKey });
    },
  });

  return (
    <form
      className="space-y-4"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        if (!valid || !dirty) return;
        save.mutate(parsed, {
          onSuccess: () => toast.success(`Tokens now last ${humanDuration(parsed)}`),
          onError: (err) => toast.error(errorMessage(err, "Could not save the token lifetime")),
        });
      }}
    >
      <Field
        label="Lifetime in seconds"
        hint={valid ? `${humanDuration(parsed)}. Between 5 minutes and 30 days.` : undefined}
        error={!valid ? `Enter a whole number from ${MIN_TTL} to ${MAX_TTL.toLocaleString()}.` : undefined}
      >
        <Input
          inputMode="numeric"
          mono
          value={ttl}
          onChange={(e) => setTtl(e.target.value.replace(/[^\d]/g, ""))}
        />
      </Field>
      <div className="flex items-center justify-between gap-3">
        <DescriptionList layout="stacked" className="min-w-0">
          <DescriptionItem term="Issuer" mono>
            <span className="break-all">{settings.issuer}</span>
          </DescriptionItem>
        </DescriptionList>
        <Button type="submit" size="sm" variant="secondary" disabled={!valid || !dirty} loading={save.isPending}>
          Save
        </Button>
      </div>
    </form>
  );
}

const ENDPOINTS: { method: string; path: string; label: string; signup?: boolean }[] = [
  { method: "POST", path: "/api/app-auth/signup", label: "Create a user", signup: true },
  { method: "POST", path: "/api/app-auth/token", label: "Sign in and get a token" },
  { method: "GET", path: "/api/app-auth/user", label: "Current user" },
];

export function EndpointsCard({ signupEnabled }: { signupEnabled: boolean | undefined }) {
  return (
    <Card flush>
      <CardHeader divided title="Client endpoints" description="What your apps call to sign users in." />
      <ul className="divide-y divide-border">
        {ENDPOINTS.map((endpoint) => {
          const disabled = endpoint.signup && signupEnabled === false;
          return (
            <li key={endpoint.path} className="flex items-center gap-3 px-5 py-3">
              <span className="w-12 shrink-0 font-mono text-micro text-text-subtle">{endpoint.method}</span>
              <div className="min-w-0 flex-1">
                <div className={disabled ? "truncate font-mono text-code text-text-subtle line-through" : "truncate font-mono text-code text-text"}>
                  {endpoint.path}
                </div>
                <div className="text-micro text-text-subtle">
                  {endpoint.label}
                  {disabled ? " · off while signup is off" : ""}
                </div>
              </div>
              <CopyButton value={absoluteUrl(endpoint.path)} label={`${endpoint.path} URL`} size="icon-xs" />
            </li>
          );
        })}
      </ul>
    </Card>
  );
}
