import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ShieldCheck } from "lucide-react";
import type {
  CloudflareAccessTestResponse,
  NetworkStatus,
  NetworkStatusResponse,
  UpdateCloudflareAccessRequest,
} from "@lambdata/shared";
import {
  Alert,
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  Field,
  FieldGroup,
  Input,
  Switch,
  toast,
} from "../ui";
import { api } from "../../lib/api";
import { formatRelativeTime } from "../../lib/format";
import { queryKeys } from "../../lib/queries";
import { putPolicy, useNetworkMutation } from "./model";
import { Code, Refusal } from "./parts";

export function AccessCard({ status, isAdmin }: { status: NetworkStatus; isAdmin: boolean }) {
  const qc = useQueryClient();
  const access = status.cloudflare.access;
  const policy = status.policy;
  const [team, setTeam] = useState<string | null>(null);
  const [aud, setAud] = useState<string | null>(null);
  const teamValue = team ?? access.teamDomain ?? "";
  const audValue = aud ?? access.audience ?? "";
  const dirty = teamValue.trim() !== (access.teamDomain ?? "") || audValue.trim() !== (access.audience ?? "");

  const save = useNetworkMutation((body: UpdateCloudflareAccessRequest) =>
    api.put<NetworkStatusResponse>("/network/cloudflare/access", body),
  );
  const enforce = useNetworkMutation((on: boolean) => putPolicy({ ...policy, requireCloudflareAccess: on }));
  const test = useMutation({
    mutationFn: () => api.post<CloudflareAccessTestResponse>("/network/cloudflare/access/test"),
    onSuccess: () => void qc.invalidateQueries({ queryKey: queryKeys.network }),
  });

  const viaCloudflare = status.yourIngress === "cloudflare";
  const unverifiedHere = viaCloudflare && status.yourAccessVerified === false;
  const tested = access.lastVerifiedAt !== null;
  const canEnforce = access.configured && tested && !status.policyLockedByEnv;
  const enforceReason = status.policyLockedByEnv
    ? "The policy is forced open by LAMBDATA_ACCESS_POLICY, so it cannot be changed."
    : !access.configured
      ? "Save the team domain and audience tag first."
      : !tested
        ? "Run “Test my session” successfully first, from a browser that came in through your Cloudflare hostname."
        : null;
  const publicUrl = status.publicUrls[0] ?? null;

  const submit = (body: UpdateCloudflareAccessRequest) => {
    save.reset();
    save.mutate(body, {
      onSuccess: () => {
        setTeam(null);
        setAud(null);
        test.reset();
        toast.success(body.teamDomain ? "Cloudflare Access settings saved" : "Cloudflare Access settings cleared");
      },
    });
  };

  return (
    <Card flush>
      <CardHeader
        divided
        title="Your Access application"
        action={
          policy.requireCloudflareAccess ? (
            <Badge variant="success" dot>
              required
            </Badge>
          ) : access.configured ? (
            <Badge variant="muted" dot>
              configured
            </Badge>
          ) : (
            <Badge variant="muted" dot>
              not set up
            </Badge>
          )
        }
      />
      <CardContent className="space-y-5">
        <FieldGroup>
          <Field label="Team domain" hint="Zero Trust → Settings → Custom Pages shows it.">
            <Input
              mono
              value={teamValue}
              disabled={!isAdmin || save.isPending}
              onChange={(e) => {
                save.reset();
                setTeam(e.target.value);
              }}
              placeholder="yourteam.cloudflareaccess.com"
              spellCheck={false}
              autoComplete="off"
            />
          </Field>
          <Field label="Application audience (AUD) tag" hint="Access → Applications → your app → Overview.">
            <Input
              mono
              value={audValue}
              disabled={!isAdmin || save.isPending}
              onChange={(e) => {
                save.reset();
                setAud(e.target.value);
              }}
              placeholder="64 hexadecimal characters"
              spellCheck={false}
              autoComplete="off"
            />
          </Field>
        </FieldGroup>
        <Refusal error={save.error} onDismiss={save.reset} />
        {isAdmin && (dirty || access.configured) && (
          <div className="flex flex-wrap justify-end gap-2">
            {access.configured && !dirty && (
              <Button variant="ghost" size="sm" disabled={save.isPending} onClick={() => submit({ teamDomain: null, audience: null })}>
                Clear Access settings
              </Button>
            )}
            {dirty && (
              <Button variant="ghost" size="sm" disabled={save.isPending} onClick={() => { setTeam(null); setAud(null); save.reset(); }}>
                Discard
              </Button>
            )}
            {dirty && (
              <Button
                variant="secondary"
                size="sm"
                loading={save.isPending}
                disabled={!teamValue.trim() || !audValue.trim()}
                onClick={() => submit({ teamDomain: teamValue.trim(), audience: audValue.trim() })}
              >
                Save Access settings
              </Button>
            )}
          </div>
        )}

        <div className="space-y-3 rounded-md border border-border bg-bg-inset p-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="min-w-0 space-y-0.5">
              <p className="text-body font-medium text-text">Test my session</p>
              <p className="text-label text-text-muted">
                {tested ? `Last verified ${formatRelativeTime(access.lastVerifiedAt)}.` : "Not verified yet."} Checks the
                Access token on this very request.
              </p>
            </div>
            {isAdmin && (
              <Button
                variant="secondary"
                size="sm"
                loading={test.isPending}
                disabled={!access.configured || dirty}
                onClick={() => test.mutate()}
              >
                <ShieldCheck aria-hidden /> Test my session
              </Button>
            )}
          </div>
          {isAdmin && access.configured && !viaCloudflare && !test.data && (
            <p className="text-label text-text-muted">
              This browser did not come through Cloudflare, so the test will fail here.{" "}
              {publicUrl ? (
                <>
                  Open <a className="text-text underline underline-offset-4" href={`${publicUrl}/network`}>{publicUrl}</a> and
                  test from there.
                </>
              ) : (
                "Open the console through your Cloudflare hostname and test from there."
              )}
            </p>
          )}
          {test.data?.ok && (
            <Alert variant="success" title="Verified">
              Cloudflare Access signed this request for <span className="font-mono text-code text-text">{test.data.email ?? "a service token"}</span>.
            </Alert>
          )}
          {test.data && !test.data.ok && (
            <Alert variant="danger" title="Not verified">
              {test.data.error}
            </Alert>
          )}
          {test.error && <Refusal error={test.error} onDismiss={test.reset} />}
        </div>

        <div className="space-y-3">
          <Switch
            checked={policy.requireCloudflareAccess}
            disabled={!isAdmin || enforce.isPending || (!canEnforce && !policy.requireCloudflareAccess) || status.policyLockedByEnv}
            onCheckedChange={(on) => {
              enforce.reset();
              enforce.mutate(on, {
                onSuccess: () => toast.success(on ? "Cloudflare Access is now required" : "Cloudflare Access is no longer required"),
              });
            }}
            label="Require Cloudflare Access"
            description={
              policy.requireCloudflareAccess
                ? "On. Requests through Cloudflare without a valid Access token are refused. Turning this off lets Cloudflare's forwarding headers alone count again."
                : "Off. Turning this on refuses requests through Cloudflare that do not carry a valid Access token; Cloudflare's headers alone are no longer enough."
            }
          />
          {!policy.requireCloudflareAccess && enforceReason && isAdmin && (
            <p className="pl-12 text-label text-text-subtle">Not available yet: {enforceReason}</p>
          )}
          {!policy.requireCloudflareAccess && !enforceReason && isAdmin && unverifiedHere && (
            <Alert variant="warning" title="This session would be refused">
              You came in through Cloudflare, but this request carries no verified Access token. Turning this on would refuse
              this browser, so LambData will not save it. Sign in through Cloudflare Access on your public hostname first, or
              make the change from your local network or tailnet.
            </Alert>
          )}
          <Refusal error={enforce.error} onDismiss={enforce.reset} />
        </div>
        <p className="text-label text-text-subtle">
          Access is an outer gate: people still sign in to LambData afterwards. Create a <Code>Self-hosted</Code> application for
          your public hostname in <strong className="font-medium text-text-muted">Zero Trust → Access → Applications</strong>.
        </p>
      </CardContent>
    </Card>
  );
}
