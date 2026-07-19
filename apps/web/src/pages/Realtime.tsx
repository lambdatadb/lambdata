import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import type { RealtimeStatus } from "@kilndb/shared";
import { api } from "../lib/api";
import { PageHeader } from "../components/layout/PageShell";
import { Badge } from "../components/ui/Badge";
import { Card, CardTitle, SectionLabel } from "../components/ui/Card";
import { CopyableField } from "../components/ui/CopyableField";
import { StatTile } from "../components/ui/StatTile";
import { Table, TBody, TD, TH, THead, TR, TableEmpty, TableSkeleton } from "../components/ui/Table";

export function Realtime() {
  const statusQuery = useQuery({
    queryKey: ["realtime", "status"],
    queryFn: () => api.get<{ status: RealtimeStatus }>("/realtime/status"),
    refetchInterval: 5_000,
  });
  const status = statusQuery.data?.status;
  const origin = typeof window === "undefined" ? "localhost:4317" : window.location.host;
  const protocol = typeof window !== "undefined" && window.location.protocol === "https:" ? "wss" : "ws";
  const wsUrl = `${protocol}://${origin}/api/realtime/v1/websocket?token=<APP_AUTH_TOKEN>`;
  const restUrl = "POST /api/realtime/broadcast";
  const exampleChannel = status?.channels[0]?.name ?? "room:lobby";
  const totalPresence = useMemo(
    () => (status ? status.channels.reduce((sum, channel) => sum + channel.presence, 0) : null),
    [status],
  );

  return (
    <>
      <PageHeader
        title="Realtime"
        subtitle="WebSocket channels for app broadcasts, presence, and Data API table-change events."
      />

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <StatTile label="Connections" value={status?.connections} icon="sensors" />
        <StatTile label="Channels" value={status ? status.channels.length : null} icon="hub" />
        <StatTile label="Presence" value={totalPresence} icon="group" />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_380px] gap-5 mt-5">
        <Card className="p-0 overflow-hidden">
          <div className="p-5 border-b border-border flex items-start justify-between gap-4">
            <div>
              <SectionLabel>Channels</SectionLabel>
              <p className="text-body text-text-muted">
                Clients authenticate with App Auth bearer tokens, subscribe to named channels, and exchange low-latency JSON messages.
              </p>
            </div>
            <Badge tone="accent">WebSocket</Badge>
          </div>

          <Table flush>
            <THead>
              <tr>
                <TH>Channel</TH>
                <TH className="text-right">Subscribers</TH>
                <TH className="text-right">Presence</TH>
              </tr>
            </THead>
            <TBody>
              {statusQuery.isLoading ? (
                <TableSkeleton rows={4} cols={3} />
              ) : !status || status.channels.length === 0 ? (
                <TableEmpty colSpan={3}>
                  No active realtime channels. Subscribe with a WebSocket client or send a REST broadcast to create activity.
                </TableEmpty>
              ) : (
                status.channels.map((channel) => (
                  <TR key={channel.name}>
                    <TD className="font-mono text-label">{channel.name}</TD>
                    <TD numeric className="text-label text-text-muted">{channel.subscribers}</TD>
                    <TD numeric className="text-label text-text-muted">{channel.presence}</TD>
                  </TR>
                ))
              )}
            </TBody>
          </Table>
        </Card>

        <div className="space-y-5">
          <Card>
            <div className="flex items-center justify-between">
              <CardTitle>Connect</CardTitle>
              <Badge tone="accent">App Auth</Badge>
            </div>
            <div className="mt-4 space-y-3">
              <CopyableField label="WebSocket" value={wsUrl} />
              <CopyableField label="Broadcast REST" value={restUrl} />
              <CopyableField label="Table channel" value="db:<database>:table:<table>" />
            </div>
          </Card>

          <Card>
            <SectionLabel>Client messages</SectionLabel>
            <pre className="text-label leading-relaxed font-mono text-text-muted whitespace-pre-wrap rounded-md bg-bg border border-border p-3 overflow-x-auto">
{`{ "type": "subscribe", "channel": "${exampleChannel}" }
{ "type": "broadcast", "channel": "${exampleChannel}", "event": "message", "payload": { "text": "hello" } }
{ "type": "presence", "channel": "${exampleChannel}", "state": { "online": true } }`}
            </pre>
          </Card>

          <Card>
            <SectionLabel>REST broadcast</SectionLabel>
            <pre className="text-label leading-relaxed font-mono text-text-muted whitespace-pre-wrap rounded-md bg-bg border border-border p-3 overflow-x-auto">
{`{
  "messages": [
    {
      "channel": "${exampleChannel}",
      "event": "kilndb.demo",
      "payload": { "ok": true }
    }
  ]
}`}
            </pre>
          </Card>
        </div>
      </div>
    </>
  );
}
