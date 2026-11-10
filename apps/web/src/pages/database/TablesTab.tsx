import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Table2 } from "lucide-react";
import type { TableBreakdownEntry } from "@lambdata/shared";
import { QueryError } from "../../components/layout/QueryError";
import { Card, CardHeader } from "../../components/ui/Card";
import { EmptyState } from "../../components/ui/EmptyState";
import { Table, TBody, TD, TFoot, TH, THead, TR, TableSkeleton } from "../../components/ui/Table";
import { api } from "../../lib/api";
import { formatBytes, formatNumber, formatRelativeTime, pluralize } from "../../lib/format";
import { queryKeys } from "../../lib/queries";
import type { DatabaseTabProps } from "./types";

export function TablesTab({ db }: DatabaseTabProps) {
  const query = useQuery({
    queryKey: queryKeys.databaseTables(db.id),
    queryFn: () => api.get<{ tables: TableBreakdownEntry[]; collectedAt?: number }>(`/databases/${db.id}/tables`),
    refetchInterval: (q) => (q.state.error ? false : 30_000),
  });

  const tables = useMemo(
    () => [...(query.data?.tables ?? [])].sort((a, b) => b.sizeBytes - a.sizeBytes || a.name.localeCompare(b.name)),
    [query.data],
  );
  const totals = useMemo(
    () => tables.reduce((acc, t) => ({ rows: acc.rows + t.rowCount, size: acc.size + t.sizeBytes }), { rows: 0, size: 0 }),
    [tables],
  );

  if (query.isError) {
    return <QueryError error={query.error} title="Could not load tables" onRetry={query.refetch} retrying={query.isFetching} />;
  }

  return (
    <Card flush>
      <CardHeader
        divided
        title="Tables"
        description="Estimated row counts and on-disk size from information_schema."
        action={
          query.data?.collectedAt ? (
            <span className="text-micro text-text-subtle">updated {formatRelativeTime(query.data.collectedAt)}</span>
          ) : undefined
        }
      />
      {!query.isPending && tables.length === 0 ? (
        <EmptyState
          variant="bare"
          icon={Table2}
          title="No tables yet"
          description="Create one from the Query tab or connect a client and run your migrations."
        />
      ) : (
        <Table flush caption={`Tables in ${db.name}`}>
          <THead>
            <TR>
              <TH>Name</TH>
              <TH numeric>Rows</TH>
              <TH numeric>Size</TH>
              <TH numeric className="hidden sm:table-cell">
                Avg row
              </TH>
            </TR>
          </THead>
          <TBody>
            {query.isPending ? (
              <TableSkeleton rows={4} cols={4} />
            ) : (
              tables.map((t) => (
                <TR key={t.name}>
                  <TD mono className="text-text">
                    {t.name}
                  </TD>
                  <TD numeric>{formatNumber(t.rowCount)}</TD>
                  <TD numeric>{formatBytes(t.sizeBytes)}</TD>
                  <TD numeric className="hidden text-text-muted sm:table-cell">
                    {t.avgRowBytes > 0 ? formatBytes(t.avgRowBytes) : "—"}
                  </TD>
                </TR>
              ))
            )}
          </TBody>
          {!query.isPending && tables.length > 1 && (
            <TFoot>
              <TR>
                <TD className="text-label text-text-muted">{pluralize(tables.length, "table")}</TD>
                <TD numeric>{formatNumber(totals.rows)}</TD>
                <TD numeric>{formatBytes(totals.size)}</TD>
                <TD className="hidden sm:table-cell" />
              </TR>
            </TFoot>
          )}
        </Table>
      )}
    </Card>
  );
}
