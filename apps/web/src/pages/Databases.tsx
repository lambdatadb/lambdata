import { useEffect, useMemo, useState } from "react";
import { Database as DatabaseIcon, Plus, Search, SearchX } from "lucide-react";
import { PageHeader } from "../components/layout/PageShell";
import { QueryError } from "../components/layout/QueryError";
import { Button } from "../components/ui/Button";
import { Card } from "../components/ui/Card";
import { EmptyState } from "../components/ui/EmptyState";
import { Input } from "../components/ui/Input";
import { Skeleton } from "../components/ui/Skeleton";
import { ViewToggle, type ViewMode } from "../components/databases/ViewToggle";
import { DatabaseGrid } from "../components/databases/DatabaseGrid";
import { DatabaseList } from "../components/databases/DatabaseList";
import { useDatabases } from "../lib/queries";
import { useCanWrite } from "../lib/auth";
import { useCreateDatabaseDialog } from "../lib/createDatabase";

const VIEW_KEY = "lambdata-databases-view";

function readView(): ViewMode {
  try {
    return window.localStorage.getItem(VIEW_KEY) === "list" ? "list" : "grid";
  } catch {
    return "grid";
  }
}

export function Databases() {
  const [view, setView] = useState<ViewMode>(readView);
  const [filter, setFilter] = useState("");
  const databases = useDatabases();
  const canWrite = useCanWrite();
  const createDialog = useCreateDatabaseDialog();
  const items = databases.data ?? [];

  useEffect(() => {
    try {
      window.localStorage.setItem(VIEW_KEY, view);
    } catch {
      return;
    }
  }, [view]);

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return items;
    return items.filter(
      (db) =>
        db.displayName.toLowerCase().includes(q) ||
        db.name.toLowerCase().includes(q) ||
        (db.ownerDisplayName ?? "").toLowerCase().includes(q),
    );
  }, [items, filter]);

  const mirrors = items.filter((db) => db.kind === "mirror").length;
  const subtitle = databases.isPending
    ? "Loading…"
    : databases.isError
      ? "Schemas, users and connection strings"
      : items.length === 0
        ? "Schemas, users and connection strings"
        : `${items.length} ${items.length === 1 ? "database" : "databases"}${mirrors ? ` · ${mirrors} ${mirrors === 1 ? "mirror" : "mirrors"}` : ""}`;

  const newButton = canWrite ? (
    <Button onClick={() => createDialog.open("standard")}>
      <Plus /> New database
    </Button>
  ) : null;

  return (
    <>
      <PageHeader title="Databases" subtitle={subtitle} actions={newButton} />

      {databases.isPending ? (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3" role="status" aria-label="Loading databases">
          {Array.from({ length: 3 }, (_, i) => (
            <Card key={i} className="space-y-4 p-4">
              <div className="flex items-center gap-3">
                <Skeleton className="size-9" />
                <div className="flex-1 space-y-2">
                  <Skeleton className="h-3.5 w-1/2" />
                  <Skeleton className="h-3 w-1/3" />
                </div>
              </div>
              <Skeleton className="h-3 w-2/3" />
            </Card>
          ))}
        </div>
      ) : databases.isError ? (
        <QueryError
          error={databases.error}
          title="Could not load databases"
          onRetry={databases.refetch}
          retrying={databases.isFetching}
        />
      ) : items.length === 0 ? (
        <EmptyState
          icon={DatabaseIcon}
          title="No databases yet"
          description={
            canWrite
              ? "Create one to get a schema, a dedicated user and connection strings."
              : "Databases you are given access to appear here."
          }
          action={newButton}
        />
      ) : (
        <div className="space-y-4">
          <div className="flex items-center gap-2">
            <Input
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Filter by name, schema or owner"
              aria-label="Filter databases"
              leading={<Search />}
              inputSize="md"
              wrapperClassName="max-w-sm"
              type="search"
            />
            <div className="ml-auto">
              <ViewToggle value={view} onChange={setView} />
            </div>
          </div>
          {filtered.length === 0 ? (
            <EmptyState
              variant="dashed"
              size="sm"
              icon={SearchX}
              title={`No databases match “${filter.trim()}”`}
              action={
                <Button variant="ghost" size="sm" onClick={() => setFilter("")}>
                  Clear filter
                </Button>
              }
            />
          ) : view === "grid" ? (
            <DatabaseGrid databases={filtered} />
          ) : (
            <DatabaseList databases={filtered} />
          )}
        </div>
      )}
    </>
  );
}
