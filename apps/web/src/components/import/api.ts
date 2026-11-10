import { useQuery } from "@tanstack/react-query";
import type {
  ImportCreateDatabaseRequest,
  ImportCreateDatabaseResponse,
  ImportLimitsResponse,
  ImportListResponse,
  ImportPlan,
  ImportPlanResponse,
  ImportReplaceRequest,
  ImportUpload,
  ImportUploadResponse,
  JobResponse,
} from "@lambdata/shared";
import { api, type UploadProgress } from "../../lib/api";
import { isNotFound } from "../../lib/queries";

export function uploadImportFile(
  file: File,
  options: { onProgress?: (progress: UploadProgress) => void; signal?: AbortSignal } = {},
): Promise<ImportUpload> {
  return api
    .upload<ImportUploadResponse>("/imports/uploads", file, {
      headers: {
        "Content-Type": "application/octet-stream",
        "X-File-Name": encodeURIComponent(file.name || "upload.db"),
      },
      onProgress: options.onProgress,
      signal: options.signal,
    })
    .then((res) => res.upload);
}

export function fetchImportPlan(uploadId: string, signal?: AbortSignal): Promise<ImportPlan> {
  return api.get<ImportPlanResponse>(`/imports/uploads/${encodeURIComponent(uploadId)}/plan`, { signal }).then((res) => res.plan);
}

export function discardUpload(uploadId: string): Promise<unknown> {
  return api.delete(`/imports/uploads/${encodeURIComponent(uploadId)}`);
}

export function createDatabaseFromUpload(uploadId: string, body: ImportCreateDatabaseRequest): Promise<ImportCreateDatabaseResponse> {
  return api.post<ImportCreateDatabaseResponse>(`/imports/uploads/${encodeURIComponent(uploadId)}/create-database`, body);
}

export function replaceDatabaseFromUpload(databaseId: string, uploadId: string): Promise<JobResponse> {
  const body: ImportReplaceRequest = { uploadId };
  return api.post<JobResponse>(`/databases/${encodeURIComponent(databaseId)}/imports`, body);
}

export function useImportHistory(databaseId: string) {
  return useQuery({
    queryKey: ["imports", "history", databaseId],
    queryFn: () => api.get<ImportListResponse>(`/databases/${encodeURIComponent(databaseId)}/imports`),
    select: (data) => data.imports,
  });
}

export function useImportLimits() {
  return useQuery({
    queryKey: ["imports", "limits"],
    queryFn: async (): Promise<ImportLimitsResponse | null> => {
      try {
        return await api.get<ImportLimitsResponse>("/imports/limits");
      } catch (error) {
        if (isNotFound(error)) return null;
        throw error;
      }
    },
    staleTime: 10 * 60_000,
    retry: false,
  });
}
