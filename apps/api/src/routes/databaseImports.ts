import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import type { ImportListResponse } from "@lambdata/shared";
import { requireAuth, requireDbAccess, type AuthVariables } from "../auth/middleware";
import { imports } from "../db/queries";
import { disableRequestTimeout, jobAcceptedResponse } from "../jobs";
import { replaceDatabaseFromUpload } from "../imports/run";
import { IMPORT_ACTION, requireUpload, uploadInUse } from "../imports/uploads";
import { assertDiskRoom } from "../util/disk";
import { parseJson } from "../util/validate";

export const databaseImportsRoute = new Hono<{ Variables: AuthVariables }>();

databaseImportsRoute.use("*", requireAuth);

const replaceSchema = z.object({
  uploadId: z.string().trim().min(1).max(64),
});

databaseImportsRoute.get("/:id/imports", requireDbAccess("id", "read"), (c) => {
  const body: ImportListResponse = { imports: imports.listRecords(c.req.param("id")) };
  return c.json(body);
});

databaseImportsRoute.post("/:id/imports", requireDbAccess("id", "owner"), async (c) => {
  const user = c.get("user");
  const body = await parseJson(c, replaceSchema);
  const upload = requireUpload(user, body.uploadId);
  if (uploadInUse(upload.id)) throw new HTTPException(409, { message: "this upload is being imported right now" });
  assertDiskRoom(IMPORT_ACTION, upload.sizeBytes);
  disableRequestTimeout(c);
  const job = await replaceDatabaseFromUpload({ user, databaseId: c.req.param("id"), upload });
  return jobAcceptedResponse(c, job);
});
