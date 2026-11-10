import type { StorageObject } from "@lambdata/shared";
import { ApiError, STALE_PAGE_MESSAGE } from "../../lib/api";

export const MAX_UPLOAD_BYTES = 250 * 1024 * 1024;

const INLINE_SAFE_TYPES: ReadonlySet<string> = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/avif",
  "image/bmp",
  "image/x-icon",
  "image/vnd.microsoft.icon",
  "text/plain",
]);

export function canPreviewInline(mimeType: string | null): boolean {
  const essence = mimeType?.split(";")[0]?.trim().toLowerCase();
  return !!essence && INLINE_SAFE_TYPES.has(essence);
}

export interface UploadHandle {
  promise: Promise<StorageObject>;
  abort: () => void;
}

export function uploadObject(
  bucketId: string,
  file: File,
  options: { upsert?: boolean; onProgress?: (fraction: number) => void } = {},
): UploadHandle {
  const xhr = new XMLHttpRequest();
  const promise = new Promise<StorageObject>((resolve, reject) => {
    const query = options.upsert ? "?upsert=1" : "";
    xhr.open("POST", `/api/storage/buckets/${encodeURIComponent(bucketId)}/objects${query}`);
    xhr.withCredentials = true;
    xhr.setRequestHeader("X-File-Name", encodeURIComponent(file.name));
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable && event.total > 0) options.onProgress?.(event.loaded / event.total);
    };
    xhr.onload = () => {
      let body: { object?: StorageObject; error?: string } | null = null;
      try {
        body = JSON.parse(xhr.responseText) as { object?: StorageObject; error?: string };
      } catch {
        body = null;
      }
      if (xhr.status >= 200 && xhr.status < 300 && body?.object) {
        resolve(body.object);
        return;
      }
      if (xhr.status === 415) {
        reject(new ApiError(STALE_PAGE_MESSAGE, xhr.status, body));
        return;
      }
      reject(new ApiError(body?.error || xhr.statusText || "Upload failed", xhr.status, body));
    };
    xhr.onerror = () => reject(new ApiError("The upload was interrupted by a network error", 0));
    xhr.onabort = () => reject(new ApiError("Upload cancelled", 0));
    const form = new FormData();
    form.append("file", file);
    xhr.send(form);
  });
  return { promise, abort: () => xhr.abort() };
}

export function publicObjectPath(bucketName: string, objectName: string): string {
  return `/api/storage/public/${encodeURIComponent(bucketName)}/${objectName.split("/").map(encodeURIComponent).join("/")}`;
}

export function downloadPath(bucketId: string, objectId: string): string {
  return `/api/storage/buckets/${encodeURIComponent(bucketId)}/objects/${encodeURIComponent(objectId)}/download`;
}

export function previewPath(bucketId: string, objectId: string): string {
  return `${downloadPath(bucketId, objectId)}?inline=1`;
}
