import { Link } from "react-router-dom";
import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import type { DataApiAccessSummary, DataApiSchema, DataApiTable, Database } from "@lambdata/shared";
import { Database as DatabaseIcon, KeyRound, RotateCcw, Table2 } from "lucide-react";
import {
  Alert,
  Badge,
  Button,
  Card,
  CardHeader,
  CopyableField,
  EmptyState,
  SelectMenu,
  Skeleton,
  SkeletonRows,
  TBody,
  TD,
  TH,
  THead,
  TR,
  Table,
  cn,
} from "../ui";
import { api, absoluteUrl, errorMessage } from "../../lib/api";
import { PolicyEditor } from "./PolicyEditor";
import { schemaKey } from "./useDataAccess";
import { displayBytes, displayCount, pluralize } from "../../lib/format";

interface Props {
  databasesQuery: UseQueryResult<{ databases: Database[] }>;
  selectedDb: Database | null;
  selectedTableName: string | null;
  access: DataApiAccessSummary | null | undefined;
  canWrite: boolean;
  onSelect: (databaseName: string, tableName?: string | null) => void;
  tableHref: (databaseName: string, tableName: string) => string;
}

export function useDataSchema(databaseName: string | undefined) {
  return useQuery({
    queryKey: schemaKey(databaseName),
    queryFn: () => api.get<{ schema: DataApiSchema }>(`/data-docs/${encodeURIComponent(databaseName!)}/schema`),
    enabled: !!databaseName,
  });
}

export function TableExplorer({
  databasesQuery,
  selectedDb,
  selectedTableName,
  access,
  canWrite,
  onSelect,
  tableHref,
}: Props) {
  const databases = databasesQuery.data?.databases ?? [];
  const schemaQuery = useDataSchema(selectedDb?.name);
  const tables = schemaQuery.data?.schema.tables ?? [];
  const selectedTable = tables.find((t) => t.name === selectedTableName) ?? tables[0] ?? null;

  return (
    <Card flush>
      <CardHeader
        divided
        title="Tables"
        description="Read live from information_schema: new tables and columns show up here without a deploy."
      >
        {databases.length > 0 && (
          <div className="w-full sm:w-60">
            <SelectMenu
              aria-label="Database"
              value={selectedDb?.name}
              onValueChange={(name) => onSelect(name, null)}
              options={databases.map((db) => ({
                value: db.name,
                label: db.displayName,
                description: <span className="font-mono">{db.name}</span>,
              }))}
            />
          </div>
        )}
      </CardHeader>
      {databasesQuery.isPending ? (
        <ExplorerSkeleton />
      ) : databasesQuery.isError ? (
        <div className="p-5">
          <Alert
            variant="danger"
            title="Could not load databases"
            action={
              <Button size="xs" variant="secondary" onClick={() => databasesQuery.refetch()}>
                <RotateCcw aria-hidden /> Retry
              </Button>
            }
          >
            {errorMessage(databasesQuery.error, "The server did not answer.")}
          </Alert>
        </div>
      ) : !selectedDb ? (
        <EmptyState
          variant="bare"
          icon={DatabaseIcon}
          title="No databases yet"
          description="Every table in a database you create gets REST endpoints here."
          action={
            <Button asChild size="sm" variant="secondary">
              <Link to="/databases">Go to databases</Link>
            </Button>
          }
        />
      ) : schemaQuery.isPending ? (
        <ExplorerSkeleton />
      ) : schemaQuery.isError ? (
        <div className="p-5">
          <Alert
            variant="danger"
            title={`Could not read the schema of ${selectedDb.displayName}`}
            action={
              <Button size="xs" variant="secondary" onClick={() => schemaQuery.refetch()}>
                <RotateCcw aria-hidden /> Retry
              </Button>
            }
          >
            {errorMessage(schemaQuery.error, "The server did not answer.")}
          </Alert>
        </div>
      ) : tables.length === 0 || !selectedTable ? (
        <EmptyState
          variant="bare"
          icon={Table2}
          title={`No tables in ${selectedDb.displayName}`}
          description="Create a table from the database's Query tab and its endpoint appears here."
          action={
            <Button asChild size="sm" variant="secondary">
              <Link to={`/databases/${selectedDb.id}`}>Open {selectedDb.displayName}</Link>
            </Button>
          }
        />
      ) : (
        <div className="grid min-h-[28rem] lg:grid-cols-[15rem_minmax(0,1fr)]">
          <nav aria-label={`Tables in ${selectedDb.displayName}`} className="hidden border-r border-border lg:block">
            <ul className="space-y-0.5 p-2">
              {tables.map((table) => {
                const active = table.name === selectedTable.name;
                const noPolicy = !table.policy;
                return (
                  <li key={table.name}>
                    <Link
                      to={tableHref(selectedDb.name, table.name)}
                      replace
                      aria-current={active ? "page" : undefined}
                      className={cn(
                        "relative flex items-center gap-2 rounded-md px-2.5 py-2 text-text-muted outline-none transition-colors hover:bg-bg-hover hover:text-text focus-visible:ring-2 focus-visible:ring-ring/70",
                        active &&
                          "bg-bg-selected text-text before:absolute before:left-0 before:top-2 before:h-[calc(100%-1rem)] before:w-0.5 before:rounded-full before:bg-accent",
                      )}
                    >
                      <span className="min-w-0 flex-1">
                        <span className="block truncate font-mono text-code">{table.name}</span>
                        <span className="block truncate text-micro text-text-subtle">
                          {displayCount(table.rowCount)} {table.rowCount === 1 ? "row" : "rows"} · {pluralize(table.columns.length, "column")}
                        </span>
                      </span>
                      {noPolicy && (
                        <Badge size="sm" variant={access?.mode === "closed" ? "warn" : "muted"}>
                          {access?.mode === "closed" ? "denied" : "no policy"}
                        </Badge>
                      )}
                    </Link>
                  </li>
                );
              })}
            </ul>
          </nav>
          <div className="min-w-0">
            <div className="border-b border-border px-5 py-3 lg:hidden">
              <SelectMenu
                aria-label="Table"
                value={selectedTable.name}
                onValueChange={(name) => onSelect(selectedDb.name, name)}
                options={tables.map((t) => ({
                  value: t.name,
                  label: <span className="font-mono text-code">{t.name}</span>,
                  description: !t.policy ? "no policy" : undefined,
                }))}
              />
            </div>
            <TableDetail
              key={`${selectedDb.name}.${selectedTable.name}`}
              databaseName={selectedDb.name}
              table={selectedTable}
              access={access}
              canWrite={canWrite}
            />
          </div>
        </div>
      )}
    </Card>
  );
}

function TableDetail({
  databaseName,
  table,
  access,
  canWrite,
}: {
  databaseName: string;
  table: DataApiTable;
  access: DataApiAccessSummary | null | undefined;
  canWrite: boolean;
}) {
  const endpoint = `/api/data/${databaseName}/${table.name}`;
  return (
    <div className="min-w-0">
      <div className="space-y-3 border-b border-border px-5 py-4">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="mr-1 truncate font-mono text-heading font-semibold text-text">{table.name}</h3>
          <Badge variant="muted" mono size="sm">
            {displayCount(table.rowCount)} {table.rowCount === 1 ? "row" : "rows"}
          </Badge>
          <Badge variant="muted" mono size="sm">
            {displayBytes(table.sizeBytes)}
          </Badge>
        </div>
        <CopyableField label="Endpoint" value={absoluteUrl(endpoint)} copyLabel="endpoint URL" />
      </div>
      <PolicyEditor databaseName={databaseName} table={table} access={access} canWrite={canWrite} />
      <Table flush caption={`Columns of ${table.name}`}>
        <THead>
          <TR>
            <TH>Column</TH>
            <TH>Type</TH>
            <TH>
              <span className="sr-only">Attributes</span>
            </TH>
          </TR>
        </THead>
        <TBody>
          {table.columns.map((column) => (
            <TR key={column.name}>
              <TD mono className="text-text">
                <span className="inline-flex items-center gap-1.5">
                  {column.primary && (
                    <>
                      <KeyRound className="size-3.5 text-text-muted" aria-hidden />
                      <span className="sr-only">Primary key:</span>
                    </>
                  )}
                  {column.name}
                </span>
              </TD>
              <TD mono className="text-text-muted">
                {column.dataType}
                {column.defaultValue !== null && (
                  <span className="ml-2 text-micro text-text-subtle">default {column.defaultValue}</span>
                )}
              </TD>
              <TD>
                <div className="flex flex-wrap justify-end gap-1.5">
                  {column.primary && <Badge size="sm">primary</Badge>}
                  {column.generated && (
                    <Badge size="sm" variant="muted">
                      generated
                    </Badge>
                  )}
                  {column.nullable && (
                    <Badge size="sm" variant="muted">
                      nullable
                    </Badge>
                  )}
                </div>
              </TD>
            </TR>
          ))}
        </TBody>
      </Table>
    </div>
  );
}

function ExplorerSkeleton() {
  return (
    <div className="grid min-h-[20rem] lg:grid-cols-[15rem_minmax(0,1fr)]" aria-busy="true">
      <div className="hidden space-y-3 border-r border-border p-4 lg:block">
        {Array.from({ length: 4 }, (_, i) => (
          <div key={i} className="space-y-1.5">
            <Skeleton className="h-3.5 w-28" />
            <Skeleton className="h-3 w-20" />
          </div>
        ))}
      </div>
      <div className="space-y-4 p-5">
        <Skeleton className="h-5 w-40" />
        <Skeleton className="h-9 w-full" />
        <SkeletonRows rows={5} label="Loading tables" />
      </div>
    </div>
  );
}
