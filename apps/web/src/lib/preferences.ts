import type { QueryClient } from "@tanstack/react-query";
import type { ColorTheme, User } from "@lambdata/shared";
import { api } from "./api";
import { queryKeys } from "./queries";
import { applyColorTheme } from "./theme";

function patchCachedUser(qc: QueryClient, patch: Partial<User>): void {
  qc.setQueryData<{ user: User | null }>(queryKeys.auth, (data) =>
    data?.user ? { user: { ...data.user, ...patch } } : data,
  );
}

export async function updateColorTheme(qc: QueryClient, user: User, theme: ColorTheme): Promise<void> {
  const previous = user.colorTheme;
  if (previous === theme) return;
  applyColorTheme(theme, true);
  patchCachedUser(qc, { colorTheme: theme });
  try {
    await api.patch(`/users/${user.id}`, { colorTheme: theme });
  } catch (error) {
    applyColorTheme(previous, true);
    patchCachedUser(qc, { colorTheme: previous });
    throw error;
  }
}
