import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { DataApiPolicy, DataApiSchema, DataApiTable, Database } from "@kilndb/shared";
import { api, ApiError } from "../lib/api";
import { useAuth } from "../lib/auth";
import { PageHeader } from "../components/layout/PageShell";
import { Card, CardTitle, SectionLabel } from "../components/ui/Card";
import { Badge } from "../components/ui/Badge";
import { Button } from "../components/ui/Button";
import { Select } from "../components/ui/Select";
import { Spinner } from "../components/ui/Spinner";
import { Switch } from "../components/ui/Switch";
import { Icon } from "../components/ui/Icon";
import { CopyableField } from "../components/ui/CopyableField";
import { Table, TBody, TD, TH, THead, TR } from "../components/ui/Table";
import { Tabs } from "../components/ui/Tabs";
import { useToast } from "../components/ui/Toast";
import { formatBytes } from "../lib/format";
import { cn } from "../components/ui/cn";

type ExampleTab = "curl" | "javascript";

export function DataApi() {
  const { user } = useAuth();
  const [selectedDbId, setSelectedDbId] = useState("");
  const [selectedTableName, setSelectedTableName] = useState("");
  const [exampleTab, setExampleTab] = useState<ExampleTab>("curl");

  const databasesQuery = useQuery({
    queryKey: ["databases"],
    queryFn: () => api.get<{ databases: Database[] }>("/databases"),
  });
  const databases = databasesQuery.data?.databases ?? [];
  const selectedDb = useMemo(
    () => databases.find((db) => db.id === selectedDbId) ?? databases[0] ?? null,
    [databases, selectedDbId],
  );

  const schemaQuery = useQuery({
    queryKey: ["data-docs", selectedDb?.name, "schema"],
    queryFn: () => api.get<{ schema: DataApiSchema }>(`/data-docs/${selectedDb!.name}/schema`),
    enabled: !!selectedDb,
  });
  const schema = schemaQuery.data?.schema ?? null;
  const tables = schema?.tables ?? [];
  const selectedTable = useMemo(
    () => tables.find((table) => table.name === selectedTableName) ?? tables[0] ?? null,
    [tables, selectedTableName],
  );

  useEffect(() => {
    if (selectedTable && selectedTable.name !== selectedTableName) {
      setSelectedTableName(selectedTable.name);
    }
  }, [selectedTable, selectedTableName]);

  const databaseName = selectedDb?.name ?? "your_database";
  const tableName = selectedTable?.name ?? "todos";
  const openApiPath = schema?.openApiPath ?? `/api/data-docs/${databaseName}/openapi.json`;
  const endpointPath = `/api/data/${databaseName}/${tableName}`;
  const canWritePolicies = user?.role !== "viewer";

  return (
    <>
      <PageHeader
        title="Data API"
        subtitle="Generated REST endpoints, live schema docs, and OpenAPI output over managed MariaDB tables."
      />

      <div className="grid grid-cols-1 xl:grid-cols-[minmax(0,1fr)_420px] gap-5">
        <div className="space-y-5">
          <Card className="p-0 overflow-hidden">
            <div className="p-5 border-b border-border flex items-start justify-between gap-4">
              <div>
                <SectionLabel>Generated API docs</SectionLabel>
                <p className="text-body text-text-muted">
                  The docs reflect `information_schema`; table and column changes appear without server code.
                </p>
              </div>
              <Select
                value={selectedDb?.id ?? ""}
                onChange={(e) => {
                  setSelectedDbId(e.target.value);
                  setSelectedTableName("");
                }}
                className="w-56 h-9 py-0"
              >
                {databases.map((db) => (
                  <option key={db.id} value={db.id}>{db.displayName}</option>
                ))}
              </Select>
            </div>

            {databasesQuery.isLoading || schemaQuery.isLoading ? (
              <div className="py-12 flex justify-center"><Spinner /></div>
            ) : !selectedDb ? (
              <DocsEmpty icon="api" text="Create a database to expose generated REST endpoints." />
            ) : tables.length === 0 ? (
              <DocsEmpty icon="table" text={`No base tables found in ${selectedDb.displayName}.`} />
            ) : (
              <div className="grid grid-cols-1 lg:grid-cols-[300px_minmax(0,1fr)] min-h-[520px]">
                <div className="border-r border-border">
                  <div className="p-4 border-b border-border">
                    <SectionLabel dot={false}>Tables</SectionLabel>
                  </div>
                  <div className="divide-y divide-border">
                    {tables.map((table) => (
                      <button
                        key={table.name}
                        type="button"
                        onClick={() => setSelectedTableName(table.name)}
                        className={cn(
                          "w-full px-4 py-3.5 text-left transition-colors hover:bg-bg-subtle/50",
                          selectedTable?.name === table.name && "bg-bg-subtle",
                        )}
                      >
                        <div className="flex items-center justify-between gap-3">
                          <div className="min-w-0">
                            <div className="flex items-center gap-2">
                              <Icon name="table" size={16} className="text-accent" />
                              <span className="font-mono text-label text-text truncate">{table.name}</span>
                            </div>
                            <div className="mt-1 text-label text-text-subtle">
                              {table.columns.length} columns · {formatBytes(table.sizeBytes)}
                            </div>
                          </div>
                          <Badge tone="muted">{table.rowCount.toLocaleString()}</Badge>
                        </div>
                      </button>
                    ))}
                  </div>
                </div>

                <div className="min-w-0">
                  {selectedTable && (
                    <TableDocs
                      table={selectedTable}
                      endpointPath={endpointPath}
                      openApiPath={openApiPath}
                    />
                  )}
                </div>
              </div>
            )}
          </Card>
        </div>

        <div className="space-y-5">
          <Card>
            <div className="flex items-start justify-between gap-4">
              <div>
                <CardTitle>OpenAPI</CardTitle>
                <p className="mt-1 text-body text-text-muted">
                  Export a live OpenAPI 3.1 document for the selected database.
                </p>
              </div>
              <Badge tone="accent">3.1</Badge>
            </div>
            <div className="mt-4 space-y-3">
              <CopyableField label="Spec URL" value={openApiPath} />
              <CopyableField
                label="Download"
                value={`curl http://localhost:4317${openApiPath} -b kilndb_session=<cookie>`}
              />
            </div>
          </Card>

          {selectedTable && (
            <PolicyCard
              databaseName={databaseName}
              table={selectedTable}
              canWrite={canWritePolicies}
            />
          )}

          <Card className="p-0 overflow-hidden">
            <div className="p-5 border-b border-border">
              <div className="flex items-center justify-between">
                <CardTitle>Examples</CardTitle>
                <Badge tone="accent">Bearer</Badge>
              </div>
              <p className="mt-1 text-body text-text-muted">
                Requests use App Auth access tokens, not console sessions.
              </p>
            </div>
            <Tabs
              tabs={[
                { id: "curl", label: "cURL" },
                { id: "javascript", label: "JavaScript" },
              ]}
              active={exampleTab}
              onChange={(id) => setExampleTab(id as ExampleTab)}
            />
            <div className="p-5">
              <CodeSnippet value={exampleTab === "curl" ? curlExample(endpointPath) : jsExample(endpointPath)} />
            </div>
          </Card>

          <Card>
            <SectionLabel>Supported filters</SectionLabel>
            <div className="flex flex-wrap gap-2">
              {["eq", "neq", "gt", "gte", "lt", "lte", "like", "ilike", "in"].map((op) => (
                <Badge key={op} tone="muted">{op}</Badge>
              ))}
            </div>
            <p className="mt-4 text-body text-text-muted">
              This is the self-hosted MariaDB version of a PostgREST-like surface. Table policies can gate methods and owner-scope rows; richer SQL expressions and relationship embedding are still planned.
            </p>
          </Card>
        </div>
      </div>
    </>
  );
}

function TableDocs({
  table,
  endpointPath,
  openApiPath,
}: {
  table: DataApiTable;
  endpointPath: string;
  openApiPath: string;
}) {
  return (
    <div>
      <div className="p-5 border-b border-border flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <CardTitle>{table.name}</CardTitle>
            <Badge tone="muted">{table.rowCount.toLocaleString()} rows</Badge>
          </div>
          <p className="mt-1 font-mono text-label text-text-muted truncate">{endpointPath}</p>
        </div>
        <Badge tone="accent">{table.columns.filter((col) => col.primary).length || 0} pk</Badge>
      </div>

      <div className="p-5 grid grid-cols-1 gap-4 border-b border-border">
        <CopyableField label="Endpoint" value={endpointPath} />
        <CopyableField label="OpenAPI" value={openApiPath} />
      </div>

      <Table flush>
        <THead>
          <tr>
            <TH>Column</TH>
            <TH>Type</TH>
            <TH>Flags</TH>
            <TH>Filter</TH>
          </tr>
        </THead>
        <TBody>
          {table.columns.map((column) => (
            <TR key={column.name}>
              <TD className="font-mono text-label">{column.name}</TD>
              <TD className="font-mono text-label text-text-muted">{column.dataType}</TD>
              <TD>
                <div className="flex flex-wrap gap-1.5">
                  {column.primary && <Badge tone="accent">primary</Badge>}
                  {column.generated && <Badge tone="muted">generated</Badge>}
                  <Badge tone={column.nullable ? "muted" : "success"}>
                    {column.nullable ? "nullable" : "required"}
                  </Badge>
                </div>
              </TD>
              <TD className="font-mono text-label text-text-subtle">
                ?{column.name}=eq.value
              </TD>
            </TR>
          ))}
        </TBody>
      </Table>
    </div>
  );
}

function PolicyCard({
  databaseName,
  table,
  canWrite,
}: {
  databaseName: string;
  table: DataApiTable;
  canWrite: boolean;
}) {
  const qc = useQueryClient();
  const toast = useToast();
  const policy = table.policy ?? defaultPolicy(table.name);
  const refresh = () => qc.invalidateQueries({ queryKey: ["data-docs", databaseName, "schema"] });

  const update = useMutation({
    mutationFn: (patch: Partial<DataApiPolicy>) =>
      api.patch<{ policy: DataApiPolicy }>(`/data-policies/${databaseName}/${table.name}`, patch),
    onSuccess: () => {
      refresh();
      toast.show("Policy updated", "success");
    },
    onError: (e) => toast.show(e instanceof ApiError ? e.message : "policy update failed", "error"),
  });
  const reset = useMutation({
    mutationFn: () => api.delete<{ policy: DataApiPolicy }>(`/data-policies/${databaseName}/${table.name}`),
    onSuccess: () => {
      refresh();
      toast.show("Policy reset", "success");
    },
    onError: (e) => toast.show(e instanceof ApiError ? e.message : "policy reset failed", "error"),
  });
  const disabled = !canWrite || update.isPending || reset.isPending;

  return (
    <Card className="p-0 overflow-hidden">
      <div className="p-5 border-b border-border flex items-start justify-between gap-3">
        <div>
          <CardTitle>Policies</CardTitle>
          <p className="mt-1 text-body text-text-muted">
            Data API gates for {table.name}, with optional App Auth owner filtering.
          </p>
        </div>
        <Badge tone={policy.ownerColumn ? "accent" : "muted"}>
          {policy.ownerColumn ? "owner scoped" : "project"}
        </Badge>
      </div>

      <div className="p-5 space-y-5">
        <div className="grid grid-cols-2 gap-3">
          <PolicySwitch
            label="GET"
            checked={policy.selectEnabled}
            disabled={disabled}
            onChange={(selectEnabled) => update.mutate({ selectEnabled })}
          />
          <PolicySwitch
            label="POST"
            checked={policy.insertEnabled}
            disabled={disabled}
            onChange={(insertEnabled) => update.mutate({ insertEnabled })}
          />
          <PolicySwitch
            label="PATCH"
            checked={policy.updateEnabled}
            disabled={disabled}
            onChange={(updateEnabled) => update.mutate({ updateEnabled })}
          />
          <PolicySwitch
            label="DELETE"
            checked={policy.deleteEnabled}
            disabled={disabled}
            onChange={(deleteEnabled) => update.mutate({ deleteEnabled })}
          />
        </div>

        <div>
          <SectionLabel dot={false}>Owner column</SectionLabel>
          <Select
            value={policy.ownerColumn ?? ""}
            disabled={disabled}
            onChange={(e) => update.mutate({ ownerColumn: e.target.value || null })}
            className="mt-2 w-full h-9 py-0"
          >
            <option value="">None</option>
            {table.columns.map((column) => (
              <option key={column.name} value={column.name}>
                {column.name}
              </option>
            ))}
          </Select>
          <p className="mt-2 text-label text-text-subtle">
            When set, reads/updates/deletes are filtered to rows where this column equals the App Auth user id. Inserts must provide that same value.
          </p>
        </div>

        <div className="flex items-center justify-between gap-3 border-t border-border pt-4">
          <span className="text-label text-text-subtle">
            {table.policy ? "Custom policy stored" : "Using permissive default"}
          </span>
          <Button
            variant="secondary"
            size="sm"
            disabled={!canWrite || !table.policy}
            loading={reset.isPending}
            onClick={() => reset.mutate()}
          >
            Reset
          </Button>
        </div>
      </div>
    </Card>
  );
}

function PolicySwitch({
  label,
  checked,
  disabled,
  onChange,
}: {
  label: string;
  checked: boolean;
  disabled: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <div className="rounded-md border border-border bg-bg-subtle p-3">
      <Switch
        checked={checked}
        disabled={disabled}
        onChange={onChange}
        label={label}
        description={checked ? "Allowed" : "Blocked"}
      />
    </div>
  );
}

function defaultPolicy(tableName: string): DataApiPolicy {
  return {
    databaseId: "",
    tableName,
    selectEnabled: true,
    insertEnabled: true,
    updateEnabled: true,
    deleteEnabled: true,
    ownerColumn: null,
    createdAt: null,
    updatedAt: null,
  };
}

function DocsEmpty({ icon, text }: { icon: string; text: string }) {
  return (
    <div className="py-14 text-center text-text-muted">
      <Icon name={icon} size={28} className="mx-auto mb-3 text-text-subtle" />
      <p className="text-body">{text}</p>
    </div>
  );
}

function CodeSnippet({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    await navigator.clipboard.writeText(value).catch(() => undefined);
    setCopied(true);
    setTimeout(() => setCopied(false), 1400);
  };

  return (
    <div className="rounded-md border border-border bg-[#0b0f0d] overflow-hidden">
      <div className="h-9 px-3 border-b border-border flex items-center justify-between">
        <span className="text-label font-medium text-text-muted">Request</span>
        <button
          type="button"
          onClick={copy}
          className="text-label text-text-muted hover:text-text transition-colors"
        >
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <pre className="max-h-[330px] overflow-auto p-3 font-mono text-label leading-5 text-text-muted">
        {value}
      </pre>
    </div>
  );
}

function curlExample(endpointPath: string): string {
  return `curl "http://localhost:4317${endpointPath}?select=*&limit=100" \\
  -H "Authorization: Bearer <accessToken>"

curl -X POST "http://localhost:4317${endpointPath}" \\
  -H "Authorization: Bearer <accessToken>" \\
  -H "Content-Type: application/json" \\
  --data '{"title":"Ship docs","done":false}'`;
}

function jsExample(endpointPath: string): string {
  return `const token = "<accessToken>";

const rows = await fetch("${endpointPath}?select=*&limit=100", {
  headers: { Authorization: \`Bearer \${token}\` },
}).then((res) => res.json());

const created = await fetch("${endpointPath}", {
  method: "POST",
  headers: {
    Authorization: \`Bearer \${token}\`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify({ title: "Ship docs", done: false }),
}).then((res) => res.json());`;
}
