import { useSyncExternalStore } from "react";
import { ApiError } from "./api";

const REFUSAL = /^This (LambData server (does not accept|requires)|connection is not allowed)/;

export const RECOVERY_VARIABLE = "LAMBDATA_ACCESS_POLICY=open";

export function isNetworkRefusal(error: unknown): error is ApiError {
  return error instanceof ApiError && error.status === 403 && REFUSAL.test(error.message);
}

let current: ApiError | null = null;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

export function reportNetworkRefusal(error: unknown): void {
  if (!isNetworkRefusal(error) || current) return;
  current = error;
  emit();
}

export function clearNetworkRefusal(): void {
  if (!current) return;
  current = null;
  emit();
}

export function useNetworkRefusal(): ApiError | null {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => current,
    () => null,
  );
}
