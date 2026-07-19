export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

export async function apiFetch<T = unknown>(
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body && !headers.has("Content-Type") && !(init.body instanceof FormData)) {
    headers.set("Content-Type", "application/json");
  }
  const res = await fetch(`/api${path}`, {
    ...init,
    headers,
    credentials: "include",
  });
  const text = await res.text();
  const isJson = res.headers.get("content-type")?.includes("application/json");
  const body = isJson && text ? JSON.parse(text) : text;
  if (!res.ok) {
    const msg = isJson ? (body as { error?: string }).error ?? res.statusText : res.statusText;
    throw new ApiError(msg, res.status);
  }
  return body as T;
}

export const api = {
  get: <T,>(path: string) => apiFetch<T>(path),
  post: <T,>(path: string, body?: unknown) =>
    apiFetch<T>(path, { method: "POST", body: body !== undefined ? JSON.stringify(body) : undefined }),
  put: <T,>(path: string, body?: unknown) =>
    apiFetch<T>(path, { method: "PUT", body: body !== undefined ? JSON.stringify(body) : undefined }),
  patch: <T,>(path: string, body?: unknown) =>
    apiFetch<T>(path, { method: "PATCH", body: body !== undefined ? JSON.stringify(body) : undefined }),
  postForm: <T,>(path: string, body: FormData) =>
    apiFetch<T>(path, { method: "POST", body }),
  delete: <T,>(path: string) => apiFetch<T>(path, { method: "DELETE" }),
};
