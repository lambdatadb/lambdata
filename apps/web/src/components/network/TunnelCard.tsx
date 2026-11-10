import { useState, type ReactNode } from "react";
import { ChevronDown, CloudOff, Container, Play, Server, Square } from "lucide-react";
import type { CloudflareTunnelMode, NetworkStatus, NetworkStatusResponse, UpdateCloudflareTunnelRequest } from "@lambdata/shared";
import {
  Alert,
  Badge,
  Button,
  Card,
  CardContent,
  CardFooter,
  CardHeader,
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
  DescriptionItem,
  DescriptionList,
  Field,
  Input,
  RadioCard,
  RadioGroup,
  toast,
} from "../ui";
import { api } from "../../lib/api";
import { formatRelativeTime } from "../../lib/format";
import { TUNNEL_PHASES } from "../../lib/network";
import { tunnelPhase, useNetworkMutation } from "./model";
import { Code, Refusal, Steps } from "./parts";

const MODES: { value: CloudflareTunnelMode; title: string; description: string; icon: ReactNode }[] = [
  { value: "off", title: "Off", description: "No Cloudflare Tunnel.", icon: <CloudOff /> },
  { value: "managed", title: "Managed here", description: "LambData runs cloudflared for you.", icon: <Server /> },
  { value: "external", title: "Running elsewhere", description: "Your own cloudflared, e.g. its own container.", icon: <Container /> },
];

export function TunnelCard({ status, isAdmin }: { status: NetworkStatus; isAdmin: boolean }) {
  const tunnel = status.cloudflare.tunnel;
  const phase = tunnelPhase(tunnel);
  const [mode, setMode] = useState<CloudflareTunnelMode | null>(null);
  const [token, setToken] = useState("");
  const [replacing, setReplacing] = useState(false);
  const [guideOpen, setGuideOpen] = useState(phase === "off" || phase === "no-token");
  const chosen = mode ?? tunnel.mode;
  const modeChanged = chosen !== tunnel.mode;
  const tokenEntered = token.trim() !== "";
  const showTokenInput = chosen === "managed" && (!tunnel.tokenConfigured || replacing);

  const save = useNetworkMutation((body: UpdateCloudflareTunnelRequest) => api.put<NetworkStatusResponse>("/network/cloudflare/tunnel", body));
  const start = useNetworkMutation(() => api.post<NetworkStatusResponse>("/network/cloudflare/tunnel/start"));
  const stop = useNetworkMutation(() => api.post<NetworkStatusResponse>("/network/cloudflare/tunnel/stop"));
  const lastError = save.error ?? start.error ?? stop.error;
  const busy = save.isPending || start.isPending || stop.isPending;

  const reset = () => {
    save.reset();
    start.reset();
    stop.reset();
  };

  const submit = () => {
    reset();
    const body: UpdateCloudflareTunnelRequest = { mode: chosen };
    if (chosen === "managed" && tokenEntered) body.token = token.trim();
    save.mutate(body, {
      onSuccess: () => {
        setMode(null);
        setToken("");
        setReplacing(false);
        toast.success(body.token ? "Tunnel token saved" : "Tunnel mode saved");
      },
    });
  };

  const consoleTarget = `http://localhost:${status.bind.port}`;
  const publicExample = status.publicUrls[0] ?? "https://db.example.com";

  return (
    <Card flush>
      <CardHeader
        divided
        title="How the tunnel runs"
        action={
          <Badge variant={TUNNEL_PHASES[phase].tone} dot>
            {TUNNEL_PHASES[phase].badge}
          </Badge>
        }
      />
      <CardContent className="space-y-5">
        <RadioGroup
          value={chosen}
          onValueChange={(v) => {
            reset();
            setMode(v as CloudflareTunnelMode);
          }}
          aria-label="Tunnel mode"
          className="grid gap-2.5 sm:grid-cols-3"
          disabled={!isAdmin || busy}
        >
          {MODES.map((m) => (
            <RadioCard key={m.value} value={m.value} icon={m.icon} title={m.title} description={m.description} layout="inline" />
          ))}
        </RadioGroup>

        <Refusal error={lastError} onDismiss={reset} />

        {chosen === "managed" && !tunnel.installed && (
          <Alert variant="warning" title="cloudflared is not installed on this server">
            The LambData Docker image includes it. On other systems install cloudflared from Cloudflare, then reload this page.
            You can still save the token now.
          </Alert>
        )}

        {chosen === "managed" && isAdmin && (
          <div className="space-y-2">
            {tunnel.tokenConfigured && !replacing ? (
              <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-border bg-bg-inset px-3 py-2.5">
                <div className="flex items-center gap-2 text-body text-text">
                  Tunnel token
                  <Badge variant="success" size="sm">
                    configured
                  </Badge>
                </div>
                <Button variant="ghost" size="xs" onClick={() => setReplacing(true)} disabled={busy}>
                  Replace token
                </Button>
              </div>
            ) : null}
            {showTokenInput && (
              <Field
                label={tunnel.tokenConfigured ? "New tunnel token" : "Tunnel token"}
                hint="Paste the token, or the whole install command from Cloudflare. It is stored encrypted and never shown again."
              >
                <Input
                  type="password"
                  mono
                  autoComplete="off"
                  spellCheck={false}
                  value={token}
                  onChange={(e) => setToken(e.target.value)}
                  placeholder="eyJhIjoi…"
                />
              </Field>
            )}
          </div>
        )}

        {chosen === "external" && (
          <p className="text-body text-text-muted">
            Point your cloudflared's public hostname at this server, for example <Code>http://lambdata:{status.bind.port}</Code> on
            a shared Docker network. Then open the console through the tunnel and check step 1: if it says local network,
            add the address shown there under <strong className="font-medium text-text">Trusted proxies</strong> below.
          </p>
        )}

        {tunnel.mode === "managed" && chosen === "managed" && (
          <DescriptionList>
            <DescriptionItem term="State">{TUNNEL_PHASES[phase].state}</DescriptionItem>
            <DescriptionItem term="Connections" mono>
              {tunnel.connections ?? "—"}
            </DescriptionItem>
            <DescriptionItem term="Running since">{tunnel.startedAt ? formatRelativeTime(tunnel.startedAt) : "—"}</DescriptionItem>
            <DescriptionItem term="cloudflared" mono>
              {tunnel.installed ? (tunnel.version ?? "installed") : "not installed"}
            </DescriptionItem>
          </DescriptionList>
        )}

        {tunnel.mode === "managed" && tunnel.lastError && (
          <Alert variant="danger" title="cloudflared reported a problem">
            <span className="font-mono text-code [overflow-wrap:anywhere]">{tunnel.lastError}</span>
            {/unauthorized|invalid tunnel secret|token/i.test(tunnel.lastError) && (
              <span className="mt-1 block">
                Cloudflare did not accept the token. Copy it again from the tunnel's page in Zero Trust and use Replace token.
              </span>
            )}
            <span className="mt-1 block">
              Full log: <Code>logs/cloudflared.log</Code> in the data directory.
            </span>
          </Alert>
        )}

        <Collapsible open={guideOpen} onOpenChange={setGuideOpen}>
          <CollapsibleTrigger asChild>
            <Button variant="ghost" size="sm" className="-ml-2" aria-expanded={guideOpen}>
              <ChevronDown aria-hidden className={guideOpen ? "rotate-180 transition-transform" : "transition-transform"} />
              Set it up in Cloudflare
            </Button>
          </CollapsibleTrigger>
          <CollapsibleContent>
            <Steps
              className="pt-3"
              items={[
                <>
                  In the Cloudflare dashboard open <strong>Zero Trust → Networks → Tunnels</strong> and create a tunnel of type{" "}
                  <strong>Cloudflared</strong>.
                </>,
                chosen === "external" ? (
                  <>Run the connector the way you already do, for example as its own container.</>
                ) : (
                  <>
                    Copy its token. Copying the whole install command is fine; LambData picks the token out of it.
                  </>
                ),
                <>
                  Add a <strong>public hostname</strong> such as <Code>{publicExample.replace(/^https?:\/\//, "")}</Code> with
                  service{" "}
                  <Code>{chosen === "external" ? `http://<lambdata address>:${status.bind.port}` : consoleTarget}</Code>.
                </>,
                chosen === "external" ? (
                  <>Choose <strong>Running elsewhere</strong> here and add the public URL and trusted proxy below.</>
                ) : (
                  <>
                    Choose <strong>Managed here</strong>, paste the token, save, then <strong>Start</strong>. Add the public URL
                    below.
                  </>
                ),
                <>Protect the hostname with Cloudflare Access in step 4 before you turn off the local network.</>,
              ]}
            />
          </CollapsibleContent>
        </Collapsible>
      </CardContent>

      {isAdmin && (tunnel.mode === "managed" || modeChanged || tokenEntered || replacing) && (
        <CardFooter>
          {tunnel.mode === "managed" && !modeChanged && (
            <div className="mr-auto flex gap-2">
              {tunnel.running || phase === "retrying" ? (
                <Button
                  variant="danger-soft"
                  size="sm"
                  loading={stop.isPending}
                  disabled={busy}
                  onClick={() => {
                    reset();
                    stop.mutate(undefined);
                  }}
                >
                  <Square aria-hidden /> Stop
                </Button>
              ) : null}
              {!tunnel.running && (
                <Button
                  variant="secondary"
                  size="sm"
                  loading={start.isPending}
                  disabled={busy || !tunnel.installed || !tunnel.tokenConfigured || tokenEntered}
                  onClick={() => {
                    reset();
                    start.mutate(undefined, { onSuccess: () => toast.success("Tunnel starting") });
                  }}
                >
                  <Play aria-hidden /> {phase === "failed" ? "Restart" : "Start"}
                </Button>
              )}
            </div>
          )}
          {(modeChanged || tokenEntered || replacing) && (
            <>
              <Button
                variant="ghost"
                size="sm"
                disabled={busy}
                onClick={() => {
                  setMode(null);
                  setToken("");
                  setReplacing(false);
                  reset();
                }}
              >
                Cancel
              </Button>
              <Button
                size="sm"
                onClick={submit}
                loading={save.isPending}
                disabled={busy || (!modeChanged && !tokenEntered) || (chosen === "managed" && !tunnel.tokenConfigured && !tokenEntered)}
              >
                Save
              </Button>
            </>
          )}
        </CardFooter>
      )}
    </Card>
  );
}
