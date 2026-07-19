import { createContext, useContext, useMemo, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { AuthResponse, User } from "@kilndb/shared";
import { api, ApiError } from "./api";

interface AuthCtx {
  user: User | null;
  isLoading: boolean;
  refetch: () => Promise<void>;
  logout: () => Promise<void>;
}

const Ctx = createContext<AuthCtx | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const { data, isLoading, refetch } = useQuery({
    queryKey: ["auth", "me"],
    queryFn: async () => {
      try {
        return await api.get<AuthResponse>("/auth/me");
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) return { user: null };
        throw err;
      }
    },
    retry: false,
    staleTime: 60_000,
  });

  const value = useMemo<AuthCtx>(() => ({
    user: data?.user ?? null,
    isLoading,
    refetch: async () => {
      await refetch();
    },
    logout: async () => {
      await api.post("/auth/logout");
      qc.removeQueries();
    },
  }), [data, isLoading, refetch, qc]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAuth(): AuthCtx {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useAuth must be inside AuthProvider");
  return ctx;
}
