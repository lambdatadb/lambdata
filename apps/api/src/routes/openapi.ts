import { Hono } from "hono";
import { requireAuth, type AuthVariables } from "../auth/middleware";
import { buildOpenApiDocument } from "../openapi/document";

export const openApiRoute = new Hono<{ Variables: AuthVariables }>();

openApiRoute.get("/", requireAuth, (c) => {
  const origin = new URL(c.req.url).origin;
  return c.json(buildOpenApiDocument(origin));
});
