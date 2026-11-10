const SAFE_IDENT = /^[A-Za-z0-9_]+$/;
const SAFE_HOST_PATTERN = /^[A-Za-z0-9%._:/-]+$/;

export const MAX_IDENT_LENGTH = 64;
export const MAX_HOST_PATTERN_LENGTH = 255;

export function isSafeIdent(value: string): boolean {
  return typeof value === "string" && value.length <= MAX_IDENT_LENGTH && SAFE_IDENT.test(value);
}

export function quoteIdent(value: string): string {
  if (!isSafeIdent(value)) throw new Error(`unsafe identifier: ${value}`);
  return `\`${value}\``;
}

export function isSafeHostPattern(value: string): boolean {
  return (
    typeof value === "string" &&
    value.length <= MAX_HOST_PATTERN_LENGTH &&
    SAFE_HOST_PATTERN.test(value)
  );
}

export function escapeHostPattern(host: string): string {
  if (!isSafeHostPattern(host)) throw new Error(`unsafe host pattern: ${host}`);
  return host;
}
