import { Database } from "bun:sqlite";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import mysql from "mysql2/promise";
import type { ImportUpload } from "@lambdata/shared";
import { testTmpRoot } from "../harness/instance";
import { buildSqliteBlueprint, type Family, type SqliteBlueprint, type TableBlueprint } from "../../src/imports/sqlitePlan";
import { loadSqliteIntoSchema, type LoadReporter } from "../../src/imports/sqliteLoad";
import { realAsText } from "../../src/imports/literals";
import { env } from "../../src/env";
import { getRootPassword, localConnectHost } from "../../src/mariadb/controller";

export const NOCASE = "utf8mb4_uca1400_nopad_as_ci";

let counter = 0;

export function fixtureDir(): string {
  const dir = join(testTmpRoot(), `imp-${process.pid}-${++counter}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function buildSqlite(build: (db: Database) => void, name = "fixture.db"): string {
  const path = join(fixtureDir(), name);
  rmSync(path, { force: true });
  const db = new Database(path, { create: true, safeIntegers: true });
  try {
    build(db);
  } finally {
    db.close();
  }
  return path;
}

export function fakeUpload(path: string): ImportUpload {
  return {
    id: "upl_00000000000000000000000000000000",
    fileName: path.split("/").pop() ?? "fixture.db",
    sizeBytes: Bun.file(path).size,
    sha256: "0".repeat(64),
    format: "sqlite",
    createdAt: Date.now(),
    expiresAt: Date.now() + 60_000,
  };
}

export function planFor(path: string): Promise<SqliteBlueprint> {
  return buildSqliteBlueprint(path, fakeUpload(path), { nocaseCollation: NOCASE });
}

export const silentReporter: LoadReporter & { warnings: string[] } = {
  warnings: [],
  stage() {},
  progress() {},
  warn(m: string) {
    silentReporter.warnings.push(m);
  },
};

export async function importInto(path: string, schema: string): Promise<{ blueprint: SqliteBlueprint; warnings: string[] }> {
  const blueprint = await planFor(path);
  const warnings: string[] = [];
  await loadSqliteIntoSchema({
    blueprint,
    path,
    schema,
    reporter: { stage() {}, progress() {}, warn: (m) => warnings.push(m) },
    dropTablesOnFailure: false,
  });
  return { blueprint, warnings };
}

export async function rootConnection(schema?: string): Promise<mysql.Connection> {
  return mysql.createConnection({
    host: localConnectHost(),
    port: env.mariadbPort,
    user: env.rootUser,
    password: await getRootPassword(),
    database: schema,
    supportBigNumbers: true,
    bigNumberStrings: true,
    dateStrings: true,
  });
}

export async function mariaQuery<T = Record<string, unknown>>(schema: string, sql: string, params: unknown[] = []): Promise<T[]> {
  const conn = await rootConnection(schema);
  try {
    const [rows] = await conn.query(sql, params);
    return rows as T[];
  } finally {
    await conn.end();
  }
}

export function table(bp: SqliteBlueprint, sourceName: string): TableBlueprint {
  const t = bp.tables.find((x) => x.sourceName === sourceName);
  if (!t) throw new Error(`no table ${sourceName} in blueprint`);
  return t;
}

export function tablePlan(bp: SqliteBlueprint, sourceName: string) {
  const t = bp.plan.tables.find((x) => x.sourceName === sourceName);
  if (!t) throw new Error(`no table ${sourceName} in plan`);
  return t;
}

export function columnPlan(bp: SqliteBlueprint, tableName: string, column: string) {
  const c = tablePlan(bp, tableName).columns.find((x) => x.sourceName === column);
  if (!c) throw new Error(`no column ${column}`);
  return c;
}

function hex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("hex");
}

function canonicalSqlite(family: Family, v: unknown): string {
  if (v === null || v === undefined) return "N";
  switch (family) {
    case "integer":
    case "boolean":
      return `I:${(v as bigint).toString()}`;
    case "double":
    case "decimal": {
      const x = typeof v === "bigint" ? Number(v) : (v as number);
      return `D:${Object.is(x, -0) ? "-0" : String(x)}`;
    }
    case "date":
    case "datetime":
      return `T:${Buffer.from(v as Uint8Array).toString("latin1")}`;
    case "text":
    case "binary":
      if (v instanceof Uint8Array) return `X:${hex(v)}`;
      if (typeof v === "bigint") return `X:${Buffer.from(v.toString()).toString("hex")}`;
      return `X:${Buffer.from(realAsText(v as number)).toString("hex")}`;
  }
}

function canonicalMaria(family: Family, v: unknown): string {
  if (v === null || v === undefined) return "N";
  switch (family) {
    case "integer":
    case "boolean":
      return `I:${String(v)}`;
    case "double": {
      const x = v as number;
      return `D:${Object.is(x, -0) ? "-0" : String(x)}`;
    }
    case "decimal":
      return `D:${String(Number(v))}`;
    case "date":
    case "datetime":
      return `T:${String(v)}`;
    case "text":
    case "binary":
      return `X:${String(v).toLowerCase()}`;
  }
}

function quoteSqlite(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

function quoteMaria(name: string): string {
  return "`" + name.replaceAll("`", "``") + "`";
}

export async function canonicalRows(
  sqlitePath: string,
  bp: SqliteBlueprint,
  sourceName: string,
  schema: string,
): Promise<{ sqlite: string[]; maria: string[] }> {
  const t = table(bp, sourceName);
  const db = new Database(sqlitePath, { readonly: true, safeIntegers: true });
  let sqliteRows: string[];
  try {
    const exprs = t.columns.map((c, i) => {
      const q = quoteSqlite(c.sourceName);
      return `CASE WHEN typeof(${q}) = 'text' THEN CAST(${q} AS BLOB) ELSE ${q} END AS c${i}`;
    });
    const rows = db.query(`SELECT ${exprs.join(", ")} FROM ${quoteSqlite(t.sourceName)}`).all() as Record<string, unknown>[];
    sqliteRows = rows.map((r) => t.columns.map((c, i) => canonicalSqlite(c.family, r[`c${i}`])).join(" | "));
  } finally {
    db.close();
  }
  const conn = await rootConnection(schema);
  let mariaRows: string[];
  try {
    const exprs = t.columns.map((c, i) => {
      const q = quoteMaria(c.targetName);
      if (c.family === "text" || c.family === "binary") return `HEX(${q}) AS c${i}`;
      if (c.family === "double") return `${q} AS c${i}`;
      return `CAST(${q} AS CHAR) AS c${i}`;
    });
    const [rows] = await conn.execute(`SELECT ${exprs.join(", ")} FROM ${quoteMaria(t.targetName)}`);
    mariaRows = (rows as Record<string, unknown>[]).map((r) =>
      t.columns
        .map((c, i) => {
          const v = r[`c${i}`];
          if (c.family === "text" || c.family === "binary") return v === null ? "N" : `X:${String(v).toLowerCase()}`;
          return canonicalMaria(c.family, v);
        })
        .join(" | "),
    );
  } finally {
    await conn.end();
  }
  return { sqlite: sqliteRows.sort(), maria: mariaRows.sort() };
}
