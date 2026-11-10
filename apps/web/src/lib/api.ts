import { friendlyJobConflict } from "./jobKinds";

export class ApiError extends Error {
  status: number;
  body: unknown;
  constructor(message: string, status: number, body?: unknown) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.body = body ?? null;
  }
}

export const STALE_PAGE_MESSAGE = "LambData was updated after this page was opened. Reload the page, then try again.";

export function isStalePage(error: unknown): boolean {
  return error instanceof ApiError && error.status === 415;
}

export function isApiError(error: unknown): error is ApiError {
  return error instanceof ApiError;
}

export function errorMessage(error: unknown, fallback = "Something went wrong"): string {
  if (error instanceof ApiError) return error.message || fallback;
  if (error instanceof DOMException && error.name === "AbortError") return "Request cancelled";
  if (error instanceof TypeError) return "Could not reach the server. Check that LambData is running.";
  if (error instanceof Error && error.message) return error.message;
  return fallback;
}

type UnauthorizedHandler = (path: string) => void;

let unauthorizedHandler: UnauthorizedHandler | null = null;

const UNAUTHORIZED_EXEMPT = new Set(["/auth/login"]);

export function setUnauthorizedHandler(handler: UnauthorizedHandler | null): void {
  unauthorizedHandler = handler;
}

function notifyUnauthorized(path: string): void {
  const bare = path.split("?")[0] ?? path;
  if (UNAUTHORIZED_EXEMPT.has(bare)) return;
  unauthorizedHandler?.(bare);
}

function parseBody(text: string, contentType: string | null): unknown {
  const isJson = contentType?.includes("application/json");
  if (isJson && text) {
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
  return text;
}

function failure(status: number, statusText: string, body: unknown): ApiError {
  const fromBody =
    body && typeof body === "object" && typeof (body as { error?: unknown }).error === "string"
      ? (body as { error: string }).error
      : null;
  if (status === 415) return new ApiError(STALE_PAGE_MESSAGE, status, body);
  const friendly = status === 409 && fromBody ? friendlyJobConflict(fromBody) : null;
  return new ApiError(friendly ?? fromBody ?? (statusText || `Request failed (${status})`), status, body);
}

export function absoluteUrl(path: string): string {
  if (typeof window === "undefined") return path;
  return `${window.location.origin}${path}`;
}

const BODY_METHODS = new Set(["POST", "PUT", "PATCH"]);

function sendsJson(init: RequestInit): boolean {
  if (init.body instanceof FormData || init.body instanceof Blob) return false;
  if (init.body) return true;
  return BODY_METHODS.has((init.method ?? "GET").toUpperCase());
}

export async function apiFetch<T = unknown>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (!headers.has("Content-Type") && sendsJson(init)) {
    headers.set("Content-Type", "application/json");
  }
  const res = await fetch(`/api${path}`, {
    ...init,
    headers,
    credentials: "include",
  });
  const text = await res.text();
  const body = parseBody(text, res.headers.get("content-type"));
  if (!res.ok) {
    if (res.status === 401) notifyUnauthorized(path);
    throw failure(res.status, res.statusText, body);
  }
  return body as T;
}

export interface RequestOptions {
  signal?: AbortSignal;
  headers?: HeadersInit;
}

export interface UploadProgress {
  loaded: number;
  total: number | null;
  fraction: number | null;
}

export interface UploadOptions {
  method?: "POST" | "PUT";
  headers?: Record<string, string>;
  onProgress?: (progress: UploadProgress) => void;
  signal?: AbortSignal;
}

function jsonInit(method: string, body: unknown, options?: RequestOptions): RequestInit {
  return {
    method,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: options?.signal,
    headers: options?.headers,
  };
}

function upload<T>(path: string, file: Blob, options: UploadOptions = {}): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open(options.method ?? "POST", `/api${path}`);
    xhr.withCredentials = true;
    const headers = options.headers ?? {};
    const hasContentType = Object.keys(headers).some((h) => h.toLowerCase() === "content-type");
    if (!hasContentType) xhr.setRequestHeader("Content-Type", file.type || "application/octet-stream");
    for (const [name, value] of Object.entries(headers)) xhr.setRequestHeader(name, value);
    const abort = () => xhr.abort();
    if (options.signal) {
      if (options.signal.aborted) {
        reject(new DOMException("Upload cancelled", "AbortError"));
        return;
      }
      options.signal.addEventListener("abort", abort, { once: true });
    }
    const cleanup = () => options.signal?.removeEventListener("abort", abort);
    xhr.upload.onprogress = (event) => {
      const total = event.lengthComputable ? event.total : file.size || null;
      options.onProgress?.({
        loaded: event.loaded,
        total,
        fraction: total ? Math.min(1, event.loaded / total) : null,
      });
    };
    xhr.onload = () => {
      cleanup();
      const body = parseBody(xhr.responseText, xhr.getResponseHeader("content-type"));
      if (xhr.status >= 200 && xhr.status < 300) {
        options.onProgress?.({ loaded: file.size, total: file.size, fraction: 1 });
        resolve(body as T);
        return;
      }
      if (xhr.status === 401) notifyUnauthorized(path);
      reject(failure(xhr.status, xhr.statusText, body));
    };
    xhr.onerror = () => {
      cleanup();
      reject(new TypeError("Network error during upload"));
    };
    xhr.onabort = () => {
      cleanup();
      reject(new DOMException("Upload cancelled", "AbortError"));
    };
    xhr.send(file);
  });
}

export const api = {
  get: <T,>(path: string, options?: RequestOptions) =>
    apiFetch<T>(path, { signal: options?.signal, headers: options?.headers }),
  post: <T,>(path: string, body?: unknown, options?: RequestOptions) => apiFetch<T>(path, jsonInit("POST", body, options)),
  put: <T,>(path: string, body?: unknown, options?: RequestOptions) => apiFetch<T>(path, jsonInit("PUT", body, options)),
  patch: <T,>(path: string, body?: unknown, options?: RequestOptions) => apiFetch<T>(path, jsonInit("PATCH", body, options)),
  delete: <T,>(path: string, options?: RequestOptions) =>
    apiFetch<T>(path, { method: "DELETE", signal: options?.signal, headers: options?.headers }),
  upload,
  downloadUrl: (path: string) => `/api${path}`,
};
