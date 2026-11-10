import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  DataApiAccessResponse,
  DataApiAccessSummary,
  DataApiDenial,
  DataApiMode,
  DataApiOperation,
  DataApiOverviewResponse,
  DataApiPolicy,
} from "@lambdata/shared";
import { api, ApiError } from "../../lib/api";
import { pollEvery } from "../../lib/queries";

export const DATA_OPERATIONS: DataApiOperation[] = ["select", "insert", "update", "delete"];

export const OPERATION_METHOD: Record<DataApiOperation, string> = {
  select: "GET",
  insert: "POST",
  update: "PATCH",
  delete: "DELETE",
};

export type DataAccessOverview =
  | { supported: true; databases: DataApiAccessSummary[]; signupEnabled: boolean }
  | { supported: false };

export const dataAccessKey = ["data-access", "overview"] as const;

export function schemaKey(databaseName: string | undefined) {
  return ["data-docs", databaseName, "schema"] as const;
}

function normalizeSummary(raw: Partial<DataApiAccessSummary>): DataApiAccessSummary {
  return {
    databaseId: String(raw.databaseId ?? ""),
    databaseName: String(raw.databaseName ?? ""),
    displayName: String(raw.displayName ?? raw.databaseName ?? ""),
    mode: raw.mode === "open" ? "open" : "closed",
    tableCount: raw.tableCount ?? 0,
    tablesWithoutPolicy: Array.isArray(raw.tablesWithoutPolicy) ? raw.tablesWithoutPolicy : [],
    denials: Array.isArray(raw.denials) ? raw.denials : [],
  };
}

export function useDataAccessOverview(enabled = true) {
  return useQuery({
    queryKey: dataAccessKey,
    queryFn: async (): Promise<DataAccessOverview> => {
      try {
        const res = await api.get<DataApiOverviewResponse | string>("/data-access");
        if (!res || typeof res !== "object" || !Array.isArray(res.databases)) return { supported: false };
        return {
          supported: true,
          databases: res.databases.map(normalizeSummary),
          signupEnabled: res.signupEnabled === true,
        };
      } catch (error) {
        if (error instanceof ApiError && [404, 405, 501].includes(error.status)) return { supported: false };
        throw error;
      }
    },
    refetchInterval: pollEvery(30_000),
    enabled,
  });
}

export function deniedOperations(summary: DataApiAccessSummary | null | undefined, tableName: string): DataApiOperation[] {
  if (!summary) return [];
  const ops = new Set(summary.denials.filter((d) => d.tableName === tableName).map((d) => d.operation));
  return DATA_OPERATIONS.filter((op) => ops.has(op));
}

export function operationsForNewPolicy(summary: DataApiAccessSummary | null | undefined, tableName: string): DataApiOperation[] {
  const denied = deniedOperations(summary, tableName);
  return denied.length > 0 ? denied : DATA_OPERATIONS;
}

export function hasPolicy(summary: DataApiAccessSummary, tableName: string): boolean {
  return !summary.tablesWithoutPolicy.includes(tableName);
}

export interface DenialGroup {
  key: string;
  databaseName: string;
  displayName: string;
  tableName: string;
  operations: { operation: DataApiOperation; count: number | string }[];
  total: number;
  lastAt: number;
  summary: DataApiAccessSummary;
}

export function groupDenials(summaries: DataApiAccessSummary[]): DenialGroup[] {
  const groups = new Map<string, DenialGroup>();
  for (const summary of summaries) {
    for (const denial of summary.denials as DataApiDenial[]) {
      const key = `${summary.databaseName}.${denial.tableName}`;
      const group = groups.get(key) ?? {
        key,
        databaseName: summary.databaseName,
        displayName: summary.displayName,
        tableName: denial.tableName,
        operations: [],
        total: 0,
        lastAt: 0,
        summary,
      };
      group.operations.push({ operation: denial.operation, count: denial.count });
      group.total += Number(denial.count) || 0;
      group.lastAt = Math.max(group.lastAt, Number(denial.lastAt) || 0);
      groups.set(key, group);
    }
  }
  for (const group of groups.values()) {
    group.operations.sort((a, b) => DATA_OPERATIONS.indexOf(a.operation) - DATA_OPERATIONS.indexOf(b.operation));
  }
  return [...groups.values()].sort((a, b) => b.lastAt - a.lastAt);
}

function updateSummary(
  data: DataAccessOverview | undefined,
  databaseName: string,
  update: (summary: DataApiAccessSummary) => DataApiAccessSummary,
): DataAccessOverview | undefined {
  if (!data || !data.supported) return data;
  return {
    ...data,
    databases: data.databases.map((s) => (s.databaseName === databaseName ? update(s) : s)),
  };
}

export function policyBody(operations: DataApiOperation[]) {
  return {
    selectEnabled: operations.includes("select"),
    insertEnabled: operations.includes("insert"),
    updateEnabled: operations.includes("update"),
    deleteEnabled: operations.includes("delete"),
    ownerColumn: null,
  };
}

export function useAddPolicy() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ databaseName, tableName, operations }: { databaseName: string; tableName: string; operations: DataApiOperation[] }) =>
      api.patch<{ policy: DataApiPolicy }>(
        `/data-policies/${encodeURIComponent(databaseName)}/${encodeURIComponent(tableName)}`,
        policyBody(operations),
      ),
    onSuccess: (_res, { databaseName, tableName }) => {
      qc.setQueryData<DataAccessOverview>(dataAccessKey, (data) =>
        updateSummary(data, databaseName, (s) => ({
          ...s,
          tablesWithoutPolicy: s.tablesWithoutPolicy.filter((t) => t !== tableName),
        })),
      );
      qc.invalidateQueries({ queryKey: dataAccessKey });
      qc.invalidateQueries({ queryKey: schemaKey(databaseName) });
    },
  });
}

export function useSetAccessMode() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ databaseName, mode }: { databaseName: string; mode: DataApiMode }) =>
      api.put<DataApiAccessResponse>(`/data-access/${encodeURIComponent(databaseName)}`, { mode }),
    onSuccess: (res, { databaseName, mode }) => {
      qc.setQueryData<DataAccessOverview>(dataAccessKey, (data) =>
        updateSummary(data, databaseName, (s) =>
          res && typeof res === "object" && res.access ? normalizeSummary({ ...s, ...res.access }) : { ...s, mode },
        ),
      );
      qc.invalidateQueries({ queryKey: dataAccessKey });
    },
  });
}

export function useDismissDenials() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (databaseNames: string[]) => {
      await Promise.all(
        databaseNames.map((name) => api.delete(`/data-access/${encodeURIComponent(name)}/denials`)),
      );
    },
    onSuccess: (_res, databaseNames) => {
      qc.setQueryData<DataAccessOverview>(dataAccessKey, (data) => {
        if (!data || !data.supported) return data;
        return {
          ...data,
          databases: data.databases.map((s) => (databaseNames.includes(s.databaseName) ? { ...s, denials: [] } : s)),
        };
      });
      qc.invalidateQueries({ queryKey: dataAccessKey });
    },
  });
}

export function describeOperations(operations: DataApiOperation[]): string {
  if (operations.length === DATA_OPERATIONS.length) return "read and write";
  return operations.join(", ");
}
