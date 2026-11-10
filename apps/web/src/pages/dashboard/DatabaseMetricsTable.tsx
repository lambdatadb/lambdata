import { Link } from "react-router-dom";
import { ArrowRight, Database as DatabaseIcon, Plus } from "lucide-react";
import type { DashboardSummary } from "@lambdata/shared";
import { Badge } from "../../components/ui/Badge";
import { Button } from "../../components/ui/Button";
import { Card, CardHeader } from "../../components/ui/Card";
import { EmptyState } from "../../components/ui/EmptyState";
import { Table, TBody, TD, TH, THead, TR, TableSkeleton } from "../../components/ui/Table";
import { databasePath } from "../../lib/commands";
import { formatBytes, formatNumber, formatRelativeTime } from "../../lib/format";

interface Props {
  summary: DashboardSummary | undefined;
  loading: boolean;
  onCreate?: () => void;
}

export function DatabaseMetricsTable({ summary, loading, onCreate }: Props) {
  const rows = [...(summary?.latestMetrics ?? [])].sort((a, b) => (b.sizeBytes ?? 0) - (a.sizeBytes ?? 0));
  return (
    <Card flush>
      <CardHeader
        divided
        title="Databases"
        description="Latest sample per database."
        action={
          rows.length > 0 ? (
            <Button asChild variant="ghost" size="sm">
              <Link to="/databases">
                View all <ArrowRight />
              </Link>
            </Button>
          ) : undefined
        }
      />
      {!loading && rows.length === 0 ? (
        <EmptyState
          variant="bare"
          icon={DatabaseIcon}
          title="No databases yet"
          description="Provision one to start tracking size, tables and connections."
          action={
            onCreate ? (
              <Button size="sm" variant="secondary" onClick={onCreate}>
                <Plus /> New database
              </Button>
            ) : undefined
          }
        />
      ) : (
        <Table flush caption="Database metrics">
          <THead>
            <TR>
              <TH>Name</TH>
              <TH className="hidden sm:table-cell">Kind</TH>
              <TH numeric>Size</TH>
              <TH numeric className="hidden md:table-cell">
                Tables
              </TH>
              <TH numeric className="hidden md:table-cell">
                Connections
              </TH>
              <TH className="hidden lg:table-cell">Sampled</TH>
            </TR>
          </THead>
          <TBody>
            {loading ? (
              <TableSkeleton rows={3} cols={6} />
            ) : (
              rows.map((m) => (
                <TR key={m.databaseId} interactive>
                  <TD>
                    <Link
                      to={databasePath(m.databaseId)}
                      className="stretched-link block truncate font-medium text-text outline-none focus-visible:underline focus-visible:decoration-accent focus-visible:underline-offset-4"
                    >
                      {m.displayName}
                    </Link>
                    <div className="truncate font-mono text-micro text-text-subtle">{m.name}</div>
                  </TD>
                  <TD className="hidden sm:table-cell">
                    <Badge variant={m.kind === "mirror" ? "info" : "muted"} size="sm">
                      {m.kind}
                    </Badge>
                  </TD>
                  <TD numeric>{formatBytes(m.sizeBytes)}</TD>
                  <TD numeric className="hidden md:table-cell">
                    {formatNumber(m.tableCount)}
                  </TD>
                  <TD numeric className="hidden md:table-cell">
                    {formatNumber(m.connectionCount)}
                  </TD>
                  <TD className="hidden whitespace-nowrap text-text-muted lg:table-cell">
                    {m.collectedAt ? formatRelativeTime(m.collectedAt) : "not yet"}
                  </TD>
                </TR>
              ))
            )}
          </TBody>
        </Table>
      )}
    </Card>
  );
}
