import { useCallback } from "react";
import { useSearchParams } from "react-router-dom";

export const CREATE_DATABASE_PARAM = "new";

export function useCreateDatabaseDialog() {
  const [params, setParams] = useSearchParams();
  const type = params.get(CREATE_DATABASE_PARAM);
  const open = useCallback(
    (next?: string) => {
      setParams(
        (prev) => {
          const copy = new URLSearchParams(prev);
          copy.set(CREATE_DATABASE_PARAM, next || "standard");
          return copy;
        },
        { replace: true },
      );
    },
    [setParams],
  );
  const close = useCallback(() => {
    setParams(
      (prev) => {
        const copy = new URLSearchParams(prev);
        copy.delete(CREATE_DATABASE_PARAM);
        return copy;
      },
      { replace: true },
    );
  }, [setParams]);
  return { type, isOpen: type !== null, open, close };
}
