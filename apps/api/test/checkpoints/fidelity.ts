import { exec, makeDatabase, rootQuery, type Fixture } from "./helpers";
import { createCheckpoint, getWorkingCopyStatus, restoreCheckpoint } from "../../src/checkpoints";

type Row = Record<string, unknown>;

export function q(name: string): string {
  return "`" + name.replaceAll("`", "``") + "`";
}

export async function fingerprint(schema: string): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  const [defaults] = await rootQuery<Row>(
    "SELECT DEFAULT_CHARACTER_SET_NAME AS cs, DEFAULT_COLLATION_NAME AS co FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = ?",
    [schema],
  );
  out["schema:defaults"] = defaults;
  const tables = await rootQuery<Row>(
    `SELECT TABLE_NAME AS n, TABLE_TYPE AS t, ENGINE AS e, AUTO_INCREMENT AS ai, TABLE_COLLATION AS c, CREATE_OPTIONS AS o
       FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME`,
    [schema],
  );
  for (const t of tables) {
    const name = String(t.n);
    const ref = `${q(schema)}.${q(name)}`;
    const entry: Record<string, unknown> = { type: t.t, engine: t.e, autoIncrement: t.ai, collation: t.c, options: t.o };
    if (t.t === "VIEW") {
      const [v] = await rootQuery<Row>(`SHOW CREATE VIEW ${ref}`);
      entry.create = v?.["Create View"];
    } else {
      const [c] = await rootQuery<Row>(`SHOW CREATE TABLE ${ref}`);
      entry.create = c?.["Create Table"];
      entry.checksum = (await rootQuery<Row>(`CHECKSUM TABLE ${ref} EXTENDED`))[0]?.Checksum;
      entry.count = (await rootQuery<Row>(`SELECT COUNT(*) AS n FROM ${ref}`))[0]?.n;
      if (t.t === "SEQUENCE") {
        entry.sequence = await rootQuery<Row>(`SELECT * FROM ${ref}`);
      } else {
        const cols = await rootQuery<Row>(
          `SELECT COLUMN_NAME AS n, DATA_TYPE AS d FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION`,
          [schema, name],
        );
        const exprs = cols.map((col) => {
          const cn = q(String(col.n));
          const d = String(col.d);
          if (d === "float" || d === "double") return `CONCAT(CAST(${cn} AS DOUBLE), '|', ATAN2(${cn}, -1) < 0)`;
          if (d === "timestamp") return `CONCAT(UNIX_TIMESTAMP(${cn}), '|', ${cn})`;
          return `HEX(CAST(${cn} AS BINARY))`;
        });
        if (exprs.length > 0) {
          const rows = await rootQuery<Row>(`SELECT ${exprs.map((e, i) => `${e} AS c${i}`).join(", ")} FROM ${ref}`);
          entry.content = rows.map((r) => JSON.stringify(Object.values(r))).sort();
        }
        if (t.t === "SYSTEM VERSIONED") {
          entry.history = (await rootQuery<Row>(`SELECT COUNT(*) AS n FROM ${ref} FOR SYSTEM_TIME ALL`))[0]?.n;
        }
      }
    }
    out[`table:${name}`] = entry;
  }
  const routines = await rootQuery<Row>(
    `SELECT ROUTINE_NAME AS n, ROUTINE_TYPE AS t, SQL_MODE AS m FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA = ? ORDER BY ROUTINE_TYPE, ROUTINE_NAME`,
    [schema],
  );
  for (const r of routines) {
    const [c] = await rootQuery<Row>(`SHOW CREATE ${String(r.t)} ${q(schema)}.${q(String(r.n))}`);
    const key = Object.keys(c ?? {}).find((k) => k.startsWith("Create ")) ?? "";
    out[`${String(r.t).toLowerCase()}:${r.n}`] = { mode: r.m, create: c?.[key] };
  }
  const triggers = await rootQuery<Row>(
    `SELECT TRIGGER_NAME AS n, EVENT_OBJECT_TABLE AS t, ACTION_TIMING AS ti, EVENT_MANIPULATION AS ev, ACTION_ORDER AS o,
            SQL_MODE AS m, DEFINER AS d, ACTION_STATEMENT AS s
       FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = ? ORDER BY TRIGGER_NAME`,
    [schema],
  );
  for (const t of triggers) out[`trigger:${t.n}`] = t;
  const events = await rootQuery<Row>(
    `SELECT EVENT_NAME AS n, STATUS AS s, ON_COMPLETION AS oc, EVENT_DEFINITION AS d, INTERVAL_VALUE AS iv,
            INTERVAL_FIELD AS f, SQL_MODE AS m, TIME_ZONE AS tz, DEFINER AS de
       FROM information_schema.EVENTS WHERE EVENT_SCHEMA = ? ORDER BY EVENT_NAME`,
    [schema],
  );
  for (const e of events) out[`event:${e.n}`] = e;
  return out;
}

export function diffFingerprints(a: Record<string, unknown>, b: Record<string, unknown>): string[] {
  const out: string[] = [];
  for (const k of [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()) {
    const x = a[k];
    const y = b[k];
    if (x === undefined || y === undefined) {
      out.push(`${k}: ${x === undefined ? "added" : "missing"} after restore`);
      continue;
    }
    if (typeof x === "object" && x !== null && typeof y === "object" && y !== null) {
      for (const f of new Set([...Object.keys(x as object), ...Object.keys(y as object)])) {
        const xs = JSON.stringify((x as Row)[f]);
        const ys = JSON.stringify((y as Row)[f]);
        if (xs !== ys) out.push(`${k}.${f}: ${xs?.slice(0, 300)} -> ${ys?.slice(0, 300)}`);
      }
    } else if (JSON.stringify(x) !== JSON.stringify(y)) {
      out.push(`${k}: ${JSON.stringify(x)} -> ${JSON.stringify(y)}`);
    }
  }
  return out;
}

export interface RoundTrip {
  schema: string;
  databaseId: string;
  captureError: string | null;
  restoreError: string | null;
  warnings: string[];
  limitations: string[];
  diffs: string[];
  status: string | null;
}

export async function roundTrip(
  fx: Fixture,
  setupSql: string[],
  opts: { mutate?: string[]; afterCheckpoint?: (schema: string) => Promise<void> } = {},
): Promise<RoundTrip> {
  const { database } = await makeDatabase(fx.owner);
  const schema = database.name;
  if (setupSql.length > 0) await exec(schema, ...setupSql);
  const before = await fingerprint(schema);
  const r: RoundTrip = {
    schema,
    databaseId: database.id,
    captureError: null,
    restoreError: null,
    warnings: [],
    limitations: [],
    diffs: [],
    status: null,
  };
  let cp: string | null = null;
  try {
    const created = await createCheckpoint(database.id, { trigger: "manual", message: "fidelity" });
    cp = created.checkpointId;
    r.limitations = created.limitations ?? [];
  } catch (err) {
    r.captureError = (err as Error).message;
    return r;
  }
  await exec(schema, "CREATE TABLE zz_after_checkpoint (id INT PRIMARY KEY)", "INSERT INTO zz_after_checkpoint VALUES (1)", ...(opts.mutate ?? []));
  if (opts.afterCheckpoint) await opts.afterCheckpoint(schema);
  try {
    await restoreCheckpoint(database.id, cp!, { userId: fx.owner.id, hooks: { warn: (m) => r.warnings.push(m) } });
  } catch (err) {
    r.restoreError = (err as Error).message;
  }
  r.diffs = diffFingerprints(before, await fingerprint(schema));
  try {
    r.status = (await getWorkingCopyStatus(database.id, { refresh: true })).state;
  } catch (err) {
    r.status = `ERROR ${(err as Error).message}`;
  }
  return r;
}
