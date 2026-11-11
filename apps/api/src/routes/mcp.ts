import { Hono, type Context } from "hono";
import { currentAccessToken } from "../accessTokens/index";
import { checkRequestOrigin, isJsonContentType, requestOrigin } from "../network/csrf";
import {
  INVALID_REQUEST,
  PARSE_ERROR,
  classify,
  handleRequest,
  isSupportedVersion,
  rpcError,
} from "../mcp/protocol";

export const mcpRoute = new Hono();

const VERSION_HEADER = "mcp-protocol-version";

function methodNotAllowed(c: Context): Response {
  return c.json(
    {
      error: "This MCP endpoint is stateless and answers only POST requests with JSON-RPC messages. It has no event stream and no session to delete.",
    },
    405,
    { Allow: "POST" },
  );
}

function unauthenticated(c: Context): Response {
  return c.json(
    {
      error:
        "This MCP endpoint needs an access token. Send it as Authorization: Bearer ld_… . An admin creates access tokens in the LambData console under Access tokens. Signing in to the console does not work here.",
    },
    401,
    { "WWW-Authenticate": 'Bearer realm="LambData"' },
  );
}

function originRefused(c: Context): Response | null {
  const origin = c.req.header("origin");
  if (origin === undefined) return null;
  const verdict = checkRequestOrigin({ ...requestOrigin(c), fetchSite: null, origin });
  if (verdict.ok && origin.trim() !== "") return null;
  return c.json(
    {
      error: `Requests to this MCP endpoint from the web page at ${origin.slice(0, 120)} are refused, because it is not an address of this LambData server. MCP clients that run outside a browser do not send an Origin header.`,
    },
    403,
  );
}

mcpRoute.post("/", async (c) => {
  const refused = originRefused(c);
  if (refused) return refused;
  const access = currentAccessToken(c);
  if (!access) return unauthenticated(c);
  if (!isJsonContentType(c.req.header("content-type"))) {
    return c.json(rpcError(null, INVALID_REQUEST, "Send JSON-RPC messages with Content-Type: application/json."), 415);
  }
  const version = c.req.header(VERSION_HEADER);
  if (version !== undefined && !isSupportedVersion(version)) {
    return c.json(rpcError(null, INVALID_REQUEST, `This server does not support MCP protocol version ${version.slice(0, 32)}.`), 400);
  }
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    return c.json(rpcError(null, PARSE_ERROR, "The request body is not valid JSON."), 400);
  }
  if (Array.isArray(raw)) {
    return c.json(rpcError(null, INVALID_REQUEST, "Send one JSON-RPC message per request; batches are not supported."), 400);
  }
  const message = classify(raw);
  switch (message.kind) {
    case "invalid":
      return c.json(rpcError(message.id, INVALID_REQUEST, message.reason), 400);
    case "notification":
    case "response":
      return c.body(null, 202);
    case "request":
      return c.json(await handleRequest(c, access.token, message.message));
  }
});

mcpRoute.get("/", methodNotAllowed);
mcpRoute.delete("/", methodNotAllowed);
mcpRoute.all("/", methodNotAllowed);
