import { createContext, useContext, useEffect, useMemo, type ReactNode } from "react";
import { useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import type { AuthResponse, Database, Role, User } from "@lambdata/shared";
import { toast } from "../components/ui/Toast";
import { api, ApiError, setUnauthorizedHandler } from "./api";
import { queryKeys } from "./queries";

interface AuthCtx {
  user: User | null;
  isLoading: boolean;
  refetch: () => Promise<void>;
  logout: () => Promise<void>;
}

const Ctx = createContext<AuthCtx | null>(null);

type AuthData = { user: User | null };

export function clearSessionData(qc: QueryClient): void {
  qc.setQueryData<AuthData>(queryKeys.auth, { user: null });
  void qc.cancelQueries({ predicate: (query) => query.queryKey[0] !== "auth" });
  qc.removeQueries({ predicate: (query) => query.queryKey[0] !== "auth" && query.queryKey[0] !== "setup" });
}

export function acceptSignedInUser(qc: QueryClient, user: User): void {
  qc.removeQueries({ predicate: (query) => query.queryKey[0] !== "auth" && query.queryKey[0] !== "setup" });
  qc.setQueryData<AuthData>(queryKeys.auth, { user });
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const { data, isLoading, refetch } = useQuery({
    queryKey: queryKeys.auth,
    queryFn: async (): Promise<AuthData> => {
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

  useEffect(() => {
    setUnauthorizedHandler(() => {
      const current = qc.getQueryData<AuthData>(queryKeys.auth);
      if (!current?.user) return;
      clearSessionData(qc);
      toast.warning("Your session has ended", {
        id: "session-expired",
        description: "Sign in again to continue.",
      });
    });
    return () => setUnauthorizedHandler(null);
  }, [qc]);

  const value = useMemo<AuthCtx>(
    () => ({
      user: data?.user ?? null,
      isLoading,
      refetch: async () => {
        await refetch();
      },
      logout: async () => {
        try {
          await api.post("/auth/logout");
        } finally {
          clearSessionData(qc);
        }
      },
    }),
    [data, isLoading, refetch, qc],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAuth(): AuthCtx {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useAuth must be inside AuthProvider");
  return ctx;
}

export function useCanWrite(): boolean {
  const { user } = useAuth();
  return !!user && user.role !== "viewer";
}

export function useIsAdmin(): boolean {
  const { user } = useAuth();
  return user?.role === "admin";
}

export const ROLE_LABELS: Record<Role, string> = { admin: "Admin", db_owner: "DB owner", viewer: "Viewer" };

export function roleLabel(role: Role): string {
  return ROLE_LABELS[role] ?? role;
}

export function canWriteDatabase(user: Pick<User, "id" | "role"> | null | undefined, db: Pick<Database, "ownerUserId">): boolean {
  if (!user) return false;
  if (user.role === "admin") return true;
  return user.role === "db_owner" && db.ownerUserId === user.id;
}

export function useCanWriteDatabase(db: Pick<Database, "ownerUserId">): boolean {
  const { user } = useAuth();
  return canWriteDatabase(user, db);
}
