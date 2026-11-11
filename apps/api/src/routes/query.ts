import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import type { QueryResult, QueryUndoInfo } from "@lambdata/shared";
import { audit, databases, undoPoints } from "../db/queries";
import { cleanActivityText, currentAccessToken } from "../accessTokens/index";
import { activeUndoInfo, ensureUndoPoint } from "../accessTokens/undo";
import { requireAuth, requireDbAccess, type AuthVariables } from "../auth/middleware";
import { QueryTimeoutError, USER_QUERY_TIMEOUT_MS, executeUserQuery } from "../mariadb/manager";
import { executeViewerQuery } from "../mariadb/readonly";
import { isWriteFenced } from "../mariadb/writeFence";
import { decryptSecret } from "../util/crypto";
import { parseJson } from "../util/validate";
import { FENCED_WRITE_MESSAGE } from "./dataApi";

export const queryLimits = { timeoutMs: USER_QUERY_TIMEOUT_MS };

const ER_CANT_EXECUTE_IN_READ_ONLY_TRANSACTION = 1792;
const UNREACHABLE_CODES = new Set(["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "EPIPE", "ENOENT", "PROTOCOL_CONNECTION_LOST"]);
const READ_STATEMENTS = new Set(["SELECT", "SHOW", "DESCRIBE", "DESC", "EXPLAIN", "WITH", "VALUES"]);
const LOCKING_READS = [["FOR", "UPDATE"], ["FOR", "SHARE"], ["LOCK", "IN", "SHARE", "MODE"], ["GET_LOCK", "("]];
const READ_ONLY_REFUSAL = "viewers have read-only access: this statement would change data";
export const TOKEN_READ_ONLY_REFUSAL = "This access token is read only, so it can only run queries that read data.";
export const TOKEN_LOCKING_READ_REFUSAL =
  "This access token is read only, so it cannot run locking reads (FOR UPDATE, LOCK IN SHARE MODE, GET_LOCK).";
const SQL_DETAIL_MAX = 300;

export const TOKEN_DEFAULT_MAX_ROWS = 500;
export const TOKEN_MAX_ROWS = 5000;

const querySchema = z.object({
  sql: z.string().max(1_000_000).refine((s) => s.trim().length > 0, "sql required"),
  maxRows: z.number().int().min(1).max(TOKEN_MAX_ROWS, `maxRows can be at most ${TOKEN_MAX_ROWS}`).optional(),
});

function forToken(result: QueryResult, maxRows: number, versioned: boolean, undo: QueryUndoInfo | null): QueryResult {
  const truncated = result.rows.length > maxRows;
  return {
    ...result,
    rows: truncated ? result.rows.slice(0, maxRows) : result.rows,
    truncated,
    maxRows,
    versioned,
    undo: versioned ? undo : null,
  };
}

export const queryRoute = new Hono<{ Variables: AuthVariables }>();

queryRoute.use("*", requireAuth);

queryRoute.post("/:id/query", requireDbAccess("id", "read"), async (c) => {
  const id = c.req.param("id");
  const row = databases.byId(id);
  if (!row) throw new HTTPException(404, { message: "not found" });
  const { sql, maxRows } = await parseJson(c, querySchema);

  const user = c.get("user");
  const tokenRequest = currentAccessToken(c);
  if (tokenRequest) c.set("accessTokenDetail", cleanActivityText(sql, SQL_DETAIL_MAX) ?? undefined);
  const readOnlySession = user.role === "viewer" || tokenRequest?.token.preset === "read_only";
  if (readOnlySession) {
    const refusal = viewerStatementRefusal(sql);
    if (refusal) throw new HTTPException(403, { message: tokenRequest ? tokenRefusal(refusal) : refusal });
  }

  if (!readOnlySession && isWriteFenced(id)) throw new HTTPException(503, { message: FENCED_WRITE_MESSAGE });
  const changing = !readOnlySession && viewerStatementRefusal(sql) !== null;
  let undo: QueryUndoInfo | null = null;
  if (tokenRequest && changing && row.versioned) {
    undo = await ensureUndoPoint(tokenRequest.token, id);
    if (isWriteFenced(id)) throw new HTTPException(503, { message: FENCED_WRITE_MESSAGE });
  }
  try {
    const result = readOnlySession
      ? await executeViewerQuery({ databaseId: id, sql, timeoutMs: queryLimits.timeoutMs })
      : await executeUserQuery({
          schema: row.name,
          user: row.mysqlUser,
          password: await decryptSecret(row.mysqlPasswordEnc),
          sql,
          timeoutMs: queryLimits.timeoutMs,
        });
    audit.log(user.id, "query.exec", id, { rowCount: result.rowCount });
    if (!tokenRequest) return c.json(result);
    if (undo) undoPoints.touch(tokenRequest.token.id, id);
    const current = undo ?? (row.versioned ? activeUndoInfo(tokenRequest.token, id) : null);
    return c.json(forToken(result, maxRows ?? TOKEN_DEFAULT_MAX_ROWS, row.versioned, current));
  } catch (err) {
    if (tokenRequest && undo) undoPoints.touch(tokenRequest.token.id, id);
    if (!readOnlySession && isWriteFenced(id)) throw new HTTPException(503, { message: FENCED_WRITE_MESSAGE });
    throw queryFailure(err, tokenRequest !== null);
  }
});

export function viewerStatementRefusal(sql: string): string | null {
  for (const backslashEscapes of [true, false]) {
    const tokens = codeTokens(sql, backslashEscapes);
    const first = tokens.find((token) => token !== "(");
    if (!first || !READ_STATEMENTS.has(first)) return "viewers may only run read-only queries";
    if (LOCKING_READS.some((pattern) => containsSequence(tokens, pattern))) {
      return "viewers cannot run locking reads (FOR UPDATE, LOCK IN SHARE MODE, GET_LOCK)";
    }
  }
  return null;
}

function tokenRefusal(viewerMessage: string): string {
  return viewerMessage.includes("locking reads") ? TOKEN_LOCKING_READ_REFUSAL : TOKEN_READ_ONLY_REFUSAL;
}

function queryFailure(err: unknown, forToken = false): unknown {
  if (err instanceof QueryTimeoutError) return new HTTPException(400, { message: err.message });
  const e = err as { errno?: number; sqlMessage?: string; code?: string; message?: string } | null;
  if (e?.errno === ER_CANT_EXECUTE_IN_READ_ONLY_TRANSACTION) {
    return new HTTPException(403, { message: forToken ? TOKEN_READ_ONLY_REFUSAL : READ_ONLY_REFUSAL });
  }
  if (forToken && err instanceof HTTPException && err.message.startsWith("viewers ")) {
    const message = err.message
      .replace(/^viewers have read-only access: /, "This access token is read only: ")
      .replace(/^viewers cannot /, "This access token is read only, so it cannot ");
    return new HTTPException(err.status, { message });
  }
  if (typeof e?.sqlMessage === "string") return new HTTPException(400, { message: e.message ?? e.sqlMessage });
  if (e?.code && UNREACHABLE_CODES.has(e.code)) {
    return new HTTPException(503, { message: "MariaDB is not reachable right now" });
  }
  return err;
}

function containsSequence(tokens: string[], pattern: string[]): boolean {
  for (let i = 0; i + pattern.length <= tokens.length; i++) {
    if (pattern.every((word, j) => tokens[i + j] === word)) return true;
  }
  return false;
}

function isWordChar(ch: string): boolean {
  return /[A-Za-z0-9_$@]/.test(ch) || ch.charCodeAt(0) > 0x7f;
}

function skipQuoted(sql: string, start: number, quote: string, backslashEscapes: boolean): number {
  let i = start + 1;
  while (i < sql.length) {
    const ch = sql[i]!;
    if (backslashEscapes && quote !== "`" && ch === "\\") {
      i += 2;
      continue;
    }
    if (ch === quote) {
      if (sql[i + 1] === quote) {
        i += 2;
        continue;
      }
      return i + 1;
    }
    i++;
  }
  return sql.length;
}

function skipLine(sql: string, start: number): number {
  const end = sql.indexOf("\n", start);
  return end < 0 ? sql.length : end + 1;
}

export function codeTokens(sql: string, backslashEscapes = true): string[] {
  const tokens: string[] = [];
  let executable = 0;
  let i = 0;
  while (i < sql.length) {
    const ch = sql[i]!;
    const next = sql[i + 1] ?? "";
    if (/\s/.test(ch)) {
      i++;
    } else if (ch === "'" || ch === '"' || ch === "`") {
      i = skipQuoted(sql, i, ch, backslashEscapes);
      tokens.push(ch === "`" ? "`identifier`" : "'literal'");
    } else if (ch === "#") {
      i = skipLine(sql, i);
    } else if (ch === "-" && next === "-" && (i + 2 >= sql.length || sql.charCodeAt(i + 2) <= 0x20)) {
      i = skipLine(sql, i);
    } else if (ch === "*" && next === "/" && executable > 0) {
      executable--;
      i += 2;
    } else if (ch === "/" && next === "*" && executable === 0) {
      const marker = /^\/\*(?:!|M!)\d*/.exec(sql.slice(i, i + 12));
      if (marker) {
        executable++;
        i += marker[0].length;
      } else {
        const end = sql.indexOf("*/", i + 2);
        i = end < 0 ? sql.length : end + 2;
      }
    } else if (isWordChar(ch)) {
      let j = i + 1;
      while (j < sql.length && isWordChar(sql[j]!)) j++;
      tokens.push(sql.slice(i, j).toUpperCase());
      i = j;
    } else {
      tokens.push(ch);
      i++;
    }
  }
  return tokens;
}
