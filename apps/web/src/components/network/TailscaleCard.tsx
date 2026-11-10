import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ExternalLink, Power, PowerOff } from "lucide-react";
import type { NetworkStatus, NetworkStatusResponse, TailscaleServeRequest } from "@lambdata/shared";
import {
  Alert,
  Badge,
  Button,
  Card,
  CardContent,
  CardFooter,
  CardHeader,
  ConfirmDialog,
  DescriptionItem,
  DescriptionList,
  Field,
  Input,
  Switch,
  toast,
} from "../ui";
import { api } from "../../lib/api";
import { queryKeys } from "../../lib/queries";
import { useNetworkMutation } from "./model";
import { Refusal } from "./parts";

export function TailscaleCard({ status, isAdmin }: { status: NetworkStatus; isAdmin: boolean }) {
  const qc = useQueryClient();
  const ts = status.tailscale;
  const serve = ts.serve;
  const unraid = ts.managedBy === "unraid";
  const [authKey, setAuthKey] = useState("");
  const [confirmDown, setConfirmDown] = useState(false);
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: queryKeys.network });
    void qc.invalidateQueries({ queryKey: queryKeys.tailscale });
  };
  const up = useMutation({
    mutationFn: () => api.post("/tailscale/up", authKey.trim() ? { authKey: authKey.trim() } : {}),
    onSuccess: () => {
      refresh();
      setAuthKey("");
      toast.success("Tailscale is connected");
    },
  });
  const down = useMutation({
    mutationFn: () => api.post("/tailscale/down"),
    onSuccess: () => {
      refresh();
      toast.success("Tailscale is disconnected");
    },
  });
  const setServe = useNetworkMutation((body: TailscaleServeRequest) => api.post<NetworkStatusResponse>("/network/tailscale/serve", body));
  const viaTailnet = status.yourIngress === "tailnet";
  const canControl = isAdmin && !unraid && ts.installed;

  const badge = ts.running ? (
    <Badge variant="success" dot>
      connected
    </Badge>
  ) : ts.installed ? (
    <Badge variant="warn" dot>
      stopped
    </Badge>
  ) : (
    <Badge variant="muted" dot>
      not installed
    </Badge>
  );

  return (
    <Card flush>
      <CardHeader
        divided
        title="This server on your tailnet"
        action={
          <div className="flex flex-wrap items-center gap-1.5">
            {unraid && <Badge variant="muted">managed by Unraid</Badge>}
            {badge}
          </div>
        }
      />
      <CardContent className="space-y-5">
        {ts.installed && (
          <DescriptionList>
            <DescriptionItem term="Hostname" mono>
              {ts.hostname ?? "—"}
            </DescriptionItem>
            <DescriptionItem term="Tailnet IP" mono>
              {ts.tailnetIp ?? "—"}
            </DescriptionItem>
            <DescriptionItem term="HTTPS address" mono>
              {serve.url ? (
                <a className="underline underline-offset-4 [overflow-wrap:anywhere]" href={serve.url} target="_blank" rel="noreferrer">
                  {serve.url}
                </a>
              ) : (
                "—"
              )}
            </DescriptionItem>
          </DescriptionList>
        )}

        {!ts.installed && (
          <p className="text-body text-text-muted">
            Tailscale is not installed on this server. On Unraid 7.2 or newer, enable <strong className="font-medium text-text">Use Tailscale</strong>{" "}
            in the container template. Elsewhere, install it and come back.{" "}
            <a className="inline-flex items-center gap-1 text-text underline underline-offset-4" href="https://tailscale.com/download" target="_blank" rel="noreferrer">
              tailscale.com/download <ExternalLink aria-hidden className="size-3" />
            </a>
          </p>
        )}

        {unraid && (
          <Alert variant="neutral" title="Managed by Unraid">
            Change the hostname, sign-in and Serve in the LambData container template (Use Tailscale, Serve on port {status.bind.port}).
            This page shows what Unraid set up.
          </Alert>
        )}

        {ts.installed && ts.running && (
          <div className="space-y-2">
            <Switch
              checked={serve.enabled}
              disabled={!isAdmin || unraid || !serve.supported || setServe.isPending}
              onCheckedChange={(enabled) => {
                setServe.reset();
                setServe.mutate({ enabled }, { onSuccess: () => toast.success(enabled ? "Serve is on" : "Serve is off") });
              }}
              label="Tailscale Serve"
              description={
                serve.enabled
                  ? `On. The console is published over HTTPS at ${serve.url ?? "your tailnet name"} to devices on your tailnet. Turning this off removes that address.`
                  : "Off. Turning this on publishes the console over HTTPS at this server's tailnet name. Your tailnet needs MagicDNS and HTTPS certificates enabled."
              }
            />
            {!serve.supported && (
              <p className="pl-12 text-label text-text-subtle">This Tailscale version does not report Serve settings.</p>
            )}
            <Refusal error={setServe.error} onDismiss={setServe.reset} />
          </div>
        )}

        {canControl && !ts.running && (
          <Field label="Auth key" hint="Optional. Without one, Tailscale prints a sign-in link in the server log. The key is never logged.">
            <Input
              type="password"
              mono
              autoComplete="off"
              value={authKey}
              onChange={(e) => setAuthKey(e.target.value)}
              placeholder="tskey-auth-…"
            />
          </Field>
        )}

        <Refusal error={up.error ?? down.error} onDismiss={() => { up.reset(); down.reset(); }} />

        <p className="text-label text-text-subtle">
          Never use Tailscale Funnel for the console: it is public, and LambData counts Funnel traffic as the local network.
        </p>
      </CardContent>
      {canControl && (
        <CardFooter>
          {ts.running ? (
            <Button variant="danger-soft" size="sm" loading={down.isPending} onClick={() => setConfirmDown(true)}>
              <PowerOff aria-hidden /> Disconnect
            </Button>
          ) : (
            <Button variant="secondary" size="sm" loading={up.isPending} onClick={() => up.mutate()}>
              <Power aria-hidden /> Connect
            </Button>
          )}
        </CardFooter>
      )}
      <ConfirmDialog
        open={confirmDown}
        onClose={() => setConfirmDown(false)}
        onConfirm={() => {
          setConfirmDown(false);
          down.mutate();
        }}
        tone="danger"
        title="Disconnect from the tailnet?"
        body={
          viaTailnet
            ? "You are connected over the tailnet. Disconnecting cuts off this browser and every client using a tailnet address."
            : "Clients that use a tailnet address, including Serve, lose access until you connect again."
        }
        challenge={viaTailnet ? "disconnect" : undefined}
        confirmLabel="Disconnect"
      />
    </Card>
  );
}
