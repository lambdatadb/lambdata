import { useQuery } from "@tanstack/react-query";
import type { RealtimeStatus } from "@lambdata/shared";
import { Cable, MessagesSquare, RadioTower, RotateCcw, Users } from "lucide-react";
import { api, absoluteUrl, errorMessage } from "../lib/api";
import { PageHeader } from "../components/layout/PageShell";
import {
  Alert,
  Button,
  Card,
  CardContent,
  CardHeader,
  CodeBlock,
  CopyableField,
  EmptyState,
  StatTile,
  StatusDot,
  TBody,
  TD,
  TH,
  THead,
  TR,
  Table,
  TableSkeleton,
} from "../components/ui";
import { pollEvery } from "../lib/queries";

export function Realtime() {
  const statusQuery = useQuery({
    queryKey: ["realtime", "status"],
    queryFn: () => api.get<{ status: RealtimeStatus }>("/realtime/status"),
    refetchInterval: pollEvery(5_000),
  });
  const status = statusQuery.data?.status;
  const channels = status?.channels ?? [];
  const loading = statusQuery.isPending;
  const secure = typeof window !== "undefined" && window.location.protocol === "https:";
  const host = typeof window !== "undefined" ? window.location.host : "localhost";
  const wsUrl = `${secure ? "wss" : "ws"}://${host}/api/realtime/v1/websocket?token=$ACCESS_TOKEN`;
  const broadcastUrl = absoluteUrl("/api/realtime/broadcast");
  const channel = channels[0]?.name ?? "room:lobby";
  const presence = status ? channels.reduce((sum, c) => sum + c.presence, 0) : null;

  return (
    <>
      <PageHeader
        title="Realtime"
        subtitle="WebSocket channels for broadcasts, presence and Data API change events. Clients sign in with App Auth tokens."
        actions={
          statusQuery.isError ? (
            <span className="inline-flex items-center gap-2 text-label text-text-muted">
              <StatusDot tone="danger" /> Status unavailable
            </span>
          ) : status ? (
            <span className="inline-flex items-center gap-2 text-label text-text-muted">
              <StatusDot tone="success" pulse /> Live, refreshes every 5 s
            </span>
          ) : undefined
        }
      />
      <div className="space-y-5">
        {statusQuery.isError && (
          <Alert
            variant="danger"
            title="Could not read realtime status"
            action={
              <Button size="xs" variant="secondary" onClick={() => statusQuery.refetch()}>
                <RotateCcw aria-hidden /> Retry
              </Button>
            }
          >
            {errorMessage(statusQuery.error, "The server did not answer.")}
          </Alert>
        )}
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <StatTile label="Connections" icon={Cable} loading={loading} value={status?.connections ?? null} />
          <StatTile label="Channels" icon={RadioTower} loading={loading} value={status ? channels.length : null} />
          <StatTile label="Presence" icon={Users} loading={loading} value={presence} />
          <StatTile label="Messages sent" icon={MessagesSquare} loading={loading} value={status?.messagesSent ?? null} />
        </div>

        <div className="grid grid-cols-1 items-start gap-5 xl:grid-cols-[minmax(0,1fr)_24rem]">
          <Card flush>
            <CardHeader
              divided
              title="Active channels"
              description="Channels exist while at least one client is subscribed."
            />
            {statusQuery.isError ? (
              <EmptyState
                variant="bare"
                size="sm"
                icon={RadioTower}
                title="Channels unavailable"
                description="The status request failed. Retry from the message above."
              />
            ) : !loading && channels.length === 0 ? (
              <EmptyState
                variant="bare"
                icon={RadioTower}
                title="No active channels"
                description="Subscribe from a WebSocket client or send a REST broadcast, and the channel shows up here."
              />
            ) : (
              <Table flush caption="Active channels">
                <THead>
                  <TR>
                    <TH>Channel</TH>
                    <TH numeric>Subscribers</TH>
                    <TH numeric className="hidden sm:table-cell">
                      Presence
                    </TH>
                  </TR>
                </THead>
                <TBody>
                  {loading ? (
                    <TableSkeleton rows={3} cols={3} />
                  ) : (
                    channels.map((c) => (
                      <TR key={c.name}>
                        <TD mono className="text-text">
                          {c.name}
                        </TD>
                        <TD numeric>{c.subscribers}</TD>
                        <TD numeric className="hidden text-text-muted sm:table-cell">
                          {c.presence}
                        </TD>
                      </TR>
                    ))
                  )}
                </TBody>
              </Table>
            )}
          </Card>

          <Card>
            <CardHeader title="Connect" description="Pass an App Auth access token; console sessions are not accepted." />
            <div className="space-y-4">
              <CopyableField label="WebSocket" value={wsUrl} copyLabel="WebSocket URL" />
              <CopyableField label="REST broadcast" value={broadcastUrl} copyLabel="broadcast URL" />
              <CopyableField label="Table change channel" value="db:<database>:table:<table>" copyLabel="table channel pattern" />
            </div>
          </Card>
        </div>

        <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
          <Card flush>
            <CardHeader title="Client messages" description="Send these JSON frames over the socket." />
            <CardContent className="pt-0">
              <CodeBlock
                language="json"
                wrap
                code={`{ "type": "subscribe", "channel": "${channel}" }
{ "type": "broadcast", "channel": "${channel}", "event": "message", "payload": { "text": "hello" } }
{ "type": "presence", "channel": "${channel}", "state": { "online": true } }`}
              />
            </CardContent>
          </Card>
          <Card flush>
            <CardHeader title="Broadcast over REST" description="Up to 100 messages per request, from a server or a script." />
            <CardContent className="pt-0">
              <CodeBlock
                language="shell"
                wrap
                code={`curl -X POST "${broadcastUrl}" \\
  -H "Authorization: Bearer $ACCESS_TOKEN" \\
  -H "Content-Type: application/json" \\
  --data '{"messages":[{"channel":"${channel}","event":"lambdata.demo","payload":{"ok":true}}]}'`}
              />
            </CardContent>
          </Card>
        </div>
      </div>
    </>
  );
}
