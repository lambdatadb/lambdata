import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { TailscaleStatus } from "@kilndb/shared";
import { api, ApiError } from "../lib/api";
import { useAuth } from "../lib/auth";
import { PageHeader } from "../components/layout/PageShell";
import { Card, CardTitle } from "../components/ui/Card";
import { Button } from "../components/ui/Button";
import { Field, Input } from "../components/ui/Input";
import { Badge } from "../components/ui/Badge";
import { SkeletonRows } from "../components/ui/Skeleton";
import { useToast } from "../components/ui/Toast";

export function Tailscale() {
  const qc = useQueryClient();
  const toast = useToast();
  const { user } = useAuth();
  const [authKey, setAuthKey] = useState("");
  const { data, isLoading } = useQuery({
    queryKey: ["tailscale", "status"],
    queryFn: () => api.get<TailscaleStatus>("/tailscale/status"),
    refetchInterval: 10_000,
  });

  const up = useMutation({
    mutationFn: () => api.post("/tailscale/up", authKey ? { authKey } : {}),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["tailscale", "status"] });
      toast.show("Tailnet up", "success");
      setAuthKey("");
    },
    onError: (e) => toast.show(e instanceof ApiError ? e.message : "tailscale up failed", "error"),
  });
  const down = useMutation({
    mutationFn: () => api.post("/tailscale/down"),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["tailscale", "status"] });
      toast.show("Tailnet down", "success");
    },
  });

  return (
    <>
      <PageHeader title="Tailscale" subtitle="Optionally expose databases over your tailnet." />
      <Card>
        <div className="flex items-center justify-between mb-2">
          <CardTitle>Status</CardTitle>
          {!isLoading && data && (
            data.running ? (
              <Badge tone="success">Running</Badge>
            ) : data.installed ? (
              <Badge tone="warn">Installed · stopped</Badge>
            ) : (
              <Badge tone="muted">Not installed</Badge>
            )
          )}
        </div>
        {isLoading ? (
          <SkeletonRows rows={2} />
        ) : data ? (
          <dl className="grid grid-cols-2 gap-y-2 text-body">
            <dt className="text-text-muted">Hostname</dt>
            <dd className="font-mono">{data.hostname ?? "—"}</dd>
            <dt className="text-text-muted">Tailnet IP</dt>
            <dd className="font-mono">{data.tailnetIp ?? "—"}</dd>
          </dl>
        ) : null}
        {user?.role === "admin" && (
          <div className="mt-5 pt-5 border-t border-border space-y-3">
            {data?.installed && !data.running && (
              <>
                <Field label="Auth key (optional)" hint="Leave blank to use the browser flow">
                  <Input value={authKey} onChange={(e) => setAuthKey(e.target.value)} placeholder="tskey-auth-..." />
                </Field>
                <Button loading={up.isPending} onClick={() => up.mutate()}>Bring up</Button>
              </>
            )}
            {data?.running && (
              <Button variant="secondary" loading={down.isPending} onClick={() => down.mutate()}>
                Bring down
              </Button>
            )}
            {!data?.installed && (
              <p className="text-body text-text-muted">
                Install Tailscale on this host (<a className="text-accent" href="https://tailscale.com/download">tailscale.com/download</a>),
                then come back.
              </p>
            )}
          </div>
        )}
      </Card>
    </>
  );
}
