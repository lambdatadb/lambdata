import { useCallback, useEffect, useRef, useState } from "react";
import type { ImportPlan, ImportUpload } from "@lambdata/shared";
import { ApiError, errorMessage } from "../../lib/api";
import { discardUpload, fetchImportPlan, uploadImportFile } from "./api";

export interface ImportRefusal {
  fileName: string;
  sizeBytes: number;
  status: number | null;
  message: string;
}

export interface UploadingState {
  phase: "uploading";
  file: File;
  loaded: number;
  total: number;
  rate: number | null;
}

export type ImportSourceState =
  | { phase: "idle"; refusal: ImportRefusal | null }
  | UploadingState
  | { phase: "analysing"; file: File; upload: ImportUpload }
  | { phase: "ready"; file: File; upload: ImportUpload; plan: ImportPlan }
  | { phase: "plan-failed"; file: File; upload: ImportUpload; error: unknown };

export interface ImportSource {
  state: ImportSourceState;
  busy: boolean;
  start: (file: File) => void;
  cancel: () => void;
  reset: () => void;
  retryPlan: () => void;
  consume: (value?: boolean) => void;
}

const PROGRESS_INTERVAL_MS = 120;
const RATE_WINDOW_MS = 3_000;

function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

function hasServerMessage(error: ApiError): boolean {
  const body = error.body as { error?: unknown } | null;
  return !!body && typeof body === "object" && typeof body.error === "string";
}

function refusalFor(file: File, error: unknown): ImportRefusal {
  const base = { fileName: file.name, sizeBytes: file.size };
  if (error instanceof ApiError) {
    if (hasServerMessage(error)) return { ...base, status: error.status, message: errorMessage(error) };
    if (error.status === 413) {
      return { ...base, status: 413, message: "The file is larger than the server, or a proxy in front of it, accepts" };
    }
    return {
      ...base,
      status: error.status,
      message: `The upload was cut off with HTTP ${error.status} before LambData could look at the file. A proxy in front of LambData may limit upload sizes, or the file may be over the import limit`,
    };
  }
  return {
    ...base,
    status: null,
    message:
      "The upload stopped before the server answered. The connection may have dropped, or the server closed it because it refused the file (for example because it is larger than the import limit)",
  };
}

export function useImportSource(): ImportSource {
  const [state, setState] = useState<ImportSourceState>({ phase: "idle", refusal: null });
  const uploadAbort = useRef<AbortController | null>(null);
  const planAbort = useRef<AbortController | null>(null);
  const uploadId = useRef<string | null>(null);
  const consumed = useRef(false);
  const generation = useRef(0);

  const release = useCallback(() => {
    uploadAbort.current?.abort();
    uploadAbort.current = null;
    planAbort.current?.abort();
    planAbort.current = null;
    const id = uploadId.current;
    uploadId.current = null;
    if (id && !consumed.current) void discardUpload(id).catch(() => undefined);
    consumed.current = false;
  }, []);

  useEffect(
    () => () => {
      generation.current++;
      release();
    },
    [release],
  );

  const analyse = useCallback((file: File, upload: ImportUpload, gen: number) => {
    planAbort.current?.abort();
    const controller = new AbortController();
    planAbort.current = controller;
    setState({ phase: "analysing", file, upload });
    fetchImportPlan(upload.id, controller.signal).then(
      (plan) => {
        if (generation.current !== gen) return;
        planAbort.current = null;
        setState({ phase: "ready", file, upload, plan });
      },
      (error: unknown) => {
        if (generation.current !== gen || isAbort(error)) return;
        planAbort.current = null;
        setState({ phase: "plan-failed", file, upload, error });
      },
    );
  }, []);

  const start = useCallback(
    (file: File) => {
      release();
      const gen = ++generation.current;
      const controller = new AbortController();
      uploadAbort.current = controller;
      const samples: { at: number; loaded: number }[] = [{ at: performance.now(), loaded: 0 }];
      let lastPaint = 0;
      setState({ phase: "uploading", file, loaded: 0, total: file.size, rate: null });
      uploadImportFile(file, {
        signal: controller.signal,
        onProgress: ({ loaded, total }) => {
          if (generation.current !== gen) return;
          const now = performance.now();
          samples.push({ at: now, loaded });
          while (samples.length > 2 && now - samples[0]!.at > RATE_WINDOW_MS) samples.shift();
          if (now - lastPaint < PROGRESS_INTERVAL_MS && loaded < (total ?? file.size)) return;
          lastPaint = now;
          const first = samples[0]!;
          const elapsed = (now - first.at) / 1000;
          const rate = elapsed > 0.25 ? (loaded - first.loaded) / elapsed : null;
          setState({ phase: "uploading", file, loaded, total: total ?? file.size, rate });
        },
      }).then(
        (upload) => {
          if (generation.current !== gen) {
            void discardUpload(upload.id).catch(() => undefined);
            return;
          }
          uploadAbort.current = null;
          uploadId.current = upload.id;
          consumed.current = false;
          analyse(file, upload, gen);
        },
        (error: unknown) => {
          if (generation.current !== gen) return;
          uploadAbort.current = null;
          if (isAbort(error)) {
            setState({ phase: "idle", refusal: null });
            return;
          }
          setState({ phase: "idle", refusal: refusalFor(file, error) });
        },
      );
    },
    [analyse, release],
  );

  const reset = useCallback(() => {
    generation.current++;
    release();
    setState({ phase: "idle", refusal: null });
  }, [release]);

  const retryPlan = useCallback(() => {
    if (state.phase !== "plan-failed") return;
    analyse(state.file, state.upload, generation.current);
  }, [analyse, state]);

  const consume = useCallback((value = true) => {
    consumed.current = value;
  }, []);

  return {
    state,
    busy: state.phase === "uploading" || state.phase === "analysing",
    start,
    cancel: reset,
    reset,
    retryPlan,
    consume,
  };
}
