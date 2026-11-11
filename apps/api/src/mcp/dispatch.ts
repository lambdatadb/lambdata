import type { Hono } from "hono";

let root: Hono | null = null;

export function setRootApp(app: Hono): void {
  root = app;
}

export async function dispatchInternal(request: Request): Promise<Response> {
  if (!root) throw new Error("the API is not ready");
  return root.fetch(request);
}
