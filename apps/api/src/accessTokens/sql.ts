import { codeTokens, viewerStatementRefusal } from "../routes/query";

const DESTRUCTIVE = new Set(["DROP", "TRUNCATE"]);

function leadingKeywords(sql: string): string[] {
  return [true, false].map((backslashEscapes) => codeTokens(sql, backslashEscapes).find((t) => t !== "(") ?? "");
}

export function destructiveKeyword(sql: string): string | null {
  for (const word of leadingKeywords(sql)) {
    if (DESTRUCTIVE.has(word)) return word;
  }
  return null;
}

export function changesData(sql: string): boolean {
  return viewerStatementRefusal(sql) !== null;
}
