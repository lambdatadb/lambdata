import { randAlphaNum } from "./id";

export const MAX_SCHEMA_SLUG_LENGTH = 48;
export const MAX_MYSQL_USER_LENGTH = 32;
const USER_PREFIX = "ld_";
const USER_TAIL_LENGTH = 8;
const RESERVED_SCHEMAS = new Set(["mysql", "information_schema", "performance_schema", "sys"]);

export function deriveSchemaName(displayName: string): string {
  const slug = displayName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, MAX_SCHEMA_SLUG_LENGTH)
    .replace(/_+$/, "");
  const base = slug || "db";
  return RESERVED_SCHEMAS.has(base) ? `${base}_db` : base;
}

export function generateMysqlUser(schema: string, isTaken?: (user: string) => boolean): string {
  const room = MAX_MYSQL_USER_LENGTH - USER_PREFIX.length - 1 - USER_TAIL_LENGTH;
  const middle =
    schema
      .toLowerCase()
      .replace(/[^a-z0-9_]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, room)
      .replace(/_+$/, "") || "db";
  for (let attempt = 0; attempt < 20; attempt++) {
    const candidate = `${USER_PREFIX}${middle}_${randAlphaNum(USER_TAIL_LENGTH)}`;
    if (!isTaken?.(candidate)) return candidate;
  }
  throw new Error("could not allocate a unique MariaDB user name");
}

export function generatePassword(): string {
  const bytes = new Uint8Array(18);
  crypto.getRandomValues(bytes);
  return base64Url(bytes);
}

function base64Url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}
