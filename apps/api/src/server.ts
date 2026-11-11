import { join, resolve } from "node:path";
import { Hono, type MiddlewareHandler } from "hono";
import { cors } from "hono/cors";
import { APPROVAL_HEADER, NOTE_HEADER } from "@lambdata/shared";
import { logger } from "hono/logger";
import { HTTPException } from "hono/http-exception";
import { authRoute } from "./routes/auth";
import { setupRoute } from "./routes/setup";
import { usersRoute } from "./routes/users";
import { databasesRoute } from "./routes/databases";
import { syncRoute } from "./routes/sync";
import { checkpointsRoute } from "./routes/checkpoints";
import { databaseImportsRoute } from "./routes/databaseImports";
import { importsRoute } from "./routes/imports";
import { jobsRoute } from "./routes/jobs";
import { networkRoute } from "./routes/network";
import { queryRoute } from "./routes/query";
import { metricsRoute } from "./routes/metrics";
import { dashboardRoute } from "./routes/dashboard";
import { tailscaleRoute } from "./routes/tailscale";
import { settingsRoute } from "./routes/settings";
import { systemRoute } from "./routes/system";
import { storageRoute } from "./routes/storage";
import { appAuthRoute } from "./routes/appAuth";
import { dataApiRoute } from "./routes/dataApi";
import { dataDocsRoute } from "./routes/dataDocs";
import { dataPoliciesRoute } from "./routes/dataPolicies";
import { dataAccessRoute } from "./routes/dataAccess";
import { realtimeRoute } from "./routes/realtime";
import { functionsRoute } from "./routes/functions";
import { healthRoute } from "./routes/health";
import { notificationsRoute } from "./routes/notifications";
import { setAsideRoute } from "./routes/setAside";
import { accessTokensRoute } from "./routes/accessTokens";
import { approvalsRoute } from "./routes/approvals";
import { databaseRejectedConnectionsRoute, networkRejectedConnectionsRoute } from "./routes/rejectedConnections";
import { accessTokenGate } from "./accessTokens/gate";
import { invokeFunctionRequest } from "./functions/invoke";
import { env } from "./env";
import { isAllowedOrigin } from "./network/origins";
import { accessGuard } from "./network/guard";
import { requestForgeryGuard } from "./network/csrf";
import { JobConflictError, jobConflictResponse } from "./jobs";
import { UserOwnsResourcesError } from "./db/queries";
import { isDataDirMigrating } from "./util/dataDirMigration";

export const DEFAULT_BODY_LIMIT_BYTES = 10 * 1024 * 1024;
const STORAGE_UPLOAD_PATH = /^\/api\/storage\/buckets\/[^/]+\/objects\/?$/;

export class BodyTooLargeError extends Error {
  readonly limitBytes: number;

  constructor(limitBytes: number) {
    super(`request body too large (limit ${Math.round(limitBytes / (1024 * 1024))} MB)`);
    this.name = "BodyTooLargeError";
    this.limitBytes = limitBytes;
  }
}

export function bodyLimitFor(method: string, path: string): number | null {
  if (method !== "POST") return DEFAULT_BODY_LIMIT_BYTES;
  if (path === "/api/imports/uploads" || path === "/api/imports/uploads/") return null;
  if (STORAGE_UPLOAD_PATH.test(path)) return null;
  return DEFAULT_BODY_LIMIT_BYTES;
}

const requestBodyLimit: MiddlewareHandler = async (c, next) => {
  const raw = c.req.raw;
  if (!raw.body) return next();
  const limit = bodyLimitFor(raw.method, c.req.path);
  if (limit === null) return next();
  const length = raw.headers.get("content-length");
  if (length !== null && !raw.headers.has("transfer-encoding")) {
    if (Number(length) > limit) throw new BodyTooLargeError(limit);
    return next();
  }
  let seen = 0;
  const counted = raw.body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        seen += chunk.byteLength;
        if (seen > limit) controller.error(new BodyTooLargeError(limit));
        else controller.enqueue(chunk);
      },
    }),
  );
  c.req.raw = new Request(raw, { body: counted, duplex: "half" } as RequestInit);
  return next();
};

const maintenanceGate: MiddlewareHandler = async (c, next) => {
  const path = c.req.path;
  const gated = path.startsWith("/api/") || path.startsWith("/functions/");
  if (gated && path !== "/api/health" && isDataDirMigrating()) {
    return c.json({ error: "data directory migration in progress; try again shortly" }, 503);
  }
  return next();
};

export function buildApp(): Hono {
  const app = new Hono();
  app.use("*", logger());
  app.use(
    "*",
    cors({
      origin: (origin) => (isAllowedOrigin(origin) ? origin : ""),
      credentials: true,
      allowMethods: ["GET", "POST", "PATCH", "PUT", "DELETE", "OPTIONS"],
      allowHeaders: ["Content-Type", "Authorization", "X-File-Name", NOTE_HEADER, APPROVAL_HEADER],
    }),
  );
  app.use("*", accessGuard);
  app.use("*", requestForgeryGuard);
  app.use("*", accessTokenGate);
  app.use("*", maintenanceGate);
  app.use("*", requestBodyLimit);

  app.route("/api/health", healthRoute);
  app.route("/api/setup", setupRoute);
  app.route("/api/auth", authRoute);
  app.route("/api/users", usersRoute);
  app.route("/api/jobs", jobsRoute);
  app.route("/api/databases", databasesRoute);
  app.route("/api/databases", syncRoute);
  app.route("/api/databases", checkpointsRoute);
  app.route("/api/databases", databaseImportsRoute);
  app.route("/api/databases", queryRoute);
  app.route("/api/databases", metricsRoute);
  app.route("/api/databases", setAsideRoute);
  app.route("/api/databases", databaseRejectedConnectionsRoute);
  app.route("/api/imports", importsRoute);
  app.route("/api/network", networkRoute);
  app.route("/api/network", networkRejectedConnectionsRoute);
  app.route("/api/dashboard", dashboardRoute);
  app.route("/api/tailscale", tailscaleRoute);
  app.route("/api/settings", settingsRoute);
  app.route("/api/system", systemRoute);
  app.route("/api/storage", storageRoute);
  app.route("/api/app-auth", appAuthRoute);
  app.route("/api/data-docs", dataDocsRoute);
  app.route("/api/data-policies", dataPoliciesRoute);
  app.route("/api/data-access", dataAccessRoute);
  app.route("/api/data", dataApiRoute);
  app.route("/api/realtime", realtimeRoute);
  app.route("/api/notifications", notificationsRoute);
  app.route("/api/access-tokens", accessTokensRoute);
  app.route("/api/approvals", approvalsRoute);
  app.all("/functions/v1/*", (c) => invokeFunctionRequest(c.req.raw, "/functions/v1"));
  app.all("/api/functions/v1/*", (c) => invokeFunctionRequest(c.req.raw, "/api/functions/v1"));
  app.route("/api/functions", functionsRoute);

  if (env.webDist) {
    const webRoot = resolve(env.webDist);
    app.get("*", async (c, next) => {
      const path = c.req.path;
      if (
        path.startsWith("/api") ||
        path === "/functions/v1" ||
        path.startsWith("/functions/v1/")
      ) return next();
      const rel = path === "/" ? "index.html" : path.replace(/^\/+/, "");
      const target = resolve(join(webRoot, rel));
      const insideRoot = target === webRoot || target.startsWith(`${webRoot}/`);
      let file = insideRoot ? Bun.file(target) : null;
      if (!file || !(await file.exists())) {
        file = Bun.file(join(webRoot, "index.html"));
      }
      if (await file.exists()) {
        return new Response(file, { headers: { "Content-Type": file.type } });
      }
      return next();
    });
  }

  app.onError((err, c) => {
    if (err instanceof HTTPException) {
      return c.json({ error: err.message }, err.status);
    }
    if (err instanceof JobConflictError) return jobConflictResponse(c, err);
    if (err instanceof UserOwnsResourcesError) return c.json({ error: err.message }, 409);
    if (err instanceof BodyTooLargeError) return c.json({ error: err.message }, 413);
    console.error("[api]", err);
    return c.json({ error: "internal server error" }, 500);
  });

  app.notFound((c) => c.json({ error: "not found" }, 404));

  return app;
}
