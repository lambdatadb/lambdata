import type { Connection, RowDataPacket } from "mysql2/promise";
import { openAdminConnection } from "../mariadb/controller";
import { quoteMariaIdent } from "./identifiers";
import { doubleLiteral, hexLiteral, plainDecimal, realAsText, sqlString } from "./literals";
import { openSqliteReadOnly, yieldToEventLoop } from "./sqliteFile";
import { textDecoderFor, type ColumnBlueprint, type Family, type SqliteBlueprint } from "./sqlitePlan";

export interface LoadReporter {
  stage(label: string): void;
  progress(fraction: number | null): void;
  warn(message: string): void;
}

export interface SqliteLoadResult {
  tableCount: number;
  rowCount: number;
  warnings: string[];
  seconds: number;
}

const SESSION_SQL_MODE = "STRICT_ALL_TABLES,NO_AUTO_VALUE_ON_ZERO,NO_ENGINE_SUBSTITUTION,ERROR_FOR_DIVISION_BY_ZERO";
const MAX_STATEMENT_BYTES = 4 * 1024 * 1024;
const MIN_STATEMENT_BYTES = 64 * 1024;
const COMMIT_EVERY_BYTES = 32 * 1024 * 1024;
const PROGRESS_START = 0.05;
const PROGRESS_SPAN = 0.85;

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

type Renderer = (v: unknown) => string;

function renderer(family: Family, utf8: boolean, decoder: TextDecoder): Renderer {
  const asNumberText = (v: unknown): string | null => {
    if (typeof v === "bigint") return `'${v.toString()}'`;
    if (typeof v === "number") return sqlString(realAsText(v));
    return null;
  };
  switch (family) {
    case "integer":
    case "boolean":
      return (v) => (v === null || v === undefined ? "NULL" : typeof v === "bigint" ? v.toString() : BigInt(v as number).toString());
    case "double":
      return (v) => (v === null || v === undefined ? "NULL" : typeof v === "bigint" ? v.toString() : doubleLiteral(Number(v)));
    case "decimal":
      return (v) => (v === null || v === undefined ? "NULL" : typeof v === "bigint" ? v.toString() : plainDecimal(Number(v)));
    case "date":
    case "datetime":
      return (v) => {
        if (v === null || v === undefined) return "NULL";
        if (v instanceof Uint8Array) return `'${Buffer.from(v.buffer, v.byteOffset, v.byteLength).toString("latin1")}'`;
        throw new Error("unexpected non-text value in a date column");
      };
    case "text":
      return (v) => {
        if (v === null || v === undefined) return "NULL";
        if (v instanceof Uint8Array) {
          if (utf8) return hexLiteral(v);
          return hexLiteral(new Uint8Array(Buffer.from(decoder.decode(v), "utf8")));
        }
        const n = asNumberText(v);
        if (n === null) throw new Error("unexpected value in a text column");
        return n;
      };
    case "binary":
      return (v) => {
        if (v === null || v === undefined) return "NULL";
        if (v instanceof Uint8Array) return hexLiteral(v);
        const n = asNumberText(v);
        if (n === null) throw new Error("unexpected value in a binary column");
        return n;
      };
  }
}

async function scalar(conn: Connection, sql: string): Promise<number> {
  const [rows] = await conn.query<RowDataPacket[]>(sql);
  return Number(Object.values(rows[0] ?? {})[0] ?? 0);
}

export async function loadSqliteIntoSchema(p: {
  blueprint: SqliteBlueprint;
  path: string;
  schema: string;
  reporter: LoadReporter;
  dropTablesOnFailure: boolean;
}): Promise<SqliteLoadResult> {
  const started = performance.now();
  const { blueprint, reporter } = p;
  const warnings: string[] = [];
  const warn = (m: string) => {
    warnings.push(m);
    reporter.warn(m);
  };
  const conn = await openAdminConnection(p.schema);
  const created: string[] = [];
  const sqlite = openSqliteReadOnly(p.path);
  try {
    await conn.query("SET NAMES utf8mb4");
    await conn.query(`SET SESSION sql_mode = '${SESSION_SQL_MODE}'`);
    await conn.query("SET SESSION foreign_key_checks = 0, unique_checks = 0, max_statement_time = 0, time_zone = '+00:00'");
    const packet = await scalar(conn, "SELECT @@max_allowed_packet");
    const statementLimit = Math.max(MIN_STATEMENT_BYTES, Math.min(MAX_STATEMENT_BYTES, packet - 64 * 1024));
    const tables = blueprint.tables;
    reporter.stage(`Creating ${tables.length} table${tables.length === 1 ? "" : "s"}`);
    reporter.progress(0.01);
    for (const t of tables) {
      try {
        await conn.query(t.createSql);
      } catch (err) {
        throw new Error(`Creating table ${t.targetName} failed: ${errorMessage(err)}`);
      }
      created.push(t.targetName);
    }

    const utf8 = blueprint.encoding.toUpperCase() === "UTF-8";
    const decoder = textDecoderFor(blueprint.encoding);
    const totalRows = tables.reduce((s, t) => s + t.rowCount, 0);
    let doneRows = 0;
    let lastReport = 0;
    const report = (force = false) => {
      const now = performance.now();
      if (!force && now - lastReport < 250) return;
      lastReport = now;
      reporter.stage(`Loading rows: ${doneRows.toLocaleString("en-US")} of ${totalRows.toLocaleString("en-US")}`);
      reporter.progress(PROGRESS_START + PROGRESS_SPAN * (totalRows === 0 ? 1 : doneRows / totalRows));
    };
    report(true);
    for (const t of tables) {
      if (t.rowCount === 0) continue;
      const cols: ColumnBlueprint[] = t.columns;
      const renderers = cols.map((c) => renderer(c.family, utf8, decoder));
      const keys = cols.map((_, i) => `c${i}`);
      const prefix = `INSERT INTO ${quoteMariaIdent(t.targetName)} (${cols.map((c) => quoteMariaIdent(c.targetName)).join(", ")}) VALUES `;
      let parts: string[] = [];
      let partsBytes = prefix.length;
      let partsRows = 0;
      let inFlight: Promise<unknown> | null = null;
      let sinceCommit = 0;
      let tableRows = 0;
      const send = async () => {
        if (parts.length === 0) return;
        const sql = prefix + parts.join(",");
        const rows = partsRows;
        parts = [];
        partsBytes = prefix.length;
        partsRows = 0;
        if (inFlight) await inFlight;
        sinceCommit += sql.length;
        const q = conn.query(sql).then(() => {
          doneRows += rows;
          report();
        });
        q.catch(() => {});
        inFlight = q;
        if (sinceCommit >= COMMIT_EVERY_BYTES) {
          await inFlight;
          inFlight = null;
          await conn.query("COMMIT");
          await conn.query("START TRANSACTION");
          sinceCommit = 0;
        }
      };
      try {
        await conn.query("START TRANSACTION");
        const stmt = sqlite.query(t.selectSql);
        try {
          let n = 0;
          for (const row of stmt.iterate() as IterableIterator<Record<string, unknown>>) {
            let tuple = "(";
            for (let i = 0; i < keys.length; i++) {
              if (i > 0) tuple += ",";
              tuple += renderers[i]!(row[keys[i]!]);
            }
            tuple += ")";
            if (parts.length > 0 && partsBytes + tuple.length + 1 > statementLimit) await send();
            parts.push(tuple);
            partsBytes += tuple.length + 1;
            partsRows++;
            tableRows++;
            if (++n % 5000 === 0 && !inFlight) await yieldToEventLoop();
          }
        } finally {
          stmt.finalize();
        }
        await send();
        if (inFlight) await inFlight;
        inFlight = null;
        await conn.query("COMMIT");
      } catch (err) {
        if (inFlight) await (inFlight as Promise<unknown>).catch(() => {});
        await conn.query("ROLLBACK").catch(() => {});
        throw new Error(`Loading rows into ${t.targetName} failed: ${errorMessage(err)}`);
      }
      if (tableRows !== t.rowCount) {
        throw new Error(`Read ${tableRows} rows from ${t.sourceName} but the plan counted ${t.rowCount}; the file changed or is damaged`);
      }
    }
    report(true);

    await conn.query("SET SESSION unique_checks = 1");
    const indexed = tables.filter((t) => t.indexClauses.length > 0);
    if (indexed.length > 0) {
      reporter.stage("Building indexes");
      reporter.progress(0.92);
      for (const t of indexed) {
        const table = quoteMariaIdent(t.targetName);
        try {
          await conn.query(`ALTER TABLE ${table} ${t.indexClauses.map((c) => c.clause).join(", ")}`);
        } catch {
          for (const c of t.indexClauses) {
            try {
              await conn.query(`ALTER TABLE ${table} ${c.clause}`);
            } catch (err) {
              warn(`Index ${c.name} on ${t.targetName} was not created: ${errorMessage(err)}`);
            }
          }
        }
      }
    }
    await conn.query("SET SESSION foreign_key_checks = 1");
    const withFks = tables.filter((t) => t.foreignKeyClauses.length > 0);
    if (withFks.length > 0) {
      reporter.stage("Adding foreign keys");
      reporter.progress(0.96);
      for (const t of withFks) {
        for (const fk of t.foreignKeyClauses) {
          try {
            await conn.query(`ALTER TABLE ${quoteMariaIdent(t.targetName)} ${fk.clause}`);
          } catch (err) {
            warn(`Foreign key ${t.targetName} ${fk.label} was not created: ${errorMessage(err)}`);
          }
        }
      }
    }
    reporter.progress(0.99);
    return {
      tableCount: tables.length,
      rowCount: totalRows,
      warnings,
      seconds: (performance.now() - started) / 1000,
    };
  } catch (err) {
    if (p.dropTablesOnFailure && created.length > 0) {
      await conn.query("SET SESSION foreign_key_checks = 0").catch(() => {});
      for (const name of created) {
        await conn.query(`DROP TABLE IF EXISTS ${quoteMariaIdent(name)}`).catch(() => {});
      }
    }
    throw err;
  } finally {
    sqlite.close();
    await conn.end().catch(() => conn.destroy());
  }
}
