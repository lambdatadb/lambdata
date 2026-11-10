import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  MoveBackSetAsideTableRequest,
  MoveBackSetAsideTableResponse,
  SetAsideListResponse,
  SetAsideSchema,
} from "@lambdata/shared";
import { api } from "../../lib/api";
import { isForbidden, isNotFound } from "../../lib/queries";
import { invalidateHistory } from "./queries";

export const setAsideKey = (databaseId: string) => ["checkpoints", databaseId, "set-aside"] as const;

export function setAsidePath(databaseId: string, rest = ""): string {
  return `/databases/${encodeURIComponent(databaseId)}/set-aside${rest}`;
}

export async function fetchSetAside(databaseId: string): Promise<SetAsideSchema[]> {
  try {
    return (await api.get<SetAsideListResponse>(setAsidePath(databaseId))).schemas ?? [];
  } catch (error) {
    if (isNotFound(error) || isForbidden(error)) return [];
    throw error;
  }
}

export function useSetAside(databaseId: string) {
  return useQuery({
    queryKey: setAsideKey(databaseId),
    queryFn: () => fetchSetAside(databaseId),
    staleTime: 10_000,
    retry: false,
  });
}

export function moveBackSetAside(databaseId: string, schema: string, body: MoveBackSetAsideTableRequest) {
  return api.post<MoveBackSetAsideTableResponse>(setAsidePath(databaseId, `/${encodeURIComponent(schema)}/move-back`), body);
}

export function deleteSetAside(databaseId: string, schema: string) {
  return api.delete<unknown>(setAsidePath(databaseId, `/${encodeURIComponent(schema)}`));
}

export function useSetAsideActions(databaseId: string) {
  const qc = useQueryClient();
  const refresh = () => invalidateHistory(qc, databaseId);
  const moveBack = useMutation({
    mutationFn: ({ schema, body }: { schema: string; body: MoveBackSetAsideTableRequest }) => moveBackSetAside(databaseId, schema, body),
    onSettled: () => void refresh(),
  });
  const remove = useMutation({
    mutationFn: (schema: string) => deleteSetAside(databaseId, schema),
    onSettled: () => void refresh(),
  });
  return { moveBack, remove };
}

export function tableNameError(value: string, taken: string): string | null {
  const name = value.trim();
  if (!name) return "Enter a name for the table.";
  if (name.length > 64) return "Table names can be at most 64 characters.";
  if (!/^[A-Za-z0-9_$]+$/.test(name)) return "Use letters, numbers, _ and $ only.";
  if (/^\d+$/.test(name)) return "A table name cannot be only digits.";
  if (name.toLowerCase() === taken.toLowerCase()) return `${taken} is in use in the database. Choose another name.`;
  return null;
}

export function suggestedName(table: string): string {
  const base = `${table}_set_aside`;
  return base.length <= 64 ? base : base.slice(0, 64);
}

export const SET_ASIDE_TEXT: Record<SetAsideSchema["kind"], { lead: string; next: string }> = {
  quarantine: {
    lead: "While data was being swapped in, something created a new table with the same name. Your original table is back in the database; the new one was kept here.",
    next: "Move it back under another name if you need what it holds, or delete it.",
  },
  kept: {
    lead: "A table could not be put back because its name is now used by something else. It is kept here, untouched.",
    next: "Rename or remove what now uses the name and move the table back, or move it back under another name.",
  },
};
