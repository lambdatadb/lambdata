import type { Connection, RowDataPacket } from "mysql2/promise";

const SERVER_ESCAPES: Record<string, string> = {
  "\\\\": "\\",
  "\\'": "'",
  "''": "'",
  '\\"': '"',
  "\\0": "\0",
  "\\n": "\n",
  "\\r": "\r",
  "\\t": "\t",
  "\\b": "\b",
  "\\Z": "\x1a",
};

export interface MemberList {
  prefix: string;
  tokens: string[];
  suffix: string;
}

function quoteName(name: string): string {
  return "`" + name.replaceAll("`", "``") + "`";
}

export function memberTokens(columnType: string): MemberList | null {
  const head = /^(?:enum|set)\(/i.exec(columnType);
  if (!head) return null;
  const tokens: string[] = [];
  let i = head[0].length;
  for (;;) {
    if (columnType[i] !== "'") return null;
    let j = i + 1;
    for (;;) {
      if (j >= columnType.length) return null;
      const ch = columnType[j];
      if (ch === "\\") {
        j += 2;
        continue;
      }
      if (ch === "'") {
        if (columnType[j + 1] === "'") {
          j += 2;
          continue;
        }
        break;
      }
      j++;
    }
    tokens.push(columnType.slice(i, j + 1));
    i = j + 1;
    if (columnType[i] === ",") {
      i++;
      continue;
    }
    if (columnType[i] === ")") return { prefix: head[0], tokens, suffix: columnType.slice(i) };
    return null;
  }
}

export function restoreToken(token: string, value: string): string | null {
  if (token.length < 2 || !token.startsWith("'") || !token.endsWith("'")) return null;
  const raw = token.slice(1, -1);
  let out = "";
  let i = 0;
  for (const ch of value) {
    if (ch.codePointAt(0)! > 0xffff) {
      if (raw[i] !== "?") return null;
      out += ch;
      i++;
      continue;
    }
    if (i >= raw.length) return null;
    const piece = raw[i] === "\\" || (raw[i] === "'" && raw[i + 1] === "'") ? raw.slice(i, i + 2) : raw[i]!;
    const meant = piece.length === 2 ? SERVER_ESCAPES[piece] : piece;
    if (meant !== ch) return null;
    out += piece;
    i += piece.length;
  }
  return i === raw.length ? `'${out}'` : null;
}

export interface MemberColumn {
  name: string;
  columnType: string;
  columnDefault: string | null;
}

export interface TrueMembers {
  members: string[];
  columnDefault: string | null;
}

function decodeHex(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return Buffer.from(String(value), "hex").toString("utf8");
}

export async function readTrueMembers(conn: Connection, schema: string, table: string, column: MemberColumn): Promise<TrueMembers | null> {
  const list = memberTokens(column.columnType);
  if (!list) return null;
  const isSet = list.prefix.toLowerCase().startsWith("set");
  if (isSet && list.tokens.length > 64) return null;
  const tmp = `${quoteName(schema)}.\`ld_members\``;
  const col = quoteName(column.name);
  await conn.query(`DROP TEMPORARY TABLE IF EXISTS ${tmp}`);
  await conn.query(`CREATE TEMPORARY TABLE ${tmp} AS SELECT ${col} FROM ${quoteName(schema)}.${quoteName(table)} LIMIT 0`);
  try {
    const values = list.tokens.map((_, i) => (isSet ? (1n << BigInt(i)).toString() : String(i + 1)));
    await conn.query(`INSERT INTO ${tmp} (${col}) VALUES ${values.map((v) => `(${v})`).join(",")}`);
    const [found] = await conn.query<RowDataPacket[]>(`SELECT CAST(${col}+0 AS CHAR) AS i, HEX(CONVERT(${col} USING utf8mb4)) AS h FROM ${tmp}`);
    const byIndex = new Map(found.map((r) => [String(r.i), decodeHex(r.h)]));
    const members: string[] = [];
    for (const v of values) {
      const m = byIndex.get(v);
      if (m === undefined || m === null) return null;
      members.push(m);
    }
    let columnDefault: string | null = null;
    if (column.columnDefault?.startsWith("'")) {
      await conn.query(`DELETE FROM ${tmp}`);
      await conn.query(`INSERT INTO ${tmp} () VALUES ()`);
      const [d] = await conn.query<RowDataPacket[]>(`SELECT HEX(CONVERT(${col} USING utf8mb4)) AS h FROM ${tmp}`);
      columnDefault = decodeHex(d[0]?.h);
      if (columnDefault === null) return null;
    }
    return { members, columnDefault };
  } finally {
    await conn.query(`DROP TEMPORARY TABLE IF EXISTS ${tmp}`).catch(() => {});
  }
}

export function rewriteMembers(ddl: string, column: MemberColumn, truth: TrueMembers): string | null {
  const list = memberTokens(column.columnType);
  if (!list || list.tokens.length !== truth.members.length) return null;
  const fixed = list.tokens.map((t, i) => restoreToken(t, truth.members[i]!));
  if (fixed.some((f) => f === null)) return null;
  const anchor = `\n  ${quoteName(column.name)} ${column.columnType}`;
  const at = ddl.indexOf(anchor);
  if (at < 0 || ddl.indexOf(anchor, at + 1) >= 0) return null;
  const head = `${ddl.slice(0, at)}\n  ${quoteName(column.name)} ${list.prefix}${fixed.join(",")}${list.suffix}`;
  let rest = ddl.slice(at + anchor.length);
  if (column.columnDefault?.startsWith("'") && column.columnDefault.includes("?")) {
    if (truth.columnDefault === null) return null;
    const fixedDefault = restoreToken(column.columnDefault, truth.columnDefault);
    if (fixedDefault === null) return null;
    const lineEnd = rest.indexOf("\n");
    const line = lineEnd < 0 ? rest : rest.slice(0, lineEnd);
    const marker = ` DEFAULT ${column.columnDefault}`;
    const pos = line.indexOf(marker);
    if (pos < 0) return null;
    rest = `${rest.slice(0, pos)} DEFAULT ${fixedDefault}${rest.slice(pos + marker.length)}`;
  }
  return head + rest;
}
