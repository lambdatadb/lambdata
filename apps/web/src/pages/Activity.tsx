import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";
import { PageHeader } from "../components/layout/PageShell";
import { Badge } from "../components/ui/Badge";
import { Card } from "../components/ui/Card";
import { Table, TBody, TD, TH, THead, TR, TableEmpty, TableSkeleton } from "../components/ui/Table";
import { formatRelativeTime } from "../lib/format";

interface AuditLog {
  id: number;
  user_id: string | null;
  user_email: string | null;
  user_display_name: string | null;
  action: string;
  target: string | null;
  details: string | null;
  at: number;
}

export function Activity() {
  const { data, isLoading } = useQuery({
    queryKey: ["audit-logs"],
    queryFn: () => api.get<{ logs: AuditLog[] }>("/system/audit-logs?limit=100"),
    refetchInterval: 10_000,
  });

  const list = data?.logs ?? [];

  return (
    <>
      <PageHeader title="Activity Log" subtitle="Audit trail of events executed on this KilnDB instance." />

      <Card className="p-0 overflow-hidden">
        <Table flush>
          <THead>
            <tr>
              <TH>User</TH>
              <TH>Action</TH>
              <TH>Target</TH>
              <TH>Details</TH>
              <TH className="text-right">Time</TH>
            </tr>
          </THead>
          <TBody>
            {isLoading ? (
              <TableSkeleton rows={6} cols={5} />
            ) : list.length === 0 ? (
              <TableEmpty colSpan={5}>No activity recorded yet.</TableEmpty>
            ) : (
              list.map((log) => {
                let parsedDetails = "";
                if (log.details) {
                  try {
                    parsedDetails = JSON.stringify(JSON.parse(log.details));
                  } catch {
                    parsedDetails = log.details;
                  }
                }
                return (
                  <TR key={log.id}>
                    <TD className="whitespace-nowrap">
                      <div className="flex items-center gap-2">
                        <div className="size-5 rounded-full bg-accent/10 border border-accent/30 flex items-center justify-center text-micro text-accent font-semibold">
                          {(log.user_display_name ?? log.user_email ?? "S")[0]?.toUpperCase()}
                        </div>
                        <div>
                          <div className="text-label font-medium text-text">{log.user_display_name ?? "System"}</div>
                          {log.user_email && <div className="text-micro text-text-subtle">{log.user_email}</div>}
                        </div>
                      </div>
                    </TD>
                    <TD className="whitespace-nowrap">
                      <Badge tone="muted" className="font-mono">{log.action.replace(/\./g, " · ")}</Badge>
                    </TD>
                    <TD className="font-mono text-label text-text-muted whitespace-nowrap">
                      {log.target ?? "—"}
                    </TD>
                    <TD className="max-w-xs truncate font-mono text-label text-text-subtle" title={parsedDetails}>
                      {parsedDetails || "—"}
                    </TD>
                    <TD className="text-right text-label text-text-subtle whitespace-nowrap">
                      {formatRelativeTime(log.at)}
                    </TD>
                  </TR>
                );
              })
            )}
          </TBody>
        </Table>
      </Card>
    </>
  );
}
