import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { AnimatePresence, motion } from "framer-motion";
import type { Database } from "@kilndb/shared";
import { api } from "../lib/api";
import { PageHeader } from "../components/layout/PageShell";
import { Button } from "../components/ui/Button";
import { EmptyState } from "../components/ui/EmptyState";
import { Spinner } from "../components/ui/Spinner";
import { Icon } from "../components/ui/Icon";
import { ViewToggle, type ViewMode } from "../components/databases/ViewToggle";
import { DatabaseGrid } from "../components/databases/DatabaseGrid";
import { DatabaseList } from "../components/databases/DatabaseList";
import { CreateDatabaseDialog } from "../components/databases/CreateDatabaseDialog";

export function Databases() {
  const [view, setView] = useState<ViewMode>("grid");
  const [dialogOpen, setDialogOpen] = useState(false);
  const { data, isLoading } = useQuery({
    queryKey: ["databases"],
    queryFn: () => api.get<{ databases: Database[] }>("/databases"),
  });
  const items = data?.databases ?? [];

  return (
    <>
      <PageHeader
        title="Databases"
        subtitle={isLoading ? "Loading…" : `${items.length} provisioned`}
        actions={
          <>
            <ViewToggle value={view} onChange={setView} />
            <Button onClick={() => setDialogOpen(true)}>
              <Icon name="add" size={14} />
              New database
            </Button>
          </>
        }
      />

      {isLoading ? (
        <div className="flex justify-center py-20"><Spinner /></div>
      ) : items.length === 0 ? (
        <EmptyState
          icon="database"
          title="No databases yet"
          description="Provision your first to get a schema, MySQL user, and connection strings."
          action={
            <Button onClick={() => setDialogOpen(true)}>
              <Icon name="add" size={14} />
              New database
            </Button>
          }
        />
      ) : (
        <AnimatePresence mode="wait">
          <motion.div
            key={view}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4 }}
            transition={{ duration: 0.18 }}
          >
            {view === "grid" ? <DatabaseGrid databases={items} /> : <DatabaseList databases={items} />}
          </motion.div>
        </AnimatePresence>
      )}

      <CreateDatabaseDialog open={dialogOpen} onClose={() => setDialogOpen(false)} />
    </>
  );
}
