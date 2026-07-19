import { Hono, type Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { getCookie } from "hono/cookie";
import { existsSync } from "node:fs";
import { dirname } from "node:path";
import type { PathValidationResponse, PickFolderResponse } from "@kilndb/shared";
import { settings, users, audit } from "../db/queries";
import { COOKIE_NAME, verifyJwt } from "../auth/jwt";
import { type AuthVariables, requireAuth } from "../auth/middleware";
import { validateDataDirPath } from "../util/dataDirMigration";

export const systemRoute = new Hono<{ Variables: AuthVariables }>();

// These endpoints are usable both during initial setup (no auth yet) and from
// the authenticated Settings page once setup is complete. Gate accordingly.
async function gate(c: Context<{ Variables: AuthVariables }>): Promise<void> {
  if (settings.get("setup_complete") !== "1") return;
  const token = getCookie(c, COOKIE_NAME);
  if (!token) throw new HTTPException(401, { message: "not authenticated" });
  const claims = await verifyJwt(token);
  if (!claims) throw new HTTPException(401, { message: "invalid session" });
  const user = users.byId(claims.sub);
  if (!user) throw new HTTPException(401, { message: "user not found" });
  if (user.role !== "admin") throw new HTTPException(403, { message: "admin only" });
}

systemRoute.post("/pick-folder", async (c) => {
  await gate(c);
  if (process.platform !== "darwin" || !Bun.which("osascript")) {
    const res: PickFolderResponse = { canceled: true, path: null, unsupported: true };
    return c.json(res);
  }
  const body = (await c.req.json().catch(() => ({}))) as { prompt?: string; default?: string };
  const promptText = body.prompt?.trim() || "Select KilnDB data directory";
  const defaultPath = body.default?.trim();

  // osascript opens a native folder picker on the host running the API —
  // appropriate for the "running on user's own Mac" use case.
  // `default location` needs an existing folder, otherwise AppleScript fails
  // with -1700 trying to coerce a non-existent POSIX file to an alias. Walk up
  // to the nearest ancestor that actually exists.
  const anchor = defaultPath ? nearestExistingDir(defaultPath) : null;
  const script = anchor
    ? `POSIX path of (choose folder with prompt "${escapeForOsa(promptText)}" default location (POSIX file "${escapeForOsa(anchor)}"))`
    : `POSIX path of (choose folder with prompt "${escapeForOsa(promptText)}")`;

  const proc = Bun.spawn(["osascript", "-e", script], { stdout: "pipe", stderr: "pipe" });
  const exit = await proc.exited;
  if (exit !== 0) {
    const err = await new Response(proc.stderr).text();
    if (err.includes("User canceled") || err.includes("-128")) {
      const res: PickFolderResponse = { canceled: true, path: null };
      return c.json(res);
    }
    throw new HTTPException(500, { message: `folder picker failed: ${err.trim() || `exit ${exit}`}` });
  }
  const path = (await new Response(proc.stdout).text()).trim().replace(/\/$/, "");
  const res: PickFolderResponse = { canceled: false, path };
  return c.json(res);
});

systemRoute.post("/validate-path", async (c) => {
  await gate(c);
  const body = (await c.req.json()) as { path?: string };
  if (!body.path) throw new HTTPException(400, { message: "path required" });
  const v = validateDataDirPath(body.path);
  const res: PathValidationResponse = {
    ok: v.ok,
    error: v.error ?? null,
    resolvedPath: v.resolvedPath,
    exists: v.exists,
    writable: v.writable,
    freeBytes: v.freeBytes,
    isEmpty: v.isEmpty,
  };
  return c.json(res);
});

systemRoute.get("/audit-logs", requireAuth, (c) => {
  const limit = Number(c.req.query("limit") ?? "20");
  const logs = audit.list(limit);
  return c.json({ logs });
});

function escapeForOsa(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function nearestExistingDir(p: string): string | null {
  let cur = p;
  while (cur && cur !== "/" && cur !== "." && !existsSync(cur)) {
    const parent = dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return cur && existsSync(cur) ? cur : null;
}
