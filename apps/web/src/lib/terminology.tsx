import { t, type TerminologyKey } from "@kilndb/shared";
import { useAuth } from "./auth";

export function useTerminology(): (key: TerminologyKey) => string {
  const { user } = useAuth();
  const level = user?.experienceLevel ?? "advanced";
  return (key) => t(level, key);
}
