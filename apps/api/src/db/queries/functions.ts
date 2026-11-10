import type { EdgeFunctionInvocation, EdgeFunctionSecret } from "@lambdata/shared";
import { db } from "../client";

type FunctionRow = {
  name: string;
  verify_jwt: number;
  created_by_user_id: string | null;
  created_at: number;
  updated_at: number;
};

type FunctionSecretRow = {
  name: string;
  value_enc: string;
  created_at: number;
  updated_at: number;
};

type FunctionInvocationRow = {
  id: string;
  function_name: string;
  method: string;
  path: string;
  status_code: number | null;
  duration_ms: number;
  request_bytes: number;
  response_bytes: number;
  error: string | null;
  logs: string | null;
  invoked_by_app_user_id: string | null;
  created_at: number;
};

export interface FunctionSettings {
  name: string;
  verifyJwt: boolean;
  createdByUserId: string | null;
  createdAt: number;
  updatedAt: number;
}

function rowToFunctionSettings(r: FunctionRow): FunctionSettings {
  return {
    name: r.name,
    verifyJwt: r.verify_jwt === 1,
    createdByUserId: r.created_by_user_id,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function rowToFunctionInvocation(r: FunctionInvocationRow): EdgeFunctionInvocation {
  return {
    id: r.id,
    functionName: r.function_name,
    method: r.method,
    path: r.path,
    statusCode: r.status_code,
    durationMs: r.duration_ms,
    requestBytes: r.request_bytes,
    responseBytes: r.response_bytes,
    error: r.error,
    logs: r.logs,
    invokedByAppUserId: r.invoked_by_app_user_id,
    createdAt: r.created_at,
  };
}

function rowToFunctionSecret(r: FunctionSecretRow): EdgeFunctionSecret {
  return {
    name: r.name,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export const edgeFunctions = {
  listSettings(): FunctionSettings[] {
    const rows = db.query("SELECT * FROM functions ORDER BY name ASC").all() as FunctionRow[];
    return rows.map(rowToFunctionSettings);
  },
  byName(name: string): FunctionSettings | null {
    const row = db.query("SELECT * FROM functions WHERE name = ?").get(name) as FunctionRow | null;
    return row ? rowToFunctionSettings(row) : null;
  },
  upsert(input: { name: string; verifyJwt: boolean; createdByUserId: string | null }): void {
    const now = Date.now();
    db.query(
      `INSERT INTO functions(name, verify_jwt, created_by_user_id, created_at, updated_at)
       VALUES(?, ?, ?, ?, ?)
       ON CONFLICT(name) DO UPDATE SET
        verify_jwt = excluded.verify_jwt,
        updated_at = excluded.updated_at`,
    ).run(input.name, input.verifyJwt ? 1 : 0, input.createdByUserId, now, now);
  },
  delete(name: string): void {
    db.query("DELETE FROM functions WHERE name = ?").run(name);
  },
};

export const functionSecrets = {
  list(): EdgeFunctionSecret[] {
    const rows = db.query("SELECT * FROM function_secrets ORDER BY name ASC").all() as FunctionSecretRow[];
    return rows.map(rowToFunctionSecret);
  },
  values(): Record<string, string> {
    const rows = db.query("SELECT * FROM function_secrets ORDER BY name ASC").all() as FunctionSecretRow[];
    return Object.fromEntries(rows.map((r) => [r.name, r.value_enc]));
  },
  upsert(secret: { name: string; valueEnc: string }): void {
    const now = Date.now();
    db.query(
      `INSERT INTO function_secrets(name, value_enc, created_at, updated_at)
       VALUES(?, ?, ?, ?)
       ON CONFLICT(name) DO UPDATE SET
        value_enc = excluded.value_enc,
        updated_at = excluded.updated_at`,
    ).run(secret.name, secret.valueEnc, now, now);
  },
  delete(name: string): void {
    db.query("DELETE FROM function_secrets WHERE name = ?").run(name);
  },
};

export const functionInvocations = {
  list(functionName: string, limit = 50): EdgeFunctionInvocation[] {
    const rows = db
      .query(
        `SELECT * FROM function_invocations
         WHERE function_name = ?
         ORDER BY created_at DESC
         LIMIT ?`,
      )
      .all(functionName, limit) as FunctionInvocationRow[];
    return rows.map(rowToFunctionInvocation);
  },
  stats(functionName: string): {
    invocationCount: number;
    lastInvokedAt: number | null;
    lastStatusCode: number | null;
    lastDurationMs: number | null;
  } {
    const countRow = db
      .query("SELECT COUNT(*) AS n FROM function_invocations WHERE function_name = ?")
      .get(functionName) as { n: number } | null;
    const last = db
      .query(
        `SELECT status_code, duration_ms, created_at
         FROM function_invocations
         WHERE function_name = ?
         ORDER BY created_at DESC
         LIMIT 1`,
      )
      .get(functionName) as
      | { status_code: number | null; duration_ms: number; created_at: number }
      | null;
    return {
      invocationCount: Number(countRow?.n ?? 0),
      lastInvokedAt: last?.created_at ?? null,
      lastStatusCode: last?.status_code ?? null,
      lastDurationMs: last?.duration_ms ?? null,
    };
  },
  countSince(sinceMs: number): number {
    const r = db
      .query("SELECT COUNT(*) AS n FROM function_invocations WHERE created_at >= ?")
      .get(sinceMs) as { n: number } | null;
    return Number(r?.n ?? 0);
  },
  insert(input: {
    id: string;
    functionName: string;
    method: string;
    path: string;
    statusCode: number | null;
    durationMs: number;
    requestBytes: number;
    responseBytes: number;
    error: string | null;
    logs: string | null;
    invokedByAppUserId: string | null;
  }): void {
    db.query(
      `INSERT INTO function_invocations(
        id, function_name, method, path, status_code, duration_ms,
        request_bytes, response_bytes, error, logs, invoked_by_app_user_id, created_at
       ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      input.id,
      input.functionName,
      input.method,
      input.path,
      input.statusCode,
      input.durationMs,
      input.requestBytes,
      input.responseBytes,
      input.error,
      input.logs,
      input.invokedByAppUserId,
      Date.now(),
    );
  },
  deleteForFunction(functionName: string): void {
    db.query("DELETE FROM function_invocations WHERE function_name = ?").run(functionName);
  },
};
