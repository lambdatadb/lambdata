import { useState } from "react";
import { Undo2 } from "lucide-react";
import type { AccessPolicy, NetworkStatus } from "@lambdata/shared";
import { Alert, Badge, Button, Card, CardContent, CardFooter, Switch, toast } from "../ui";
import { INGRESS, SWITCH_INGRESS, blocksIngress, putPolicy, useNetworkMutation, type PolicySwitch } from "./model";
import { Refusal } from "./parts";

const COPY: Record<PolicySwitch, { label: string; on: string; off: string }> = {
  allowLan: {
    label: "Local network (LAN)",
    on: "Allowed. Turning this off refuses every connection from your local network, including a port you forwarded on your router.",
    off: "Refused. Turning this on lets anyone who can reach this server on your network open the sign-in page.",
  },
  allowTailnet: {
    label: "Tailnet",
    on: "Allowed. Turning this off refuses devices on your tailnet, including Tailscale Serve.",
    off: "Refused. Turning this on lets devices on your tailnet open the sign-in page.",
  },
  allowCloudflare: {
    label: "Cloudflare",
    on: "Allowed. Turning this off refuses everything that arrives through a Cloudflare Tunnel.",
    off: "Refused. Turning this on accepts requests that arrive through your Cloudflare Tunnel.",
  },
};

const APP_COPY = {
  on: "Apps follow the switches above too. Turning this off lets your apps reach the Data API, App Auth, functions, realtime and public files from anywhere again.",
  off: "Apps keep working from anywhere: the Data API, App Auth, functions, realtime and public files ignore the switches above. Turning this on applies them to apps as well.",
};

const SWITCHES: PolicySwitch[] = ["allowLan", "allowTailnet", "allowCloudflare"];

export function PolicyCard({ status, isAdmin }: { status: NetworkStatus; isAdmin: boolean }) {
  const server = status.policy;
  const [changes, setChanges] = useState<Partial<AccessPolicy>>({});
  const draft: AccessPolicy = { ...server, ...changes };
  const dirty = (Object.keys(changes) as (keyof AccessPolicy)[]).some((k) => changes[k] !== server[k]);
  const save = useNetworkMutation(putPolicy);
  const locked = status.policyLockedByEnv;
  const editable = isAdmin && !locked;
  const here = status.yourIngress;
  const wouldBlockYou = blocksIngress(draft, here);
  const nothingRemote = !draft.allowLan && !draft.allowTailnet && !draft.allowCloudflare;

  const set = (key: keyof AccessPolicy, value: boolean) => {
    save.reset();
    setChanges((c) => ({ ...c, [key]: value }));
  };

  const submit = () => {
    save.mutate(
      { ...draft, requireCloudflareAccess: server.requireCloudflareAccess },
      {
        onSuccess: () => {
          setChanges({});
          toast.success("Access policy saved");
        },
      },
    );
  };

  return (
    <Card flush>
      <CardContent className="divide-y divide-border py-0">
        {SWITCHES.map((key) => {
          const copy = COPY[key];
          const yours = SWITCH_INGRESS[key] === here;
          const changed = changes[key] !== undefined && changes[key] !== server[key];
          return (
            <div key={key} className="py-4">
              <Switch
                checked={draft[key]}
                disabled={!editable || save.isPending}
                onCheckedChange={(v) => set(key, v)}
                label={
                  <span className="inline-flex flex-wrap items-center gap-2">
                    {copy.label}
                    {yours && (
                      <Badge size="sm" variant="accent">
                        your connection
                      </Badge>
                    )}
                    {changed && (
                      <Badge size="sm" variant="warn">
                        unsaved
                      </Badge>
                    )}
                  </span>
                }
                description={draft[key] ? copy.on : copy.off}
              />
            </div>
          );
        })}
        <div className="py-4">
          <Switch
            checked={draft.restrictAppApis}
            disabled={!editable || save.isPending}
            onCheckedChange={(v) => set("restrictAppApis", v)}
            label={
              <span className="inline-flex flex-wrap items-center gap-2">
                Also restrict app-facing APIs
                {changes.restrictAppApis !== undefined && changes.restrictAppApis !== server.restrictAppApis && (
                  <Badge size="sm" variant="warn">
                    unsaved
                  </Badge>
                )}
              </span>
            }
            description={draft.restrictAppApis ? APP_COPY.on : APP_COPY.off}
          />
        </div>
        <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 py-4">
          <span className="text-body font-medium text-text">Require Cloudflare Access</span>
          <span className="text-label text-text-muted">
            {server.requireCloudflareAccess ? "On: " : "Off: "}
            <button
              type="button"
              className="text-text underline underline-offset-4 hover:decoration-accent"
              onClick={() => document.getElementById("cloudflare-access")?.scrollIntoView({ behavior: "smooth", block: "start" })}
            >
              set in step 4
            </button>{" "}
            after testing your session
          </span>
        </div>
      </CardContent>

      {editable && (dirty || save.error) ? (
        <div className="space-y-3 border-t border-border px-5 py-4">
          {dirty && wouldBlockYou && !save.error && (
            <Alert variant="warning" title={`This blocks the connection you are using`}>
              You are on {INGRESS[here].phrase}. LambData will refuse to save this. Make the change from a connection the new
              policy allows, or keep {INGRESS[here].label} on.
            </Alert>
          )}
          {dirty && nothingRemote && !wouldBlockYou && (
            <Alert variant="warning" title="Only the server itself could reach the console">
              Every remote way in would be refused. Make sure you can run commands on the server before saving this.
            </Alert>
          )}
          <Refusal error={save.error} onDismiss={save.reset} />
        </div>
      ) : null}

      {editable && (
        <CardFooter>
          <span className="mr-auto text-label text-text-muted">
            {dirty ? "Changes take effect for every request as soon as you save." : "No unsaved changes."}
          </span>
          {dirty && (
            <Button
              variant="ghost"
              size="sm"
              disabled={save.isPending}
              onClick={() => {
                setChanges({});
                save.reset();
              }}
            >
              <Undo2 aria-hidden /> Discard
            </Button>
          )}
          <Button size="sm" onClick={submit} disabled={!dirty} loading={save.isPending}>
            Save policy
          </Button>
        </CardFooter>
      )}
    </Card>
  );
}
