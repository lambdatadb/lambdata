import { Hono, type MiddlewareHandler } from "hono";
import { z } from "zod";
import { HTTPException } from "hono/http-exception";
import { existsSync } from "node:fs";
import { dirname } from "node:path";
import type { PathValidationResponse, PickFolderResponse } from "@lambdata/shared";
import { settings, audit } from "../db/queries";
import {
  BEFORE_SETUP_LOOPBACK_MESSAGE,
  type AuthVariables,
  isLoopbackRequest,
  requireAuth,
  requireRole,
} from "../auth/middleware";
import { validateDataDirPath } from "../util/dataDirMigration";
import { parseJson, parseQuery } from "../util/validate";
import { refuseToken } from "./setup";

export const systemRoute = new Hono<{ Variables: AuthVariables }>();

const requireAdmin = requireRole("admin");

const loopbackBeforeSetupOrAdmin: MiddlewareHandler<{ Variables: AuthVariables }> = async (c, next) => {
  if (settings.get("setup_complete") !== "1") {
    if (!isLoopbackRequest(c)) throw new HTTPException(403, { message: BEFORE_SETUP_LOOPBACK_MESSAGE });
    return next();
  }
  return requireAuth(c, async () => {
    await requireAdmin(c, next);
  });
};

const setupTokenBeforeSetupOrAdmin: MiddlewareHandler<{ Variables: AuthVariables }> = async (c, next) => {
  if (settings.get("setup_complete") !== "1") return next();
  return requireAuth(c, async () => {
    await requireAdmin(c, next);
  });
};

const pickFolderSchema = z.object({
  prompt: z.string().max(200).optional(),
  default: z.string().max(4096).optional(),
});

const validatePathSchema = z.object({
  path: z.string({ error: "path required" }).min(1, "path required"),
  setupToken: z.string().max(200, "setup token is too long").optional(),
});

systemRoute.post("/pick-folder", loopbackBeforeSetupOrAdmin, async (c) => {
  if (process.platform !== "darwin" || !Bun.which("osascript")) {
    const res: PickFolderResponse = { canceled: true, path: null, unsupported: true };
    return c.json(res);
  }
  const body = await parseJson(c, pickFolderSchema);
  const promptText = body.prompt?.trim() || "Select LambData data directory";
  const defaultPath = body.default?.trim();

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

systemRoute.post("/validate-path", setupTokenBeforeSetupOrAdmin, async (c) => {
  const body = await parseJson(c, validatePathSchema);
  if (settings.get("setup_complete") !== "1") {
    const refused = refuseToken(c, body.setupToken);
    if (refused) return refused;
  }
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

const auditQuerySchema = z.object({
  limit: z.coerce.number().int().catch(20).transform((n) => Math.min(500, Math.max(1, n))).default(20),
});

systemRoute.get("/audit-logs", requireAuth, requireAdmin, (c) => {
  const { limit } = parseQuery(c, auditQuerySchema);
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
