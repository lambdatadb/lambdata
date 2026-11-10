import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";

export function formatIssues(error: z.ZodError): string {
  const parts = error.issues.slice(0, 5).map((issue) => {
    const path = issue.path.map(String).join(".");
    return path ? `${path}: ${issue.message}` : issue.message;
  });
  if (error.issues.length > 5) parts.push(`and ${error.issues.length - 5} more`);
  return parts.join("; ");
}

export function parseValue<S extends z.ZodType>(schema: S, value: unknown, label = "request"): z.output<S> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new HTTPException(400, { message: `invalid ${label}: ${formatIssues(parsed.error)}` });
  }
  return parsed.data;
}

export async function readJson(c: Context): Promise<unknown> {
  const text = await c.req.text();
  if (text.trim() === "") return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new HTTPException(400, { message: "request body must be valid JSON" });
  }
}

export async function parseJson<S extends z.ZodType>(c: Context, schema: S): Promise<z.output<S>> {
  return parseValue(schema, await readJson(c), "request body");
}

export function parseQuery<S extends z.ZodType>(c: Context, schema: S): z.output<S> {
  return parseValue(schema, c.req.query(), "query");
}

export const zBoolish = z.union([
  z.boolean(),
  z.enum(["1", "0", "true", "false"]).transform((v) => v === "1" || v === "true"),
]);
