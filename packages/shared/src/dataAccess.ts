import type { DataApiOperation } from "./types";

export type DataApiMode = "closed" | "open";

export interface DataApiDenial {
  databaseId: string;
  databaseName: string;
  tableName: string;
  operation: DataApiOperation;
  count: number;
  lastAt: number;
}

export interface DataApiAccessSummary {
  databaseId: string;
  databaseName: string;
  displayName: string;
  mode: DataApiMode;
  tableCount: number;
  tablesWithoutPolicy: string[];
  denials: DataApiDenial[];
}

export interface DataApiAccessResponse {
  access: DataApiAccessSummary;
}

export interface DataApiOverviewResponse {
  databases: DataApiAccessSummary[];
  signupEnabled: boolean;
}

export interface UpdateDataApiAccessRequest {
  mode: DataApiMode;
}
