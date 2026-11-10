import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { audit, databases } from "../db/queries";
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

const querySchema = z.object({
  sql: z.string().max(1_000_000).refine((s) => s.trim().length > 0, "sql required"),
});

export const queryRoute = new Hono<{ Variables: AuthVariables }>();

queryRoute.use("*", requireAuth);

queryRoute.post("/:id/query", requireDbAccess("id", "read"), async (c) => {
  const id = c.req.param("id");
  const row = databases.byId(id);
  if (!row) throw new HTTPException(404, { message: "not found" });
  const { sql } = await parseJson(c, querySchema);

  const user = c.get("user");
  const readOnlySession = user.role === "viewer";
  if (readOnlySession) {
    const refusal = viewerStatementRefusal(sql);
    if (refusal) throw new HTTPException(403, { message: refusal });
  }

  if (!readOnlySession && isWriteFenced(id)) throw new HTTPException(503, { message: FENCED_WRITE_MESSAGE });
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
    return c.json(result);
  } catch (err) {
    if (!readOnlySession && isWriteFenced(id)) throw new HTTPException(503, { message: FENCED_WRITE_MESSAGE });
    throw queryFailure(err);
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

function queryFailure(err: unknown): unknown {
  if (err instanceof QueryTimeoutError) return new HTTPException(400, { message: err.message });
  const e = err as { errno?: number; sqlMessage?: string; code?: string; message?: string } | null;
  if (e?.errno === ER_CANT_EXECUTE_IN_READ_ONLY_TRANSACTION) return new HTTPException(403, { message: READ_ONLY_REFUSAL });
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
