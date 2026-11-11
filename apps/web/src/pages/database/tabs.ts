import { lazy, type ComponentType } from "react";
import {
  ChartLine,
  FileUp,
  History,
  LayoutPanelTop,
  RefreshCw,
  SlidersHorizontal,
  SquareTerminal,
  Table2,
  TriangleAlert,
  type LucideIcon,
} from "lucide-react";
import type { Database, User } from "@lambdata/shared";
import { canWriteDatabase } from "../../lib/auth";
import type { DatabaseTabProps } from "./types";
import { OverviewTab } from "./OverviewTab";

function tab<M>(load: () => Promise<M>, key: keyof M): ComponentType<DatabaseTabProps> {
  return lazy(async () => ({ default: (await load())[key] as unknown as ComponentType<DatabaseTabProps> }));
}

const QueryTab = tab(() => import("./QueryTab"), "QueryTab");
const TablesTab = tab(() => import("./TablesTab"), "TablesTab");
const HistoryTab = tab(() => import("./HistoryTab"), "HistoryTab");
const SyncTab = tab(() => import("./SyncTab"), "SyncTab");
const ImportTab = tab(() => import("./ImportTab"), "ImportTab");
const MetricsTab = tab(() => import("./MetricsTab"), "MetricsTab");
const SettingsTab = tab(() => import("./SettingsTab"), "SettingsTab");
const DangerTab = tab(() => import("./DangerTab"), "DangerTab");

export interface DatabaseTabDefinition {
  id: string;
  label: string;
  icon: LucideIcon;
  component: ComponentType<DatabaseTabProps>;
  visible?: (db: Database, user: User | null) => boolean;
}

const canWrite = (db: Database, user: User | null) => canWriteDatabase(user, db);

export const DATABASE_TABS: DatabaseTabDefinition[] = [
  { id: "overview", label: "Overview", icon: LayoutPanelTop, component: OverviewTab },
  { id: "query", label: "Query", icon: SquareTerminal, component: QueryTab },
  { id: "tables", label: "Tables", icon: Table2, component: TablesTab },
  { id: "history", label: "History", icon: History, component: HistoryTab },
  { id: "sync", label: "Sync", icon: RefreshCw, component: SyncTab, visible: (db) => db.kind === "mirror" },
  { id: "import", label: "Import", icon: FileUp, component: ImportTab, visible: canWrite },
  { id: "metrics", label: "Metrics", icon: ChartLine, component: MetricsTab },
  { id: "settings", label: "Settings", icon: SlidersHorizontal, component: SettingsTab },
  { id: "danger", label: "Danger", icon: TriangleAlert, component: DangerTab, visible: canWrite },
];

export function visibleDatabaseTabs(db: Database, user: User | null): DatabaseTabDefinition[] {
  return DATABASE_TABS.filter((tab) => !tab.visible || tab.visible(db, user));
}
