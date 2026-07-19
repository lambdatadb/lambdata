import { join, resolve } from "node:path";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { HTTPException } from "hono/http-exception";
import { authRoute } from "./routes/auth";
import { setupRoute } from "./routes/setup";
import { usersRoute } from "./routes/users";
import { databasesRoute } from "./routes/databases";
import { syncRoute } from "./routes/sync";
import { snapshotsRoute } from "./routes/snapshots";
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
import { realtimeRoute } from "./routes/realtime";
import { functionsRoute } from "./routes/functions";
import { healthRoute } from "./routes/health";
import { invokeFunctionRequest } from "./functions/invoke";
import { env } from "./env";

export function buildApp(): Hono {
  const app = new Hono();
  const allowedOrigins = new Set([
    env.webOrigin,
    `http://${env.host}:${env.port}`,
    ...env.extraOrigins,
  ]);
  app.use("*", logger());
  app.use(
    "*",
    cors({
      origin: (origin) => (allowedOrigins.has(origin) ? origin : ""),
      credentials: true,
      allowMethods: ["GET", "POST", "PATCH", "PUT", "DELETE", "OPTIONS"],
      allowHeaders: ["Content-Type", "Authorization"],
    }),
  );

  app.route("/api/health", healthRoute);
  app.route("/api/setup", setupRoute);
  app.route("/api/auth", authRoute);
  app.route("/api/users", usersRoute);
  app.route("/api/databases", databasesRoute);
  app.route("/api/databases", syncRoute);
  app.route("/api/databases", snapshotsRoute);
  app.route("/api/databases", queryRoute);
  app.route("/api/databases", metricsRoute);
  app.route("/api/dashboard", dashboardRoute);
  app.route("/api/tailscale", tailscaleRoute);
  app.route("/api/settings", settingsRoute);
  app.route("/api/system", systemRoute);
  app.route("/api/storage", storageRoute);
  app.route("/api/app-auth", appAuthRoute);
  app.route("/api/data-docs", dataDocsRoute);
  app.route("/api/data-policies", dataPoliciesRoute);
  app.route("/api/data", dataApiRoute);
  app.route("/api/realtime", realtimeRoute);
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
    console.error("[api]", err);
    return c.json({ error: "internal server error" }, 500);
  });

  app.notFound((c) => c.json({ error: "not found" }, 404));

  return app;
}
