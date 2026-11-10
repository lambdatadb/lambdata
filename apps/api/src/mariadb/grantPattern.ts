import { isSafeIdent } from "../util/ident";

export function escapeGrantPattern(schema: string): string {
  if (!isSafeIdent(schema)) throw new Error(`unsafe identifier: ${schema}`);
  return schema.replace(/[_%]/g, "\\$&");
}

export function grantTarget(schema: string): string {
  return "`" + escapeGrantPattern(schema) + "`.*";
}
