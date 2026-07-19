import { randAlphaNum } from "./id";

export function deriveSchemaName(displayName: string): string {
  const slug = displayName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 48);
  return slug || "db";
}

export function generateMysqlUser(schema: string): string {
  const tail = randAlphaNum(4);
  const head = `kdb_${schema}_`;
  const room = 32 - head.length - tail.length;
  const slim = schema.slice(0, Math.max(0, room));
  return `kdb_${slim}_${tail}`;
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
