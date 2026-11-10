import { useRef } from "react";
import { useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import type { Database } from "@lambdata/shared";
import { api } from "../lib/api";
import { useAuth } from "../lib/auth";
import { PageHeader } from "../components/layout/PageShell";
import { AccessCard } from "../components/dataapi/AccessCard";
import { ApiReference } from "../components/dataapi/ApiReference";
import { DenialsBanner } from "../components/dataapi/DenialsBanner";
import { TableExplorer, useDataSchema } from "../components/dataapi/TableExplorer";
import { useDataAccessOverview } from "../components/dataapi/useDataAccess";

export function DataApi() {
  const { user } = useAuth();
  const canWrite = user?.role !== "viewer";
  const [params, setParams] = useSearchParams();
  const explorerRef = useRef<HTMLDivElement>(null);

  const overview = useDataAccessOverview();
  const databasesQuery = useQuery({
    queryKey: ["databases"],
    queryFn: () => api.get<{ databases: Database[] }>("/databases"),
  });
  const databases = databasesQuery.data?.databases ?? [];
  const selectedDb = databases.find((db) => db.name === params.get("db")) ?? databases[0] ?? null;
  const schemaQuery = useDataSchema(selectedDb?.name);
  const tables = schemaQuery.data?.schema.tables ?? [];
  const tableParam = params.get("table");
  const selectedTable = tables.find((t) => t.name === tableParam) ?? tables[0] ?? null;

  const access =
    overview.data === undefined
      ? undefined
      : overview.data.supported
        ? overview.data.databases.find((s) => s.databaseName === selectedDb?.name) ?? null
        : null;

  const searchFor = (databaseName: string, tableName?: string | null) => {
    const next = new URLSearchParams(params);
    next.set("db", databaseName);
    if (tableName) next.set("table", tableName);
    else next.delete("table");
    return next;
  };

  const select = (databaseName: string, tableName?: string | null) =>
    setParams(searchFor(databaseName, tableName), { replace: true });

  const review = (databaseName: string, tableName: string) => {
    select(databaseName, tableName);
    requestAnimationFrame(() => explorerRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }));
  };

  return (
    <>
      <PageHeader
        title="Data API"
        subtitle="REST endpoints generated from your MariaDB tables. A table without a policy is closed unless its database is open."
      />
      <div className="space-y-5">
        <DenialsBanner overview={overview.data} canWrite={canWrite} onReview={review} />
        <AccessCard query={overview} canWrite={canWrite} onReview={review} />
        <div ref={explorerRef} className="scroll-mt-6">
          <TableExplorer
            databasesQuery={databasesQuery}
            selectedDb={selectedDb}
            selectedTableName={selectedTable?.name ?? null}
            access={access}
            canWrite={canWrite}
            onSelect={select}
            tableHref={(databaseName, tableName) => `?${searchFor(databaseName, tableName).toString()}`}
          />
        </div>
        <ApiReference
          databaseName={selectedDb?.name ?? null}
          displayName={selectedDb?.displayName ?? null}
          tableName={selectedTable?.name ?? null}
          openApiPath={schemaQuery.data?.schema.openApiPath ?? null}
        />
      </div>
    </>
  );
}
