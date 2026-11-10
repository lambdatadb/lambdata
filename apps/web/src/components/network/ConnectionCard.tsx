import { LifeBuoy } from "lucide-react";
import type { IngressKind, NetworkStatus } from "@lambdata/shared";
import { Alert, Badge, Card, CardContent, CopyButton, StatusDot, cn, type StatusTone } from "../ui";
import { INGRESS } from "./model";
import { Code } from "./parts";

const ORDER: IngressKind[] = ["lan", "tailnet", "cloudflare", "loopback"];

function verdict(status: NetworkStatus, kind: IngressKind): { tone: StatusTone; text: string } {
  const p = status.policy;
  if (kind === "loopback") return { tone: "success", text: "Always allowed" };
  if (kind === "lan") return p.allowLan ? { tone: "success", text: "Allowed" } : { tone: "danger", text: "Refused" };
  if (kind === "tailnet") return p.allowTailnet ? { tone: "success", text: "Allowed" } : { tone: "danger", text: "Refused" };
  if (!p.allowCloudflare) return { tone: "danger", text: "Refused" };
  return p.requireCloudflareAccess ? { tone: "success", text: "Access required" } : { tone: "success", text: "Allowed" };
}

export function ConnectionCard({ status }: { status: NetworkStatus }) {
  const here = INGRESS[status.yourIngress];
  const Icon = here.icon;
  return (
    <Card flush>
      {status.policyLockedByEnv && (
        <Alert variant="warning" title="The policy is forced open" className="rounded-none border-x-0 border-t-0">
          <Code>LAMBDATA_ACCESS_POLICY=open</Code> is set, so every connection is allowed and the policy cannot be edited. Remove
          the variable and restart LambData to apply a policy again.
        </Alert>
      )}
      <CardContent className="space-y-5 py-5">
        <div className="flex min-w-0 items-start gap-4">
          <div className="grid size-11 shrink-0 place-items-center rounded-lg border border-accent/30 bg-accent/[0.06] text-accent">
            <Icon aria-hidden className="size-5" />
          </div>
          <div className="min-w-0 space-y-1">
            <p className="text-heading font-semibold text-text">
              You are connected via {here.phrase}
            </p>
            <p className="text-body text-text-muted">
              from <span className="font-mono text-code text-text [overflow-wrap:anywhere]">{status.yourIp}</span>
              {status.yourIngress === "loopback" && ". Requests made on the server itself are always let in."}
            </p>
          </div>
        </div>

        <ul className="grid grid-cols-2 gap-2 sm:grid-cols-4" aria-label="Ways in and what the policy does with them">
          {ORDER.map((kind) => {
            const meta = INGRESS[kind];
            const v = verdict(status, kind);
            const you = kind === status.yourIngress;
            const KindIcon = meta.icon;
            return (
              <li
                key={kind}
                className={cn(
                  "min-w-0 rounded-md border px-3 py-2.5",
                  you ? "border-accent/45 bg-accent/[0.035]" : "border-border bg-bg-inset",
                )}
              >
                <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1">
                  <span className="flex min-w-0 items-center gap-1.5 text-label font-medium text-text">
                    <KindIcon aria-hidden className="size-3.5 shrink-0 text-text-muted" />
                    {meta.label}
                  </span>
                  {you && (
                    <Badge size="sm" variant="accent">
                      you
                    </Badge>
                  )}
                </div>
                <div className="mt-1.5 flex items-center gap-1.5 text-label text-text-muted">
                  <StatusDot tone={v.tone} />
                  {v.text}
                </div>
              </li>
            );
          })}
        </ul>

        <div className="flex items-start gap-3 rounded-md border border-border bg-bg-inset px-4 py-3">
          <LifeBuoy aria-hidden className="mt-0.5 size-4 shrink-0 text-text-muted" />
          <div className="min-w-0 flex-1 space-y-1.5 text-body text-text-muted">
            <p className="font-medium text-text">If a change locks you out</p>
            <p>
              Set <Code>LAMBDATA_ACCESS_POLICY=open</Code> on the container (on Unraid: Edit, Show more settings, Access Policy
              Recovery) and restart it. LambData resets the policy to allow every connection. Requests made on the server
              itself, such as <Code>docker exec</Code>, always get in.
            </p>
          </div>
          <CopyButton value="LAMBDATA_ACCESS_POLICY=open" label="recovery variable" size="icon-xs" className="shrink-0" />
        </div>
      </CardContent>
    </Card>
  );
}
