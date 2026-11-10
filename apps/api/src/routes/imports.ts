import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import type { ImportLimitsResponse, ImportPlanResponse, ImportUploadResponse } from "@lambdata/shared";
import { requireAuth, type AuthVariables } from "../auth/middleware";
import { audit } from "../db/queries";
import { publicUpload } from "../db/queries/imports";
import { disableRequestTimeout } from "../jobs";
import { createDatabaseFromUpload, getImportPlan } from "../imports/run";
import {
  IMPORT_ACTION,
  cleanFileName,
  deleteUpload,
  maxImportBytes,
  receiveUpload,
  requireUpload,
  uploadInUse,
} from "../imports/uploads";
import { assertDiskRoom } from "../util/disk";
import { isSafeHostPattern } from "../util/ident";
import { parseJson } from "../util/validate";

export const importsRoute = new Hono<{ Variables: AuthVariables }>();

importsRoute.use("*", requireAuth);

const hostPattern = z
  .string()
  .trim()
  .min(1)
  .max(255)
  .refine(isSafeHostPattern, "must be a MariaDB host pattern such as % or 192.168.1.%");

const createSchema = z.object({
  displayName: z.string().trim().min(1, "displayName required").max(200),
  connectionsFrom: z.union([hostPattern, z.literal("")]).optional(),
  tailnetOnly: z.boolean().optional(),
  versioned: z.boolean().optional(),
});

function forbidViewers(role: string): void {
  if (role === "viewer") throw new HTTPException(403, { message: "viewers cannot import databases" });
}

importsRoute.get("/limits", (c) => {
  const body: ImportLimitsResponse = { maxUploadBytes: maxImportBytes() };
  return c.json(body);
});

importsRoute.post("/uploads", async (c) => {
  const user = c.get("user");
  forbidViewers(user.role);
  disableRequestTimeout(c);
  const fileName = cleanFileName(c.req.header("x-file-name"));
  const length = c.req.header("content-length");
  const upload = await receiveUpload({
    body: c.req.raw.body,
    fileName,
    userId: user.id,
    role: user.role,
    declaredLength: length !== undefined && /^\d+$/.test(length) ? Number(length) : null,
  });
  audit.log(user.id, "import.upload", upload.id, { fileName, sizeBytes: upload.sizeBytes, format: upload.format });
  const body: ImportUploadResponse = { upload: publicUpload(upload) };
  return c.json(body, 201);
});

importsRoute.get("/uploads/:id", (c) => {
  const upload = requireUpload(c.get("user"), c.req.param("id"));
  const body: ImportUploadResponse = { upload: publicUpload(upload) };
  return c.json(body);
});

importsRoute.delete("/uploads/:id", async (c) => {
  const upload = requireUpload(c.get("user"), c.req.param("id"));
  if (uploadInUse(upload.id)) throw new HTTPException(409, { message: "this upload is being imported right now" });
  await deleteUpload(upload.id);
  return c.json({ ok: true });
});

importsRoute.get("/uploads/:id/plan", async (c) => {
  const upload = requireUpload(c.get("user"), c.req.param("id"));
  disableRequestTimeout(c);
  const body: ImportPlanResponse = { plan: await getImportPlan(upload) };
  return c.json(body);
});

importsRoute.post("/uploads/:id/create-database", async (c) => {
  const user = c.get("user");
  forbidViewers(user.role);
  const upload = requireUpload(user, c.req.param("id"));
  if (uploadInUse(upload.id)) throw new HTTPException(409, { message: "this upload is being imported right now" });
  const body = await parseJson(c, createSchema);
  assertDiskRoom(IMPORT_ACTION, upload.sizeBytes);
  disableRequestTimeout(c);
  const result = await createDatabaseFromUpload({
    user,
    upload,
    displayName: body.displayName,
    connectionsFrom: body.connectionsFrom || undefined,
    tailnetOnly: body.tailnetOnly,
    versioned: body.versioned,
  });
  return c.json(result, 202);
});
